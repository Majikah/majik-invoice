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
 *                            fields are visible without the recipient's key
 *
 * Design principles:
 *   - Private constructor — always use MajikInvoice.create()
 *   - Mode is set at construction and immutable; conversion returns a new instance
 *   - MajikKey is the primary key interface (unlock-check is built in)
 *   - Full multi-sig via MajikSignature's allowlist/seal pattern
 *   - Decrypted state is cached on the instance (decrypted?: DecryptedCache)
 *   - Single recipient now; multi-recipient available via recipientKeys array
 *     backed by MajikEnvelope's group mode
 *   - toJSON() / fromJSON() are round-trip stable and safe to persist
 *   - toCanonicalBytes() is deterministic — used internally for signing
 *
 * Status vocabulary:
 *   "sealed"    — signed (and optionally encrypted); integrity intact
 *   "unsigned"  — created but not yet signed
 *   "decrypted" — encrypted invoice that has been decrypted in this session
 *   "invalid"   — signature or structural verification failed
 */

import { GeneralInvoice } from "./general-invoice";
import type { GeneralInvoiceJSON, ProofOfPayment } from "./general-invoice";
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
import type { MajikKey } from "@majikah/majik-key";

import { hash } from "@stablelib/sha256";
import {
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
 *   issuer: { legalName: "Alice Co", tin: "123-456-789-000" },
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
 *   issuer: { legalName: "Alice Co" },
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

  // ── Public summary — always plaintext ────────────────────────────────────
  readonly public: PublicInvoiceSummary;

  // ── Payload ───────────────────────────────────────────────────────────────
  readonly payload: MajikInvoicePayload;

  // ── Integrity ─────────────────────────────────────────────────────────────
  readonly integrity: IntegrityBlock;

  // ── Settlement ────────────────────────────────────────────────────────────
  readonly proofOfPayments: readonly ProofOfPayment[];

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
    this.proofOfPayments = Object.freeze([...(opts.proofOfPayments ?? [])]);
    this.createdAt = opts.createdAt;
    this.updatedAt = opts.updatedAt;
    this._decrypted = opts.decrypted;
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
      proofOfPayments: [...this.proofOfPayments],
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
      proofOfPayments: [],
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

  attachProofOfPayment(proof: ProofOfPayment): MajikInvoice {
    if (!proof.id || typeof proof.amount !== "number") {
      throw new MajikInvoiceError(
        "ProofOfPayment must include an id and a valid amount.",
      );
    }
    return this.rebuild({ proofOfPayments: [...this.proofOfPayments, proof] });
  }

  // ==========================================================================
  // ── GETTERS ─────────────────────────────────────────────────────────────────
  // ==========================================================================

  get totalPaidAmount(): number {
    return this.proofOfPayments.reduce((sum, proof) => sum + proof.amount, 0);
  }

  get isSettled(): boolean {
    return this.totalPaidAmount >= this.public.totalAmount;
  }

  get paymentStatus(): "pending" | "partially-paid" | "settled" {
    if (this.isSettled) return "settled";
    if (this.totalPaidAmount > 0) return "partially-paid";
    return "pending";
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
      contentHash,
      hashAlgorithm: "SHA-256",
      signatures: [],
      isSealed: false,
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
   * "sealed"    — sealed and signed  (encrypted or plaintext)
   * "signed"    — at least one valid signature present AND allowlist (if any) satisfied
   * "unsigned"  — invoice created but no signatures attached yet
   * "decrypted" — was encrypted; has been decrypted in this session (cached)
   * "invalid"   — structural or cryptographic verification failed
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

  get isEncrypted(): boolean {
    return this.mode === "encrypted-and-signed";
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
   * Typical usage:
   *   const updated = invoice.invoice.withLineItem({ ... }).withNotes("...");
   *   const reissued = await invoice.reissue(updated, { signerKey: aliceKey });
   *
   * @throws {MajikInvoiceKeyError} if mode is "encrypted-and-signed" and no recipientKeys provided
   * @throws {MajikInvoiceKeyError} if signerKey is locked or missing signing keys
   * @throws {MajikInvoiceEncryptionError} if re-encryption fails
   */
  async reissue(
    updatedInvoice: GeneralInvoice,
    options: {
      signerKey?: MajikKey;
      /** Required when mode is "encrypted-and-signed" */
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

    const publicSummary = MajikInvoice._buildPublicSummary(updatedInvoice);
    const canonicalBytes = updatedInvoice.toCanonicalBytes();
    const contentHash = MajikInvoice._sha256Hex(canonicalBytes);

    let payload: MajikInvoicePayload;
    if (this.mode === "encrypted-and-signed") {
      payload = await MajikInvoice._buildEncryptedPayload(
        updatedInvoice,
        options.recipients!,
      );
    } else {
      payload = {
        kind: "signed-only",
        invoice: updatedInvoice.toJSON(),
      } satisfies SignedOnlyPayload;
    }

    const integrity: IntegrityBlock = {
      contentHash,
      hashAlgorithm: "SHA-256",
      signatures: [],
      isSealed: false,
    };

    const reissued = new (this.constructor as typeof MajikInvoice)({
      id: updatedInvoice.id,
      mode: this.mode,
      public: publicSummary,
      payload,
      integrity,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
    });

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

  // ==========================================================================
  // ── SERIALIZATION ──────────────────────────────────────────────────────────
  // ==========================================================================

  toJSON(): MajikInvoiceJSON {
    return {
      __type: "MajikInvoice",
      version: this.version,
      id: this.id,
      mode: this.mode,
      public: { ...this.public },
      payload: this.payload,
      integrity: { ...this.integrity },
      proofOfPayments: [...this.proofOfPayments], // Fixed typo from 'this.pr'
      userId: this.userId,
      accountId: this.accountId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Generates a MajikahInvoiceJSON for cloud routing.
   * Ensures ownership and routing fields are present.
   */
  toMajikahInvoiceJSON(options?: {
    userId?: string;
    accountId?: string;
    recipients?: string[];
    publicKey?: string;
  }): MajikahInvoiceJSON {
    const finalUserId = options?.userId ?? this.userId;
    if (!finalUserId?.trim()) {
      throw new MajikInvoiceError(
        "userId is required to generate a MajikahInvoiceJSON. Provide it during create(), via withUserId(), or as an option here.",
      );
    }

    const finalAccountId = options?.accountId ?? this.accountId ?? finalUserId;

    let finalRecipients = options?.recipients;
    if (!finalRecipients || finalRecipients.length === 0) {
      const signers = new Set<string>();
      if (this.integrity.signatures.length > 0) {
        signers.add(this.integrity.signatures[0].signerId);
      }
      if (this.integrity.expectedSigners) {
        this.integrity.expectedSigners.forEach((s) => signers.add(s.signerId));
      }
      finalRecipients = Array.from(signers);
    }

    let finalPublicKey: string = "";
    if (this.integrity.signatures.length > 0) {
      const firstSig = this.integrity.signatures[0];
      // Type assertion since publicKey comes from MajikSignatureJSON
      finalPublicKey = options?.publicKey ?? firstSig.signerEdPublicKey;
    }

    if (!finalPublicKey?.trim()) {
      throw new MajikInvoiceError(
        "publicKey is required to generate a MajikahInvoiceJSON.",
      );
    }

    const baseJSON = this.toJSON();
    return {
      ...baseJSON,
      __type: "MajikahInvoice",
      user_id: finalUserId,
      account_id: finalAccountId,
      recipients: finalRecipients,
      public_key: finalPublicKey,
    } as MajikahInvoiceJSON;
  }

  static fromJSON(
    json: MajikInvoiceJSON | MajikahInvoiceJSON | string,
  ): MajikInvoice {
    try {
      const parsed = typeof json === "string" ? JSON.parse(json) : json;

      if (
        parsed.__type !== "MajikInvoice" &&
        parsed.__type !== "MajikahInvoice"
      ) {
        throw new MajikInvoiceSerializationError(
          `Expected __type "MajikInvoice" or "MajikahInvoice", got "${parsed.__type}"`,
        );
      }

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
        proofOfPayments: parsed.proofOfPayments ?? [],
        userId: resolvedUserId,
        accountId: resolvedAccountId,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
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
}
