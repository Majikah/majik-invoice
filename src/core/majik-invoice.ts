/**
 * @file majik-invoice.ts
 * @description MajikInvoice — the cryptographically secured invoice envelope.
 *
 * Wraps a GeneralInvoice with optional ML-KEM-768 encryption (MajikEnvelope)
 * and hybrid Ed25519 + ML-DSA-87 digital signatures (MajikSignature).
 *
 * Two modes:
 *   "signed-only"          — GeneralInvoice is plaintext, integrity-sealed
 *   "encrypted-and-signed" — GeneralInvoice is encrypted; only public summary
 */

import { GeneralInvoice } from "./general-invoice";
import type {
  GeneralInvoiceJSON,
  PaymentStatus,
  ProofOfPayment,
} from "./general-invoice";
import { MajikSignature } from "@majikah/majik-signature";
import type {
  ExpectedSigner,
  VerificationResult,
  SealInfo,
  SealVerificationResult,
} from "@majikah/majik-signature";
import {
  MajikEnvelope,
  type MajikRecipient,
  type MajikIdentity,
} from "@majikah/majik-envelope";
import type { MajikKey, MajikMessagePublicKey } from "@majikah/majik-key";

import { hash } from "@stablelib/sha256";
import {
  DashboardStats,
  DecryptedCache,
  EncryptedPayload,
  IntegrityBlock,
  MajikahInvoiceJSON,
  MajikInvoiceConstructorOptions,
  MajikInvoiceInput,
  MajikInvoiceJSON,
  MajikInvoiceMode,
  MajikInvoicePayload,
  MajikInvoiceStatus,
  MajikInvoiceValidationResult,
  MajikUserID,
  PublicInvoiceSummary,
  SignedOnlyPayload,
} from "./types";
import {
  MajikInvoiceEncryptionError,
  MajikInvoiceError,
  MajikInvoiceKeyError,
  MajikInvoiceSealError,
  MajikInvoiceSerializationError,
  MajikInvoiceSignatureError,
} from "./errors";
import { MJKI_HEADER_SIZE, MJKI_MAGIC, MJKI_VERSION } from "./binary";
import { MajikMoney } from "@thezelijah/majik-money";
import {
  buildCSVHeader,
  buildCSVRow,
  CSVColumn,
  CSVExportResult,
  CSVResolveContext,
  dedupeColumns,
  DEFAULT_CSV_COLUMNS,
} from "./csv-export";

// ── Batch / stats types ───────────────────────────────────────────────────

export interface BatchDecryptResult {
  success: boolean;
  decrypted: MajikInvoice[];
  errors: Array<{ invoiceId: string; reason: string }>;
}

export interface BatchLockResult {
  locked: number;
  skipped: number; // signed-only invoices
}

export interface OverdueMarkResult {
  marked: MajikInvoice[]; // updated invoice instances
  skipped: Array<{
    invoiceId: string;
    reason: "encrypted" | "not-overdue" | "wrong-status";
  }>;
}

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

const MAJIK_INVOICE_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// MajikInvoice
// ---------------------------------------------------------------------------

/**
 * Majik Invoice
 * ---
 * A cryptographically secured invoice.
 *
 * Wraps GeneralInvoice with optional ML-KEM-768 encryption and hybrid
 * Ed25519 + ML-DSA-87 digital signatures.
 *
 * @example — signed-only
 * ```ts
 * const invoice = await MajikInvoice.create({
 *   mode: "signed-only",
 *   signerKey: aliceKey,             // unlocked MajikKey
 *   issuer: { legalName: "Alice Corporation", tin: "123-456-789-000" },
 *   recipient: { legalName: "Bob Inc" },
 *   currency: "PHP",
 *   defaultTax: { taxType: "VAT", rate: 0.12 },
 *   lineItems: [{ description: "Design Services", quantity: 1, unitPrice: 50000 }],
 * });
 *
 * console.log(invoice.status);            // "sealed"
 * console.log(invoice.public.formattedTotal); // "₱56,000.00"
 * ```
 *
 * @example — encrypted-and-signed
 * ```ts
 * const invoice = await MajikInvoice.create({
 *   mode: "encrypted-and-signed",
 *   signerKey: aliceKey,
 *   recipientKeys: [bobKey],
 *   issuer: { legalName: "Alice Corporation" },
 *   recipient: { legalName: "Bob Inc" },
 *   currency: "PHP",
 *   lineItems: [{ description: "Confidential Services", quantity: 1, unitPrice: 100000 }],
 * });
 *
 * // Decrypt with Bob's key
 * const decrypted = await invoice.decrypt(bobKey);
 * console.log(decrypted.totals.grandTotal.format()); // "₱100,000.00"
 * ```
 */
export class MajikInvoice {
  // ── Identity ──────────────────────────────────────────────────────────────
  readonly id: string;
  readonly version: string;
  readonly mode: MajikInvoiceMode;

  // ── Cloud Routing & Ownership ─────────────────────────────────────────────
  readonly userId?: string;
  readonly accountId?: string;

  recipients?: MajikMessagePublicKey[];

  // ── Public summary — always plaintext ────────────────────────────────────
  readonly public: PublicInvoiceSummary;

  // ── Payload ───────────────────────────────────────────────────────────────
  readonly payload: MajikInvoicePayload;

  // ── Integrity ─────────────────────────────────────────────────────────────
  readonly integrity: IntegrityBlock;

  // ── Timestamps ────────────────────────────────────────────────────────────
  readonly createdAt: string;
  readonly updatedAt: string;

  // ── Runtime-only decrypted cache (NOT persisted) ──────────────────────────
  private _decrypted?: DecryptedCache;

  private constructor(opts: MajikInvoiceConstructorOptions) {
    this.version = MAJIK_INVOICE_SCHEMA_VERSION;
    this.id = opts.id;
    this.mode = opts.mode;
    this.userId = opts.userId;
    this.accountId = opts.accountId;
    this.public = opts.public;
    this.payload = opts.payload;
    this.integrity = opts.integrity;
    this.createdAt = opts.createdAt;
    this.updatedAt = opts.updatedAt;
    this._decrypted = opts.decrypted;
    this.recipients = opts.recipients;
  }

  private rebuild(
    overrides: Partial<MajikInvoiceConstructorOptions>,
  ): MajikInvoice {
    return new MajikInvoice({
      id: this.id,
      mode: this.mode,
      userId: this.userId,
      accountId: this.accountId,
      public: this.public,
      payload: this.payload,
      integrity: this.integrity,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      decrypted: this._decrypted,
      ...overrides,
    });
  }

  // ==========================================================================
  // ── STATIC FACTORY ─────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Create a MajikInvoice from a GeneralInvoiceInput.
   *
   * If signerKey is provided the invoice is signed immediately.
   * If mode is "encrypted-and-signed" and recipientKeys are provided,
   * encryption is applied before signing.
   *
   * @throws {MajikInvoiceError} on invalid input
   * @throws {MajikInvoiceKeyError} on locked or missing keys
   * @throws {MajikInvoiceEncryptionError} if encryption fails
   * @throws {MajikInvoiceSignatureError} if signing fails
   */
  static async create(input: MajikInvoiceInput): Promise<MajikInvoice> {
    MajikInvoice._assertValidInput(input);

    const mode: MajikInvoiceMode = input.mode ?? "signed-only";

    // ── 1. Build the base GeneralInvoice ────────────────────────────────────
    const {
      mode: _m,
      recipients,
      signerKey,
      expectedSigners,
      userId,
      accountId,
      ...generalInput
    } = input;
    const generalInvoice = GeneralInvoice.create(generalInput);

    // ── 2. Build public summary ─────────────────────────────────────────────
    const publicSummary = MajikInvoice._buildPublicSummary(generalInvoice);

    // ── 3. Canonical bytes for signing/hashing ──────────────────────────────
    const canonicalBytes = generalInvoice.toCanonicalBytes();
    const contentHash = MajikInvoice._sha256Hex(canonicalBytes);

    // ── 4. Build payload ────────────────────────────────────────────────────
    let payload: MajikInvoicePayload;

    if (mode === "encrypted-and-signed") {
      if (!recipients || recipients.length === 0) {
        throw new MajikInvoiceKeyError(
          "recipients are required when mode is 'encrypted-and-signed'.",
        );
      }

      payload = await MajikInvoice._buildEncryptedPayload(
        generalInvoice,
        recipients,
        input.signerKey,
      );
    } else {
      payload = {
        kind: "signed-only",
        invoice: generalInvoice.toJSON(),
      } satisfies SignedOnlyPayload;
    }

    // ── 5. Build integrity block ─────────────────────────────────────────────
    const now = new Date().toISOString();
    const integrity: IntegrityBlock = {
      contentHash,
      hashAlgorithm: "SHA-256",
      signatures: [],
      isSealed: false,
    };

    const instance = new MajikInvoice({
      id: generalInvoice.id,
      mode,
      userId,
      accountId,
      public: publicSummary,
      payload,
      integrity,
      createdAt: now,
      updatedAt: now,
    });

    // ── 6. Sign immediately if signerKey provided ────────────────────────────
    if (signerKey) {
      return instance.sign(
        signerKey,
        expectedSigners ? { expectedSigners } : undefined,
      );
    }

    return instance;
  }

  // ==========================================================================
  // ── METADATA & SETTLEMENT MUTATIONS ───────────────────────────────────────
  // ==========================================================================

  withUserId(userId: string): MajikInvoice {
    if (!userId?.trim()) {
      throw new MajikInvoiceError("userId cannot be empty.");
    }
    return this.rebuild({ userId: userId.trim() });
  }

  withAccountId(accountId: string): MajikInvoice {
    if (!accountId?.trim()) {
      throw new MajikInvoiceError("accountId cannot be empty.");
    }
    return this.rebuild({ accountId: accountId.trim() });
  }

  addPayment(proof: ProofOfPayment): MajikInvoice {
    const invoice = this._requirePlaintextInvoice("addPayment");

    const updated = invoice.addPayment(proof);

    return this._reissueFromMutation(updated);
  }

  removePayment(paymentId: string): MajikInvoice {
    const invoice = this._requirePlaintextInvoice("removePayment");

    const updated = invoice.removePayment(paymentId);

    return this._reissueFromMutation(updated);
  }

  clearPayments(): MajikInvoice {
    const invoice = this._requirePlaintextInvoice("clearPayments");

    const updated = invoice.clearPayments();

    return this._reissueFromMutation(updated);
  }

  // ==========================================================================
  // ── GETTERS ─────────────────────────────────────────────────────────────────
  // ==========================================================================

  get totalPaid(): MajikMoney | null {
    if (this.mode === "encrypted-and-signed") {
      const decryptedInvoice = this._decrypted?.invoice;
      if (!decryptedInvoice) {
        console.warn(
          "Invoice payload is encrypted. Call decrypt(key) first to access the full GeneralInvoice.",
        );
        return null;
      }
    }

    return this.invoice.totalPaid;
  }

  get isFullyPaid(): boolean | null {
    if (this.mode === "encrypted-and-signed") {
      const decryptedInvoice = this._decrypted?.invoice;
      if (!decryptedInvoice) {
        console.warn(
          "Invoice payload is encrypted. Call decrypt(key) first to access the full GeneralInvoice.",
        );
        return null;
      }
    }

    return this.invoice.isFullyPaid;
  }

  get paymentStatus(): PaymentStatus | null {
    if (this.mode === "encrypted-and-signed") {
      const decryptedInvoice = this._decrypted?.invoice;
      if (!decryptedInvoice) {
        console.warn(
          "Invoice payload is encrypted. Call decrypt(key) first to access the full GeneralInvoice.",
        );
        return null;
      }
    }

    return this.invoice.paymentStatus;
  }

  get payments(): ProofOfPayment[] | null {
    if (this.mode === "encrypted-and-signed") {
      const decryptedInvoice = this._decrypted?.invoice;
      if (!decryptedInvoice) {
        console.warn(
          "Invoice payload is encrypted. Call decrypt(key) first to access the full GeneralInvoice.",
        );
        return null;
      }
    }

    return [...this.invoice.proofOfPayments];
  }

  get issueDate(): Date {
    const parsedDate: Date = new Date(this.public.issuedAt);
    return parsedDate;
  }

  get dueDate(): Date | null {
    if (!this.public.dueDate?.trim()) {
      return null;
    }
    const parsedDate: Date = new Date(this.public.dueDate);
    return parsedDate;
  }

  // ==========================================================================
  // ── MODE CONVERSION ────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Convert a signed-only MajikInvoice to an encrypted-and-signed one.
   * Returns a NEW MajikInvoice. The original is untouched.
   * The new instance carries no signatures — re-sign after conversion.
   *
   * @throws {MajikInvoiceError} if already encrypted
   * @throws {MajikInvoiceKeyError} if recipientKeys are locked or missing
   */
  async toEncrypted(
    recipients: MajikRecipient[],
    signerKey?: MajikKey,
  ): Promise<MajikInvoice> {
    if (this.mode === "encrypted-and-signed") {
      throw new MajikInvoiceError(
        "Invoice is already in 'encrypted-and-signed' mode.",
      );
    }

    const generalInvoice = this._requirePlaintextInvoice("toEncrypted");
    const payload = await MajikInvoice._buildEncryptedPayload(
      generalInvoice,
      recipients,
      signerKey,
    );

    const now = new Date().toISOString();
    const integrity: IntegrityBlock = {
      contentHash: this.integrity.contentHash,
      hashAlgorithm: "SHA-256",
      signatures: [],
      isSealed: false,
      expectedSigners: this.integrity.expectedSigners,
      allowlistSignerId: this.integrity.allowlistSignerId,
    };

    const converted = new MajikInvoice({
      id: this.id,
      mode: "encrypted-and-signed",
      public: this.public,
      payload,
      integrity,
      createdAt: this.createdAt,
      updatedAt: now,
    });

    if (signerKey) {
      return converted.sign(signerKey);
    }
    return converted;
  }

  /**
   * Convert an encrypted-and-signed MajikInvoice to a signed-only (plaintext) one.
   * The decrypting key must be provided to access the inner GeneralInvoice.
   * Returns a NEW MajikInvoice. The original is untouched.
   * Signatures are cleared — re-sign after conversion.
   *
   * @throws {MajikInvoiceError} if already signed-only
   * @throws {MajikInvoiceKeyError} if decryptKey is locked
   * @throws {MajikInvoiceEncryptionError} if decryption fails
   */
  async toSignedOnly(
    decryptKey: MajikKey,
    signerKey?: MajikKey,
  ): Promise<MajikInvoice> {
    if (this.mode === "signed-only") {
      throw new MajikInvoiceError("Invoice is already in 'signed-only' mode.");
    }

    const generalInvoice = await this.decrypt(decryptKey);
    const canonicalBytes = generalInvoice.toCanonicalBytes();
    const contentHash = MajikInvoice._sha256Hex(canonicalBytes);

    const now = new Date().toISOString();
    const payload: SignedOnlyPayload = {
      kind: "signed-only",
      invoice: generalInvoice.toJSON(),
    };

    const integrity: IntegrityBlock = {
      contentHash: this.integrity.contentHash,
      hashAlgorithm: "SHA-256",
      signatures: [],
      isSealed: false,
      expectedSigners: this.integrity.expectedSigners,
      allowlistSignerId: this.integrity.allowlistSignerId,
    };

    const converted = new MajikInvoice({
      id: this.id,
      mode: "signed-only",
      public: this.public,
      payload,
      integrity,
      createdAt: this.createdAt,
      updatedAt: now,
    });

    this.secureLock();

    if (signerKey) {
      return converted.sign(signerKey);
    }
    return converted;
  }

  // ==========================================================================
  // ── GETTERS ─────────────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Runtime posture of this invoice.
   *
   * "sealed"          — sealed and signed  (encrypted or plaintext)
   * "fully-signed"    — all expected signers have signed; not yet sealed
   * "partially-signed"— at least one signature but allowlist not fully satisfied
   * "unsigned"        — invoice created but no signatures attached yet
   * "invalid"         — structural or cryptographic verification failed
   */
  get status(): MajikInvoiceStatus {
    try {
      const structValid = this._validateStructure();
      if (!structValid.valid) return "invalid";
    } catch {
      return "invalid";
    }

    if (this.integrity.signatures.length === 0) {
      return "unsigned";
    }

    if (this.integrity.isSealed) {
      return "sealed";
    }

    if (this.isFullySigned) {
      return "fully-signed";
    }

    return "partially-signed";
  }

  get displayStatus(): string {
    if (this.status === "invalid") return "Invalid";
    if (this.status === "unsigned") return "Unsigned";

    if (this.status === "partially-signed") {
      return this.isEncrypted
        ? "Partially Signed (Encrypted)"
        : "Partially Signed";
    }

    if (this.status === "fully-signed") {
      return this.isEncrypted ? "Fully Signed (Encrypted)" : "Fully Signed";
    }

    if (this.status === "sealed") {
      return this.isEncrypted ? "Sealed (Encrypted)" : "Sealed";
    }

    return "Unknown";
  }

  /**
   *Returns `true` if the mode is `encrypted-and-signed`
   */
  get isEncrypted(): boolean {
    return this.mode === "encrypted-and-signed";
  }

  /**
   *Returns `true` if the mode is `signed-only`
   */
  get isSignedOnly(): boolean {
    return this.mode === "signed-only";
  }

  /**
   * Returns `true` if the invoice is encrypted-and-signed and currently not unlocked or decrypted.
   * Defaults to `false` if the invoice is signed-only
   */
  get isLocked(): boolean {
    if (this.isSignedOnly) return false;

    return !this.decryptedInvoice || !this.decryptedCache;
  }

  get isSigned(): boolean {
    return this.integrity.signatures.length > 0;
  }

  get isSealed(): boolean {
    return this.integrity.isSealed;
  }

  get signatureCount(): number {
    return this.integrity.signatures.length;
  }

  get signerIds(): string[] {
    return this.integrity.signatures.map((s) => s.signerId);
  }

  get hasDecryptedCache(): boolean {
    return this._decrypted !== undefined;
  }

  /** The cached decrypted GeneralInvoice, if decryption has run this session. */
  get decryptedInvoice(): GeneralInvoice | undefined {
    return this._decrypted?.invoice;
  }

  /** Decrypted cache metadata (who decrypted, when). */
  get decryptedCache(): DecryptedCache | undefined {
    return this._decrypted;
  }

  /**
   * Access the plaintext GeneralInvoice directly.
   * Only available in "signed-only" mode or after decrypt() has been called.
   *
   * @throws {MajikInvoiceError} if invoice is encrypted and not yet decrypted
   */
  get invoice(): GeneralInvoice {
    if (this.mode === "signed-only") {
      return GeneralInvoice.fromJSON(
        (this.payload as SignedOnlyPayload).invoice,
      );
    }
    if (this._decrypted) {
      return this._decrypted.invoice;
    }
    throw new MajikInvoiceError(
      "Invoice payload is encrypted. Call decrypt(key) first to access the full GeneralInvoice.",
    );
  }

  get summary(): PublicInvoiceSummary {
    return this.public;
  }

  /**
   * Issue a new MajikInvoice from a modified GeneralInvoice.
   * All existing signatures are dropped — the caller must re-sign.
   * Mode, createdAt, and (if encrypted) recipient fingerprints are preserved.
   *
   * @throws {MajikInvoiceKeyError} if mode is "encrypted-and-signed" and no recipientKeys provided
   * @throws {MajikInvoiceKeyError} if signerKey is locked or missing signing keys
   * @throws {MajikInvoiceEncryptionError} if re-encryption fails
   */
  async reissue(
    updatedInvoice: GeneralInvoice,
    options: {
      signerKey?: MajikKey;
      recipients?: MajikRecipient[];
      expectedSigners?: ExpectedSigner[];
    } = {},
  ): Promise<MajikInvoice> {
    if (this.mode === "encrypted-and-signed") {
      if (!options.recipients || options.recipients.length === 0) {
        throw new MajikInvoiceKeyError(
          "recipients are required to reissue an encrypted-and-signed invoice.",
        );
      }
    }

    if (options.signerKey) {
      MajikInvoice._assertKeyUnlocked(options.signerKey, "reissue");
      MajikInvoice._assertKeyHasSigningKeys(options.signerKey, "reissue");
    }

    let reissued: MajikInvoice;

    if (this.mode === "encrypted-and-signed") {
      // Encrypted path — must rebuild payload manually since _reissueFromMutation
      // cannot handle re-encryption without recipients context.
      const publicSummary = MajikInvoice._buildPublicSummary(updatedInvoice);
      const contentHash = MajikInvoice._sha256Hex(
        updatedInvoice.toCanonicalBytes(),
      );
      const payload = await MajikInvoice._buildEncryptedPayload(
        updatedInvoice,
        options.recipients!,
      );
      const integrity: IntegrityBlock = {
        contentHash,
        hashAlgorithm: "SHA-256",
        signatures: [],
        isSealed: false,
        expectedSigners: this.integrity.expectedSigners,
        allowlistSignerId: this.integrity.allowlistSignerId,
      };
      reissued = new MajikInvoice({
        id: updatedInvoice.id,
        mode: this.mode,
        public: publicSummary,
        payload,
        integrity,
        createdAt: this.createdAt,
        updatedAt: new Date().toISOString(),
      });
    } else {
      // Signed-only path — delegate to _reissueFromMutation with hash recompute.
      reissued = this._reissueFromMutation(updatedInvoice, {
        recomputeHash: true,
      });
    }

    if (options.signerKey) {
      return reissued.sign(
        options.signerKey,
        options.expectedSigners
          ? { expectedSigners: options.expectedSigners }
          : undefined,
      );
    }

    return reissued;
  }

  // ==========================================================================
  // ── MODE SETTING ───────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Set the mode of this invoice, returning a NEW MajikInvoice.
   * The original is untouched. All existing signatures are cleared — re-sign
   * after conversion.
   *
   * - "signed-only"          → requires decryptKey if currently encrypted
   * - "encrypted-and-signed" → requires recipientKeys
   *
   * Optionally re-sign immediately by providing signerKey.
   *
   * @throws {MajikInvoiceError}          if the target mode is already active
   * @throws {MajikInvoiceKeyError}       if required keys are missing or locked
   * @throws {MajikInvoiceEncryptionError} if decryption or encryption fails
   */
  async setMode(
    targetMode: MajikInvoiceMode,
    options: {
      /** Required when converting TO "encrypted-and-signed" */
      recipients?: MajikRecipient[];
      /** Required when converting FROM "encrypted-and-signed" */
      decryptKey?: MajikKey;
      /** Optional — re-signs the converted invoice immediately */
      signerKey?: MajikKey;
      expectedSigners?: ExpectedSigner[];
    } = {},
  ): Promise<MajikInvoice> {
    if (this.mode === targetMode) {
      throw new MajikInvoiceError(
        `Invoice is already in "${targetMode}" mode.`,
      );
    }

    if (targetMode === "encrypted-and-signed") {
      if (!options.recipients || options.recipients.length === 0) {
        throw new MajikInvoiceKeyError(
          `recipients are required when converting to "encrypted-and-signed" mode.`,
        );
      }
      return this.toEncrypted(options.recipients, options.signerKey);
    }

    // targetMode === "signed-only"
    if (this.mode === "encrypted-and-signed") {
      if (!options.decryptKey) {
        throw new MajikInvoiceKeyError(
          `decryptKey is required when converting from "encrypted-and-signed" to "signed-only".`,
        );
      }
      return this.toSignedOnly(options.decryptKey, options.signerKey);
    }

    // Unreachable given the two-value union, but keeps TS happy
    throw new MajikInvoiceError(`Unrecognised target mode "${targetMode}".`);
  }

  // ── Quick-access wrappers ─────────────────────────────────────────────────

  /**
   * Convert to "encrypted-and-signed" mode.
   * Thin wrapper over {@link setMode}.
   *
   * @throws {MajikInvoiceError}           if already encrypted
   * @throws {MajikInvoiceKeyError}        if recipientKeys are missing or locked
   * @throws {MajikInvoiceEncryptionError} if encryption fails
   */
  async encrypt(
    recipients: MajikRecipient[],
    signerKey?: MajikKey,
  ): Promise<MajikInvoice> {
    return this.setMode("encrypted-and-signed", { recipients, signerKey });
  }

  /**
   * Convert to "signed-only" (plaintext) mode.
   * Thin wrapper over {@link setMode}.
   *
   * @throws {MajikInvoiceError}           if already signed-only
   * @throws {MajikInvoiceKeyError}        if decryptKey is missing or locked
   * @throws {MajikInvoiceEncryptionError} if decryption fails
   */
  async decrypt_mode(
    decryptKey: MajikKey,
    signerKey?: MajikKey,
  ): Promise<MajikInvoice> {
    return this.setMode("signed-only", { decryptKey, signerKey });
  }

  // ==========================================================================
  // ── ENCRYPTION & DECRYPTION ────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Decrypt an encrypted invoice using the recipient's MajikKey.
   * Result is cached on the instance for subsequent `.invoice` access.
   * Returns the decrypted GeneralInvoice.
   *
   * @throws {MajikInvoiceError} if invoice is not encrypted
   * @throws {MajikInvoiceKeyError} if key is locked or has no ML-KEM secret key
   * @throws {MajikInvoiceEncryptionError} if decryption fails (wrong key or corrupted data)
   */
  async decrypt(key: MajikKey): Promise<GeneralInvoice> {
    if (this.mode === "signed-only") {
      throw new MajikInvoiceError(
        "Invoice is not encrypted (mode: 'signed-only'). Access .invoice directly.",
      );
    }

    // Return cached result if the same key decrypted this session
    if (this._decrypted && this._decrypted.decryptedBy === key.fingerprint) {
      return this._decrypted.invoice;
    }

    MajikInvoice._assertKeyUnlocked(key, "decrypt");
    MajikInvoice._assertKeyHasMlKem(key, "decrypt");

    const ep = this.payload as EncryptedPayload;

    try {
      const envelope = MajikEnvelope.fromScannerString(ep.envelopeString);

      const identity: MajikIdentity = {
        fingerprint: key.fingerprint,
        mlKemSecretKey: key.getMlKemSecretKey(),
      };

      const plaintext = await envelope.decrypt(identity);
      const generalInvoiceJSON: GeneralInvoiceJSON = JSON.parse(plaintext);
      const generalInvoice = GeneralInvoice.fromJSON(generalInvoiceJSON);

      // Cache the result
      this._decrypted = {
        invoice: generalInvoice,
        decryptedAt: new Date().toISOString(),
        decryptedBy: key.fingerprint,
      };

      return generalInvoice;
    } catch (err) {
      if (err instanceof MajikInvoiceError) throw err;
      throw new MajikInvoiceEncryptionError(
        "Decryption failed — wrong key, corrupted envelope, or key is not a recipient.",
        err,
      );
    }
  }

  /**
   * Clear the decrypted cache.
   * After calling this, .invoice will throw again until decrypt() is called.
   */
  clearDecryptedCache(): void {
    this._decrypted = undefined;
  }

  /**
   * Check whether a given MajikKey can decrypt this invoice.
   *
   * For single-recipient envelopes: checks if the key's fingerprint matches.
   * For group envelopes: checks if the fingerprint is in the recipient list.
   * Does not attempt actual decryption — fingerprint check only.
   */
  canDecrypt(key: MajikKey): boolean {
    if (this.mode === "signed-only") return false;
    const ep = this.payload as EncryptedPayload;
    return ep.recipientFingerprints.includes(key.fingerprint);
  }

  // ==========================================================================
  // ── SIGNING ────────────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Sign this invoice with the provided MajikKey.
   * Returns a NEW MajikInvoice with the signature appended.
   * The original is untouched.
   *
   * If this is the first signature and expectedSigners are provided,
   * an allowlist is established and the signer becomes the issuer.
   *
   * Re-signing with the same key overwrites that signer's existing entry.
   *
   * @throws {MajikInvoiceKeyError} if key is locked or has no signing keys
   * @throws {MajikInvoiceSealError} if the invoice is sealed
   * @throws {MajikInvoiceSignatureError} if signing fails
   */
  async sign(
    key: MajikKey,
    options?: {
      expectedSigners?: ExpectedSigner[];
      timestamp?: string;
    },
  ): Promise<MajikInvoice> {
    MajikInvoice._assertKeyUnlocked(key, "sign");
    MajikInvoice._assertKeyHasSigningKeys(key, "sign");

    if (this.integrity.isSealed) {
      throw new MajikInvoiceSealError(
        "Cannot sign a sealed invoice. Sealed invoices are immutable.",
      );
    }

    // Allowlist check — if an allowlist exists, verify this key is on it
    if (
      this.integrity.expectedSigners &&
      this.integrity.expectedSigners.length > 0
    ) {
      const isAllowed = this.integrity.expectedSigners.some(
        (es) => es.signerId === key.fingerprint,
      );
      if (!isAllowed) {
        throw new MajikInvoiceSignatureError(
          `Key "${key.fingerprint}" is not on the allowlist for this invoice. ` +
            `Only the following signers may sign: [${this.integrity.expectedSigners.map((s) => s.signerId).join(", ")}].`,
        );
      }
    }

    // Compute canonical content for signing
    const contentBytes = await MajikInvoice._canonicalBytesForSigning(
      this.integrity.contentHash,
      this.id,
    );

    // Compute allowlist hash if expectedSigners are being set now.
    // MajikSignatureJSON.allowlistHash is base64 (SHA-256 of canonical allowlist JSON).
    let allowlistHash: string | undefined;
    const signers = options?.expectedSigners ?? this.integrity.expectedSigners;
    if (signers && signers.length > 0) {
      const canonicalAllowlist = JSON.stringify(
        [...signers].sort((a, b) => a.signerId.localeCompare(b.signerId)),
      );
      const allowlistBytes = new TextEncoder().encode(canonicalAllowlist);
      const hashBuffer = await crypto.subtle.digest("SHA-256", allowlistBytes);
      // Encode as base64 to match MajikSignatureJSON.allowlistHash type (base64, 44 chars)
      const hashArray = new Uint8Array(hashBuffer);
      let binary = "";
      for (let i = 0; i < hashArray.length; i++)
        binary += String.fromCharCode(hashArray[i]);
      allowlistHash = btoa(binary);
    }

    try {
      const sig = await MajikSignature.sign(contentBytes, key, {
        contentType: "majik-invoice",
        timestamp: options?.timestamp,
        allowlistHash,
      });

      // Replace existing signature from same signer, or append
      const existingIdx = this.integrity.signatures.findIndex(
        (s) => s.signerId === key.fingerprint,
      );
      const newSignatures = [...this.integrity.signatures];
      if (existingIdx >= 0) {
        newSignatures[existingIdx] = sig.toJSON();
      } else {
        newSignatures.push(sig.toJSON());
      }

      const newIntegrity: IntegrityBlock = {
        ...this.integrity,
        signatures: newSignatures,
        isSealed: false,
        ...(signers && signers.length > 0
          ? {
              expectedSigners: signers,
              allowlistSignerId:
                this.integrity.allowlistSignerId ?? key.fingerprint,
            }
          : {}),
      };

      return this.rebuild({ integrity: newIntegrity });
    } catch (err) {
      if (err instanceof MajikInvoiceError) throw err;
      throw new MajikInvoiceSignatureError(
        "Failed to sign invoice — check key has signing keys and is unlocked.",
        err,
      );
    }
  }

  /**
   * Seal this invoice, preventing any further signatures.
   * Only the issuer (allowlistSignerId) may seal.
   * If no allowlist is set, any current signer may seal.
   * Returns a NEW MajikInvoice. The original is untouched.
   *
   * @throws {MajikInvoiceKeyError} if key is locked
   * @throws {MajikInvoiceSealError} if already sealed or key is not the issuer
   * @throws {MajikInvoiceSignatureError} if no signatures exist to seal
   */
  async seal(
    key: MajikKey,
    options?: { timestamp?: string },
  ): Promise<MajikInvoice> {
    MajikInvoice._assertKeyUnlocked(key, "seal");

    if (this.integrity.isSealed) {
      throw new MajikInvoiceSealError("Invoice is already sealed.");
    }

    if (this.integrity.signatures.length === 0) {
      throw new MajikInvoiceSignatureError(
        "Cannot seal an unsigned invoice. At least one signature is required.",
      );
    }

    // If an allowlist issuer exists, only they can seal
    if (
      this.integrity.allowlistSignerId &&
      this.integrity.allowlistSignerId !== key.fingerprint
    ) {
      throw new MajikInvoiceSealError(
        `Only the issuer ("${this.integrity.allowlistSignerId}") may seal this invoice. ` +
          `Provided key fingerprint: "${key.fingerprint}".`,
      );
    }

    // If no allowlist issuer, key must be among the existing signers
    if (
      !this.integrity.allowlistSignerId &&
      !this.integrity.signatures.some((s) => s.signerId === key.fingerprint)
    ) {
      throw new MajikInvoiceSealError(
        `Key "${key.fingerprint}" has not signed this invoice and cannot seal it.`,
      );
    }

    const sealTimestamp = options?.timestamp ?? new Date().toISOString();
    const signerIds = this.integrity.signatures.map((s) => s.signerId);

    // Compute the seal hash.
    // MajikInvoice manages its own seal independent of MajikSignatureEmbed —
    // we use SHA-256 via WebCrypto (universally available in both browser and
    // Node/Workers). MajikSignatureEmbed uses SHA3-512 for file-level seals,
    // but that algorithm is not in the WebCrypto standard and would require
    // an external library here. The seal input covers all signerIds + the
    // timestamp, so tampering with either breaks the hash.
    const sealInput = JSON.stringify({
      signerIds: signerIds.sort(),
      sealTimestamp,
    });
    const sealHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sealInput),
    );
    const sealHash = Array.from(new Uint8Array(sealHashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // SealInfo shape matches @majikah/majik-signature — three fields only.
    const sealInfo: SealInfo = {
      sealedBy: key.fingerprint,
      sealTimestamp,
      sealHash,
    };

    const newIntegrity: IntegrityBlock = {
      ...this.integrity,
      isSealed: true,
      sealInfo,
    };

    return this.rebuild({ integrity: newIntegrity });
  }

  // ==========================================================================
  // ── SIGNATURE VERIFICATION ─────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Verify all attached signatures.
   * Returns one VerificationResult per signature.
   *
   * @throws {MajikInvoiceSignatureError} if no signatures exist
   */
  async verifySignatures(): Promise<VerificationResult[]> {
    if (this.integrity.signatures.length === 0) {
      throw new MajikInvoiceSignatureError(
        "No signatures to verify on this invoice.",
      );
    }

    const contentBytes = await MajikInvoice._canonicalBytesForSigning(
      this.integrity.contentHash,
      this.id,
    );

    const results: VerificationResult[] = [];

    for (const sigJSON of this.integrity.signatures) {
      try {
        const sig = MajikSignature.fromJSON(sigJSON);
        const publicKeys = sig.extractPublicKeys();
        const result = MajikSignature.verify(contentBytes, sig, publicKeys);
        results.push(result);
      } catch (err) {
        results.push({
          valid: false,
          signerId: sigJSON.signerId,
          contentHash: sigJSON.contentHash,
          // timestamp is non-optional on VerificationResult — use the envelope's value
          timestamp: sigJSON.timestamp,
          reason: `Verification threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return results;
  }

  /**
   * Verify the signature of a specific signer.
   *
   * @throws {MajikInvoiceSignatureError} if no signature from that signer exists
   */
  async verifySignature(signerId: string): Promise<VerificationResult> {
    const sigJSON = this.integrity.signatures.find(
      (s) => s.signerId === signerId,
    );
    if (!sigJSON) {
      throw new MajikInvoiceSignatureError(
        `No signature from signer "${signerId}" found on this invoice.`,
      );
    }

    const contentBytes = await MajikInvoice._canonicalBytesForSigning(
      this.integrity.contentHash,
      this.id,
    );

    try {
      const sig = MajikSignature.fromJSON(sigJSON);
      const publicKeys = sig.extractPublicKeys();
      return MajikSignature.verify(contentBytes, sig, publicKeys);
    } catch (err) {
      if (err instanceof MajikInvoiceError) throw err;
      throw new MajikInvoiceSignatureError(
        `Failed to verify signature from "${signerId}".`,
        err,
      );
    }
  }

  /**
   * Verify the seal hash without verifying individual signatures.
   * Returns invalid if the invoice is not sealed.
   */
  async verifySeal(): Promise<SealVerificationResult> {
    if (!this.integrity.isSealed || !this.integrity.sealInfo) {
      return {
        valid: false,
        reason: "Invoice is not sealed.",
      } as SealVerificationResult;
    }

    const info = this.integrity.sealInfo;
    const signerIds = this.integrity.signatures.map((s) => s.signerId);

    const sealInput = JSON.stringify({
      signerIds: signerIds.sort(),
      sealTimestamp: info.sealTimestamp,
    });
    const sealHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sealInput),
    );
    const recomputedHash = Array.from(new Uint8Array(sealHashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (recomputedHash !== info.sealHash) {
      return {
        valid: false,
        reason: "Seal hash mismatch — envelope may have been tampered with.",
      } as SealVerificationResult;
    }

    return {
      valid: true,
      sealedBy: info.sealedBy,
      sealTimestamp: info.sealTimestamp,
    } as SealVerificationResult;
  }

  // ==========================================================================
  // ── CAPABILITY CHECKS ──────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Check whether a key is permitted to sign this invoice.
   * Accounts for seal status, allowlist membership, and key capability.
   */
  canSign(key: MajikKey): { permitted: boolean; reason?: string } {
    if (this.integrity.isSealed) {
      return {
        permitted: false,
        reason: "Invoice is sealed — no further signatures allowed.",
      };
    }
    if (!key.hasSigningKeys) {
      return {
        permitted: false,
        reason:
          "Key has no signing keys. Re-import via importFromMnemonicBackup().",
      };
    }
    if (key.isLocked) {
      return {
        permitted: false,
        reason: "Key is locked. Call key.unlock() first.",
      };
    }
    if (
      this.integrity.expectedSigners &&
      this.integrity.expectedSigners.length > 0
    ) {
      const allowed = this.integrity.expectedSigners.some(
        (es) => es.signerId === key.fingerprint,
      );
      if (!allowed) {
        return {
          permitted: false,
          reason: `Key "${key.fingerprint}" is not on the allowlist for this invoice.`,
        };
      }
    }
    return { permitted: true };
  }

  /**
   * Check whether a key is permitted to seal this invoice.
   */
  canSeal(key: MajikKey): { permitted: boolean; reason?: string } {
    if (this.integrity.isSealed) {
      return { permitted: false, reason: "Invoice is already sealed." };
    }
    if (this.integrity.signatures.length === 0) {
      return { permitted: false, reason: "Invoice has no signatures to seal." };
    }
    if (key.isLocked) {
      return {
        permitted: false,
        reason: "Key is locked. Call key.unlock() first.",
      };
    }
    if (
      this.integrity.allowlistSignerId &&
      this.integrity.allowlistSignerId !== key.fingerprint
    ) {
      return {
        permitted: false,
        reason: `Only the issuer ("${this.integrity.allowlistSignerId}") may seal this invoice.`,
      };
    }
    if (
      !this.integrity.allowlistSignerId &&
      !this.integrity.signatures.some((s) => s.signerId === key.fingerprint)
    ) {
      return {
        permitted: false,
        reason: `Key "${key.fingerprint}" has not signed this invoice and cannot seal it.`,
      };
    }
    return { permitted: true };
  }

  /**
   * Check whether a key has already signed this invoice.
   */
  hasSigned(key: MajikKey): boolean {
    return this.integrity.signatures.some(
      (s) => s.signerId === key.fingerprint,
    );
  }

  /**
   * Returns the list of expected signers who have not yet signed.
   * Returns an empty array if no allowlist is set or all have signed.
   */
  get pendingSigners(): ExpectedSigner[] {
    if (!this.integrity.expectedSigners) return [];
    return this.integrity.expectedSigners.filter(
      (es) =>
        !this.integrity.signatures.some((s) => s.signerId === es.signerId),
    );
  }

  /**
   * Whether all expected signers have signed (true even if no allowlist is set).
   */
  get isFullySigned(): boolean {
    if (
      !this.integrity.expectedSigners ||
      this.integrity.expectedSigners.length === 0
    ) {
      return this.integrity.signatures.length > 0;
    }
    return this.pendingSigners.length === 0;
  }

  // ==========================================================================
  // ── VALIDATION ─────────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Validate the structural integrity of this MajikInvoice.
   * Does NOT verify cryptographic signatures — call verifySignatures() for that.
   */
  validate(): MajikInvoiceValidationResult {
    return this._validateStructure();
  }

  private _validateStructure(): MajikInvoiceValidationResult {
    const errors: Array<{ field: string; message: string }> = [];

    if (!this.id || this.id.trim().length === 0) {
      errors.push({ field: "id", message: "Invoice id is required" });
    }

    if (!["signed-only", "encrypted-and-signed"].includes(this.mode)) {
      errors.push({ field: "mode", message: `Invalid mode: "${this.mode}"` });
    }

    if (!this.public.issuerName?.trim()) {
      errors.push({
        field: "public.issuerName",
        message: "Issuer name is required in public summary",
      });
    }
    if (!this.public.recipientName?.trim()) {
      errors.push({
        field: "public.recipientName",
        message: "Recipient name is required in public summary",
      });
    }
    if (!this.public.currency?.trim()) {
      errors.push({
        field: "public.currency",
        message: "Currency is required in public summary",
      });
    }
    if (
      typeof this.public.totalAmount !== "number" ||
      !isFinite(this.public.totalAmount)
    ) {
      errors.push({
        field: "public.totalAmount",
        message: "Total amount must be a finite number",
      });
    }

    if (!this.payload) {
      errors.push({ field: "payload", message: "Payload is required" });
    } else if (this.payload.kind === "signed-only") {
      if (!this.payload.invoice) {
        errors.push({
          field: "payload.invoice",
          message: "Invoice JSON is required for signed-only mode",
        });
      }
    } else if (this.payload.kind === "encrypted-and-signed") {
      if (!this.payload.envelopeString) {
        errors.push({
          field: "payload.envelopeString",
          message: "Envelope string is required for encrypted mode",
        });
      }
      if (
        !this.payload.recipientFingerprints ||
        this.payload.recipientFingerprints.length === 0
      ) {
        errors.push({
          field: "payload.recipientFingerprints",
          message: "At least one recipient fingerprint is required",
        });
      }
    }

    if (!this.integrity.contentHash?.trim()) {
      errors.push({
        field: "integrity.contentHash",
        message: "Content hash is required",
      });
    }
    if (this.integrity.hashAlgorithm !== "SHA-256") {
      errors.push({
        field: "integrity.hashAlgorithm",
        message: "Only SHA-256 is supported",
      });
    }

    if (this.integrity.isSealed && !this.integrity.sealInfo) {
      errors.push({
        field: "integrity.sealInfo",
        message: "Seal info is required when isSealed is true",
      });
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Securely clears runtime-sensitive decrypted state from memory.
   *
   * - Only affects in-memory cache
   * - Does NOT modify payload, signatures, or integrity
   * - No-op for signed-only invoices
   */
  secureLock(): this {
    if (this.mode === "encrypted-and-signed") {
      this._decrypted = undefined;
    }

    return this;
  }

  // ==========================================================================
  // ── Batch Operations ──────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Decrypt an array of MajikInvoice instances concurrently.
   * Signed-only invoices are passed through unchanged (they need no decryption).
   * Encrypted invoices that cannot be decrypted with the provided key are
   * collected in the errors array and excluded from `decrypted`.
   *
   * @param invoices  - Array of MajikInvoice to process
   * @param key       - An unlocked MajikKey authorised to decrypt the invoices
   * @returns BatchDecryptResult
   */
  static async batchDecrypt(
    invoices: MajikInvoice[],
    key: MajikKey,
  ): Promise<BatchDecryptResult> {
    const errors: BatchDecryptResult["errors"] = [];

    const results = await Promise.allSettled(
      invoices.map(async (inv) => {
        // Signed-only: nothing to decrypt, pass through
        if (inv.mode === "signed-only") return inv;

        // Already decrypted this session — skip redundant work
        if (inv.hasDecryptedCache) return inv;

        // Authorisation pre-check — avoids expensive crypto on wrong key
        if (!inv.canDecrypt(key)) {
          throw new Error(
            `Key "${key.fingerprint}" is not a recipient of this invoice.`,
          );
        }

        // Decrypt — caches result on the instance
        await inv.decrypt(key);
        return inv;
      }),
    );

    const decrypted: MajikInvoice[] = [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        decrypted.push(result.value);
      } else {
        errors.push({
          invoiceId: invoices[i].id,
          reason:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    });

    return {
      success: errors.length === 0,
      decrypted,
      errors,
    };
  }

  /**
   * Clears the in-memory decrypted cache from all encrypted invoices.
   * Signed-only invoices are skipped (nothing to lock).
   *
   * Call this after you're done with a batch to minimise plaintext in memory.
   *
   * @param invoices - Array of MajikInvoice to lock
   * @returns BatchLockResult with counts of locked vs skipped
   */
  static batchLock(invoices: MajikInvoice[]): BatchLockResult {
    let locked = 0;
    let skipped = 0;

    for (const inv of invoices) {
      if (inv.mode === "signed-only") {
        skipped++;
        continue;
      }
      inv.secureLock();
      locked++;
    }

    return { locked, skipped };
  }

  /**
   * Scans an array of MajikInvoice and marks any whose due date has passed
   * and whose current status allows an "overdue" transition.
   *
   * For each candidate:
   *   - If signed-only, or already decrypted: process directly.
   *   - If encrypted and decryptKey is provided: attempt decrypt first.
   *   - If encrypted and no decryptKey: skip (or throw if strict=true).
   *
   * Returns an OverdueMarkResult. The `marked` array contains NEW GeneralInvoice
   * instances from .markAsOverdue() — callers are responsible for reissuing
   * the MajikInvoice and persisting.
   *
   * @param invoices    - Invoices to check
   * @param options.strict     - Throw on encrypted+inaccessible instead of skipping (default: false)
   * @param options.decryptKey - Optional key; used to decrypt encrypted invoices before checking
   */
  static async autoMarkOverdue(
    invoices: MajikInvoice[],
    options: {
      strict?: boolean;
      decryptKey?: MajikKey;
    } = {},
  ): Promise<OverdueMarkResult> {
    const { strict = false, decryptKey } = options;
    const today = new Date().toISOString().slice(0, 10);

    const marked: MajikInvoice[] = [];
    const skipped: OverdueMarkResult["skipped"] = [];

    for (const inv of invoices) {
      // ── 1. Resolve the GeneralInvoice ─────────────────────────────────────
      let gi: GeneralInvoice;

      if (inv.mode === "signed-only") {
        gi = inv.invoice;
      } else if (inv.hasDecryptedCache) {
        gi = inv.invoice;
      } else if (decryptKey) {
        // Attempt decrypt — skip if this key isn't authorised
        if (!inv.canDecrypt(decryptKey)) {
          if (strict) {
            throw new MajikInvoiceKeyError(
              `batchAutoMarkOverdue (strict): Key is not a recipient of invoice "${inv.id}".`,
            );
          }
          skipped.push({ invoiceId: inv.id, reason: "encrypted" });
          continue;
        }
        try {
          await inv.decrypt(decryptKey);
          gi = inv.invoice;
        } catch (error) {
          if (strict) throw error;
          skipped.push({ invoiceId: inv.id, reason: "encrypted" });
          continue;
        }
      } else {
        // Encrypted, no key provided
        if (strict) {
          throw new MajikInvoiceError(
            `batchAutoMarkOverdue (strict): Invoice "${inv.id}" is encrypted and no decryptKey was provided.`,
          );
        }
        skipped.push({ invoiceId: inv.id, reason: "encrypted" });
        continue;
      }

      // ── 2. Due-date check ─────────────────────────────────────────────────
      if (!gi.dueDate || gi.dueDate >= today) {
        skipped.push({ invoiceId: inv.id, reason: "not-overdue" });
        continue;
      }

      // ── 3. Transition guard ────────────────────────────────────────────────
      if (!gi.canTransitionTo("overdue")) {
        skipped.push({ invoiceId: inv.id, reason: "wrong-status" });
        continue;
      }

      // ── 4. Mark overdue — force=true because we already checked the date ──
      const updatedGi = gi.markAsOverdue(true);

      // Reissue the MajikInvoice shell with updated GeneralInvoice
      // (drops signatures — caller must re-sign)
      const updatedMajik = inv._reissueFromMutation(updatedGi);
      marked.push(updatedMajik);
    }

    return { marked, skipped };
  }

  // ==========================================================================
  // ── Dashboard Stats ──────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Compute dashboard statistics across an array of MajikInvoice.
   * Encrypted invoices that haven't been decrypted are counted in totals
   * using their public summary only — detailed financials (tax, discount, etc.)
   * require the decrypted GeneralInvoice and are excluded for locked invoices.
   *
   * @param invoices        - The invoice population to analyse
   * @param options.dueSoonDays - Window for dueSoonCount (default: 7)
   */
  static computeDashboardStats(
    invoices: MajikInvoice[],
    options: { dueSoonDays?: number } = {},
  ): DashboardStats {
    const { dueSoonDays = 7 } = options;

    const today = new Date().toISOString().slice(0, 10);
    const dueSoonCutoff = new Date(Date.now() + dueSoonDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    // ── Accumulators ──────────────────────────────────────────────────────────
    const byStatus: Record<string, number> = {};
    const byStatusAmount: Record<string, number> = {};
    const recipientMap = new Map<
      string,
      { totalAmount: number; count: number; paidAmount: number }
    >();
    const issuerSet = new Set<string>();
    const taxTypeMap = new Map<
      string,
      { total: number; rateSum: number; count: number }
    >();
    const allAmounts: number[] = [];
    const daysToPaymentList: number[] = [];

    let totalAmount = 0;
    let paidAmount = 0;
    let partialAmount = 0;
    let overdueAmount = 0;
    let totalCollected = 0;
    let totalOutstanding = 0;
    let taxCollected = 0;
    let withholdingTotal = 0;
    let netPayable = 0;
    let discountGiven = 0;
    let weightedTaxRate = 0; // numerator for weighted avg
    let weightedTaxBase = 0;
    let paidCount = 0;
    let partialCount = 0;
    let overdueCount = 0;
    let draftCount = 0;
    let voidCount = 0;
    let encryptedCount = 0;
    let unsignedCount = 0;
    let dueSoonCount = 0;
    let oldestDate: string | null = null;
    let newestDate: string | null = null;

    for (const inv of invoices) {
      const pub = inv.public;
      const invStatus = pub.status ?? "draft";
      const invAmount = pub.totalAmount ?? 0;

      // ── Status buckets ──────────────────────────────────────────────────────
      byStatus[invStatus] = (byStatus[invStatus] ?? 0) + 1;
      byStatusAmount[invStatus] = (byStatusAmount[invStatus] ?? 0) + invAmount;

      totalAmount += invAmount;
      allAmounts.push(invAmount);

      if (invStatus === "paid") {
        paidAmount += invAmount;
        paidCount++;
      }
      if (invStatus === "partial") {
        partialAmount += invAmount;
        partialCount++;
      }
      if (invStatus === "overdue") {
        overdueAmount += invAmount;
        overdueCount++;
      }
      if (invStatus === "draft") draftCount++;
      if (invStatus === "void") voidCount++;
      if (inv.status === "unsigned") unsignedCount++;
      if (inv.isEncrypted && !inv.hasDecryptedCache) encryptedCount++;

      // ── Temporal ─────────────────────────────────────────────────────────────
      const issuedAt = pub.issuedAt?.slice(0, 10) ?? null;
      if (issuedAt) {
        if (!oldestDate || issuedAt < oldestDate) oldestDate = issuedAt;
        if (!newestDate || issuedAt > newestDate) newestDate = issuedAt;
      }

      const dueDate = pub.dueDate?.slice(0, 10) ?? null;
      if (dueDate && dueDate >= today && dueDate <= dueSoonCutoff) {
        dueSoonCount++;
      }

      // ── Detailed financials — only available when plaintext is accessible ────
      let gi: GeneralInvoice | null = null;
      try {
        if (inv.mode === "signed-only" || inv.hasDecryptedCache) {
          gi = inv.invoice;
        }
      } catch {
        gi = null;
      }

      // ── Relationships ────────────────────────────────────────────────────────
      issuerSet.add(pub.issuerName);

      const recip = recipientMap.get(
        gi?.recipient?.legalName || pub.recipientName || "UNKNOWN_RECIPIENT",
      ) ?? {
        totalAmount: 0,
        count: 0,
        paidAmount: 0,
      };
      recip.totalAmount += invAmount;
      recip.count++;
      if (invStatus === "paid") recip.paidAmount += invAmount;
      recipientMap.set(
        gi?.recipient?.legalName || pub.recipientName || "UNKNOWN_RECIPIENT",
        recip,
      );

      if (gi) {
        totalCollected += gi.totalPaid.toMajor();
        totalOutstanding += gi.amountDue.toMajor();
        taxCollected += gi.taxAmount;
        withholdingTotal += gi.withholdingAmount;
        netPayable += gi.netPayableAmount;
        discountGiven += gi.discountAmount;

        if (gi.subtotalAmount > 0) {
          weightedTaxRate += gi.taxAmount;
          weightedTaxBase += gi.subtotalAmount;
        }

        // Days to first payment
        if (gi.proofOfPayments.length > 0 && gi.issueDate) {
          const issueMs = new Date(gi.issueDate).getTime();
          const firstPayMs = new Date(
            gi.proofOfPayments[0].settledAt,
          ).getTime();
          const days = (firstPayMs - issueMs) / 86_400_000;
          if (days >= 0) daysToPaymentList.push(days);
        }

        // Tax breakdown by type
        for (const entry of gi.taxBreakdown()) {
          if (entry.behaviour !== "additive") continue;
          const existing = taxTypeMap.get(entry.taxType) ?? {
            total: 0,
            rateSum: 0,
            count: 0,
          };
          existing.total += entry.taxAmount;
          existing.rateSum += entry.rate;
          existing.count++;
          taxTypeMap.set(entry.taxType, existing);
        }
      }
    }

    // ── Derived ────────────────────────────────────────────────────────────────
    const unpaidAmount = totalAmount - paidAmount - partialAmount;
    const effectiveTaxRate =
      weightedTaxBase > 0 ? weightedTaxRate / weightedTaxBase : 0;

    const avgInvoiceValue =
      allAmounts.length > 0
        ? allAmounts.reduce((s, v) => s + v, 0) / allAmounts.length
        : 0;
    const largestInvoice = allAmounts.length > 0 ? Math.max(...allAmounts) : 0;
    const smallestInvoice = allAmounts.length > 0 ? Math.min(...allAmounts) : 0;

    const sorted = [...allAmounts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianInvoiceValue =
      sorted.length === 0
        ? 0
        : sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];

    const avgDaysToPayment =
      daysToPaymentList.length > 0
        ? daysToPaymentList.reduce((s, v) => s + v, 0) /
          daysToPaymentList.length
        : null;

    const topRecipients = Array.from(recipientMap.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 10);

    const taxBreakdown = Array.from(taxTypeMap.entries()).map(
      ([taxType, v]) => ({
        taxType,
        amount: v.total,
        rate: v.count > 0 ? v.rateSum / v.count : 0,
      }),
    );

    return {
      total: invoices.length,
      paidCount,
      partialCount,
      overdueCount,
      draftCount,
      voidCount,
      encryptedCount,
      unsignedCount,
      byStatus,
      totalAmount,
      paidAmount,
      partialAmount,
      unpaidAmount,
      overdueAmount,
      byStatusAmount,
      totalCollected,
      totalOutstanding,
      avgDaysToPayment,
      taxCollected,
      withholdingTotal,
      netPayable,
      discountGiven,
      effectiveTaxRate,
      taxBreakdown,
      avgInvoiceValue,
      largestInvoice,
      smallestInvoice,
      medianInvoiceValue,
      topRecipients,
      uniqueRecipientCount: recipientMap.size,
      uniqueIssuerCount: issuerSet.size,
      oldestInvoiceDate: oldestDate,
      newestInvoiceDate: newestDate,
      dueSoonCount,
    };
  }

  // ==========================================================================
  // ── Binary ──────────────────────────────────────────────────────────
  // ==========================================================================

  toBinary(): ArrayBuffer {
    const json = encoder.encode(JSON.stringify(this.toJSON()));

    const buffer = new Uint8Array(MJKI_HEADER_SIZE + json.length);
    const view = new DataView(buffer.buffer);

    // ── Magic ─────────────────────────────
    buffer.set(MJKI_MAGIC, 0);

    // ── Version ──────────────────────────
    buffer[4] = MJKI_VERSION;

    // ── Reserved flags (future use) ───────
    buffer[5] = 0;
    buffer[6] = 0;
    buffer[7] = 0;

    // ── Length ────────────────────────────
    view.setUint32(8, json.length, false);

    // ── Payload ───────────────────────────
    buffer.set(json, MJKI_HEADER_SIZE);

    return buffer.buffer;
  }

  /** Parse from binary blob. */
  static fromBinary(blob: ArrayBuffer): MajikInvoice {
    const bytes = new Uint8Array(blob);
    const view = new DataView(blob);

    // ── Validate minimum size ─────────────
    if (blob.byteLength < MJKI_HEADER_SIZE) {
      throw new MajikInvoiceSerializationError(
        "Binary too small to be a valid MJKI file",
      );
    }

    // ── Magic check ───────────────────────
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== MJKI_MAGIC[i]) {
        throw new MajikInvoiceSerializationError(
          "Invalid magic number: not an MJKI file",
        );
      }
    }

    // ── Version ───────────────────────────
    const version = view.getUint8(4);
    if (version !== MJKI_VERSION) {
      throw new MajikInvoiceSerializationError(
        `Unsupported MJKI version: ${version}`,
      );
    }

    // ── Length ────────────────────────────
    const length = view.getUint32(8, false);

    const expectedSize = MJKI_HEADER_SIZE + length;

    if (blob.byteLength < expectedSize) {
      throw new MajikInvoiceSerializationError(
        `Truncated MJKI payload: expected ${expectedSize}, got ${blob.byteLength}`,
      );
    }

    // ── Extract payload ───────────────────
    const jsonBytes = bytes.slice(MJKI_HEADER_SIZE, expectedSize);

    let parsed: MajikInvoiceJSON;

    try {
      parsed = JSON.parse(decoder.decode(jsonBytes));
    } catch {
      throw new MajikInvoiceSerializationError(
        "Failed to decode MJKI JSON payload",
      );
    }

    return MajikInvoice.fromJSON(parsed);
  }

  // ==========================================================================
  // ── SERIALIZATION ──────────────────────────────────────────────────────────
  // ==========================================================================

  toJSON(): MajikInvoiceJSON {
    return {
      version: this.version,
      id: this.id,
      mode: this.mode,
      public: { ...this.public },
      payload: this.payload,
      integrity: { ...this.integrity },
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }

  /**
   * Generates a MajikahInvoiceJSON for cloud routing.
   * Ensures ownership and routing fields are present.
   */
  toMajikahInvoiceJSON(
    sender: MajikMessagePublicKey,
    options?: {
      userId?: string;
      accountId?: string;
      recipients?: MajikMessagePublicKey[];
      forceSignedOnly?: boolean;
    },
  ): MajikahInvoiceJSON {
    const finalUserId = options?.userId ?? this.userId;
    if (!finalUserId?.trim()) {
      throw new MajikInvoiceError(
        "userId is required to generate a MajikahInvoiceJSON. Provide it during create(), via withUserId(), or as an option here.",
      );
    }

    const finalRecipients = options?.recipients ?? this.recipients;

    if (!finalRecipients || finalRecipients.length === 0) {
      throw new MajikInvoiceError(
        "At least 1 recipient is required to generate a MajikahInvoiceJSON.",
      );
    }

    if (!sender?.trim()) {
      throw new MajikInvoiceError(
        "Sender Public Key is required to generate a MajikahInvoiceJSON.",
      );
    }

    if (!this.isEncrypted && !options?.forceSignedOnly) {
      throw new MajikInvoiceError(
        "An encrypted invoice is required to generate a MajikahInvoiceJSON.",
      );
    }

    const finalAccountId = options?.accountId ?? this.accountId ?? finalUserId;

    this.secureLock();

    const baseJSON = this.toJSON();
    return {
      ...baseJSON,
      user_id: finalUserId,
      account_id: finalAccountId,
      recipients: finalRecipients,
      public_key: sender,
      sent_at: new Date().toISOString(),
      status: this.public.status,
    };
  }

  static fromJSON(
    json: MajikInvoiceJSON | MajikahInvoiceJSON | string,
  ): MajikInvoice {
    try {
      const parsed = typeof json === "string" ? JSON.parse(json) : json;

      if (!parsed.id || !parsed.mode || !parsed.payload || !parsed.integrity) {
        throw new MajikInvoiceSerializationError(
          "MajikInvoiceJSON is missing required fields (id, mode, payload, integrity)",
        );
      }

      // Map cloud fields back to standard properties if coming from MajikahInvoiceJSON
      const parsedCloud = parsed as any;
      const resolvedUserId = parsedCloud.user_id ?? parsed.userId;
      const resolvedAccountId = parsedCloud.account_id ?? parsed.accountId;

      const instance = new MajikInvoice({
        id: parsed.id,
        mode: parsed.mode,
        public: parsed.public,
        payload: parsed.payload,
        integrity: parsed.integrity,
        userId: resolvedUserId,
        accountId: resolvedAccountId,
        createdAt: parsed.created_at,
        updatedAt: parsed.updated_at,
        recipients: parsed?.recipients,
      });

      const validation = instance._validateStructure();
      if (!validation.valid) {
        throw new MajikInvoiceSerializationError(
          `Deserialized MajikInvoice failed validation:\n` +
            validation.errors
              .map((e) => `  ${e.field}: ${e.message}`)
              .join("\n"),
        );
      }

      return instance;
    } catch (err) {
      if (err instanceof MajikInvoiceError) throw err;
      throw new MajikInvoiceSerializationError(
        "Failed to deserialize MajikInvoice from JSON",
        err,
      );
    }
  }
  toString(pretty = false): string {
    return JSON.stringify(this.toJSON(), null, pretty ? 2 : 0);
  }

  // ==========================================================================
  // ── PRIVATE HELPERS ────────────────────────────────────────────────────────
  // ==========================================================================

  protected _reissueFromMutation(
    updatedInvoice: GeneralInvoice,
    options: {
      /**
       * When true, recomputes contentHash from the updated invoice.
       * Use this ONLY for genuine financial edits (reissue() path).
       * Default: false — preserves existing contentHash so signatures remain valid.
       */
      recomputeHash?: boolean;
    } = {},
  ): MajikInvoice {
    // NOTE:
    // - drops signatures (correct for financial edits)
    // - preserves mode
    // - DOES NOT auto-sign (caller decides)

    const publicSummary = MajikInvoice._buildPublicSummary(updatedInvoice);

    // Only recompute the hash when the financial content has genuinely changed.
    // Lifecycle mutations (status, payments, notes) must carry the existing hash
    // forward so that attached signatures remain verifiable.
    const contentHash = options.recomputeHash
      ? MajikInvoice._sha256Hex(updatedInvoice.toCanonicalBytes())
      : this.integrity.contentHash;

    let payload: MajikInvoicePayload;

    if (this.mode === "encrypted-and-signed") {
      throw new MajikInvoiceError(
        "Cannot mutate encrypted invoice without re-encryption context. Use reissue() with recipients.",
      );
    }

    payload = {
      kind: "signed-only",
      invoice: updatedInvoice.toJSON(),
    };

    // For lifecycle mutations (recomputeHash: false), preserve existing signatures.
    // For financial edits (recomputeHash: true), drop signatures — content changed.
    const integrity: IntegrityBlock = {
      contentHash,
      hashAlgorithm: "SHA-256",
      signatures: options.recomputeHash ? [] : [...this.integrity.signatures],
      isSealed: options.recomputeHash ? false : this.integrity.isSealed,
      // Preserve allowlist metadata regardless
      expectedSigners: this.integrity.expectedSigners,
      allowlistSignerId: this.integrity.allowlistSignerId,
      sealInfo: options.recomputeHash ? undefined : this.integrity.sealInfo,
    };

    return new MajikInvoice({
      id: updatedInvoice.id,
      mode: this.mode,
      public: publicSummary,
      payload,
      integrity,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Build the public summary from a GeneralInvoice.
   */
  private static _buildPublicSummary(
    invoice: GeneralInvoice,
  ): PublicInvoiceSummary {
    return {
      issuerName: invoice.issuer.legalName,
      recipientName: invoice.recipient.legalName,
      currency: invoice.currency,
      totalAmount: invoice.totalAmount,
      formattedTotal: invoice.formattedTotal,
      invoiceType: invoice.type,
      issuedAt: invoice.issueDate,
      dueDate: invoice.dueDate,
      invoiceNumber: invoice.invoiceNumber,
      paymentStatus: invoice.paymentStatus,
      status: invoice.status,
    };
  }

  /**
   * Encrypt a GeneralInvoice into a MajikEnvelope and return an EncryptedPayload.
   */
  private static async _buildEncryptedPayload(
    invoice: GeneralInvoice,
    recipients: MajikRecipient[],
    _signerKey?: MajikKey,
  ): Promise<EncryptedPayload> {
    if (!recipients || recipients.length === 0) {
      throw new MajikInvoiceKeyError(
        "At least one recipient is required for encryption.",
      );
    }

    const plaintext = JSON.stringify(invoice.toJSON());
    const senderFingerprint =
      recipients.length > 1 ? (recipients[0]?.fingerprint ?? "") : undefined;

    try {
      const envelope = await MajikEnvelope.encrypt({
        plaintext,
        recipients,
        senderFingerprint,
        compress: true,
      });

      return {
        kind: "encrypted-and-signed",
        envelopeString: envelope.toScannerString(),
        algorithm: "ML-KEM-768 + AES-256-GCM",
        recipientFingerprints: recipients.map((r) => r.fingerprint),
      } satisfies EncryptedPayload;
    } catch (err) {
      throw new MajikInvoiceEncryptionError(
        "Failed to encrypt invoice payload.",
        err,
      );
    }
  }

  /**
   * Derive the canonical bytes used as signing input.
   * Format: "majik-invoice-v1:" + JSON({ contentHash, id })
   * This ensures the signature covers both the invoice identity and its content hash.
   */
  private static async _canonicalBytesForSigning(
    contentHash: string,
    invoiceId: string,
  ): Promise<Uint8Array> {
    const canonical = `majik-invoice-v1:${JSON.stringify({ contentHash, invoiceId })}`;
    return new TextEncoder().encode(canonical);
  }

  /**
   * Compute SHA-256 hex of bytes.
   */
  private static _sha256Hex(bytes: Uint8Array): string {
    const hashed = hash(bytes);
    const hexHash = Array.from(hashed)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hexHash;
  }
  /**
   * Get the plaintext GeneralInvoice for operations that require it.
   * Handles signed-only mode and decrypted cache; throws if encrypted and not cached.
   */
  private _requirePlaintextInvoice(operation: string): GeneralInvoice {
    if (this.mode === "signed-only") {
      return GeneralInvoice.fromJSON(
        (this.payload as SignedOnlyPayload).invoice,
      );
    }
    if (this._decrypted) {
      return this._decrypted.invoice;
    }
    throw new MajikInvoiceError(
      `Cannot perform "${operation}" — invoice is encrypted and has not been decrypted. ` +
        `Call decrypt(key) first.`,
    );
  }

  // ── Key assertion helpers ─────────────────────────────────────────────────

  private static _assertKeyUnlocked(key: MajikKey, operation: string): void {
    if (key.isLocked) {
      throw new MajikInvoiceKeyError(
        `Cannot ${operation}: MajikKey is locked. Call key.unlock(passphrase) first.`,
      );
    }
  }

  private static _assertKeyHasSigningKeys(
    key: MajikKey,
    operation: string,
  ): void {
    if (!key.hasSigningKeys) {
      throw new MajikInvoiceKeyError(
        `Cannot ${operation}: MajikKey has no signing keys. ` +
          `Re-import via key.importFromMnemonicBackup() to enable signing.`,
      );
    }
  }

  private static _assertKeyHasMlKem(key: MajikKey, operation: string): void {
    if (!key.hasMlKem) {
      throw new MajikInvoiceKeyError(
        `Cannot ${operation}: MajikKey has no ML-KEM keys. ` +
          `Re-import via key.importFromMnemonicBackup() to enable decryption.`,
      );
    }
  }

  // ── Input validation ──────────────────────────────────────────────────────

  private static _assertValidInput(input: MajikInvoiceInput): void {
    const mode = input.mode ?? "signed-only";

    if (!["signed-only", "encrypted-and-signed"].includes(mode)) {
      throw new MajikInvoiceError(
        `Invalid mode "${mode}". Must be "signed-only" or "encrypted-and-signed".`,
      );
    }

    if (mode === "encrypted-and-signed") {
      if (!input.recipients || input.recipients.length === 0) {
        throw new MajikInvoiceKeyError(
          `recipients are required when mode is "encrypted-and-signed".`,
        );
      }
    }

    if (input.signerKey) {
      if (input.signerKey.isLocked) {
        throw new MajikInvoiceKeyError(
          "signerKey is locked. Call signerKey.unlock(passphrase) before creating a MajikInvoice.",
        );
      }
      if (!input.signerKey.hasSigningKeys) {
        throw new MajikInvoiceKeyError(
          "signerKey has no signing keys. Re-import via importFromMnemonicBackup() first.",
        );
      }
    }

    if (input.expectedSigners) {
      if (!input.signerKey) {
        throw new MajikInvoiceKeyError(
          "signerKey is required when expectedSigners is provided — " +
            "the first signer must establish the allowlist.",
        );
      }
      if (
        !Array.isArray(input.expectedSigners) ||
        input.expectedSigners.length < 1
      ) {
        throw new MajikInvoiceError(
          "expectedSigners must be a non-empty array of ExpectedSigner objects.",
        );
      }
    }
  }

  // ==========================================================================
  // ── CSV EXPORT — add inside the MajikInvoice class body ────────────────────
  // ==========================================================================

  /**
   * Export an array of MajikInvoice instances to a single CSV string.
   *
   * Behaviour per invoice:
   *
   *   signed-only              → full data row using the GeneralInvoice
   *   encrypted + decrypted    → full data row using the cached GeneralInvoice
   *   encrypted + locked       → partial row using only PublicInvoiceSummary
   *                              fields; all GeneralInvoice-only columns are
   *                              left blank. The invoice IS still included in
   *                              the output — it is never silently dropped.
   *
   */
  static async batchExportToCSV(
    invoices: MajikInvoice[],
    options: {
      columns?: CSVColumn[];
    } = {},
  ): Promise<CSVExportResult> {
    const rawColumns = options.columns ?? DEFAULT_CSV_COLUMNS;
    const columns = dedupeColumns(rawColumns);

    const partialExports: CSVExportResult["partialExports"] = [];
    const errors: CSVExportResult["errors"] = [];
    const rows: string[] = [];

    // Header row — always present even if there are zero invoices
    rows.push(buildCSVHeader(columns));

    for (const inv of invoices) {
      try {
        // ── Resolve the GeneralInvoice (or fall back to public summary) ────────
        let generalInvoice: GeneralInvoice | undefined;

        if (inv.mode === "signed-only") {
          // Safe — plaintext is always accessible
          generalInvoice = inv.invoice;
        } else if (inv.hasDecryptedCache) {
          // Encrypted but already decrypted this session
          generalInvoice = inv.invoice;
        } else {
          // Encrypted and locked — we cannot access GeneralInvoice fields.
          // Export what we can from the public summary and note the gap.
          generalInvoice = undefined;

          // Identify which columns will be blank so we can report them
          const unavailable = columns
            .filter((col) => {
              // Probe: try resolving with no invoice; blank result = unavailable
              try {
                const ctx: CSVResolveContext = {
                  invoice: undefined,
                  public: inv.public,
                  invoiceId: inv.id,
                };
                const val = col.resolve(ctx);
                return val === "";
              } catch {
                return true;
              }
            })
            .map((col) => col.key);

          partialExports.push({
            invoiceId: inv.id,
            reason: "encrypted-no-cache",
            unavailableColumns: unavailable,
          });
        }

        // ── Build the row ──────────────────────────────────────────────────────
        const ctx: CSVResolveContext = {
          invoice: generalInvoice,
          public: inv.public,
          invoiceId: inv.id,
        };

        rows.push(buildCSVRow(ctx, columns));
      } catch (err) {
        // Hard failure — skip this invoice's row but record the error
        errors.push({
          invoiceId: inv.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const csv = rows.join("\n");
    const success = partialExports.length === 0 && errors.length === 0;

    return {
      csv,
      count: invoices.length,
      success,
      partialExports,
      errors,
    };
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
