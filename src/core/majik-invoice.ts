/**
 * @file majik-invoice.ts
 *
 * @description
 * Cryptographically secured invoice envelope for the `@majikah/majik-invoice`
 * domain.
 *
 * `MajikInvoice` wraps a {@link GeneralInvoice} with cryptographic integrity,
 * optional ML-KEM-768 encryption, and hybrid Ed25519 + ML-DSA-87 signatures.
 *
 * The class supports two payload modes:
 *
 * - `signed-only`
 *   The GeneralInvoice remains plaintext while its canonical content is
 *   cryptographically committed and optionally signed/sealed.
 *
 * - `encrypted-and-signed`
 *   The GeneralInvoice is encrypted inside a MajikEnvelope. Only the public
 *   invoice summary remains available without decryption.
 *
 * `MajikInvoice` is the transport, security, and synchronization layer around
 * the underlying business invoice represented by {@link GeneralInvoice}.
 */

import { GeneralInvoice } from "./general-invoice/index.js";
import type {
  GeneralInvoiceJSON,
  InvoiceStatus,
  PaymentStatus,
  ProofOfPayment,
} from "./general-invoice/types.js";
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
import type { MajikKey, MajikKeyAddress } from "@majikah/majik-key";

import {
  encoder,
  decoder,
  sha256Hex,
  canonicalBytesForSigning,
} from "./crypto-utils.js";
import {
  assertKeyUnlocked,
  assertKeyHasSigningKeys,
  assertKeyHasMlKem,
} from "./validators/key-guards.js";
import {
  ConflictResolutionStrategy,
  DashboardStats,
  DecryptedCache,
  EncryptedPayload,
  IntegrityBlock,
  InvoiceDiff,
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
} from "./types.js";
import {
  MajikInvoiceEncryptionError,
  MajikInvoiceError,
  MajikInvoiceKeyError,
  MajikInvoiceSealError,
  MajikInvoiceSerializationError,
  MajikInvoiceSignatureError,
} from "./errors.js";
import { MJKI_HEADER_SIZE, MJKI_MAGIC, MJKI_VERSION } from "./binary.js";
import { MajikMoney } from "@thezelijah/majik-money";
import {
  buildCSVHeader,
  buildCSVRow,
  CSVColumn,
  CSVExportResult,
  CSVResolveContext,
  dedupeColumns,
  DEFAULT_CSV_COLUMNS,
} from "./csv-export.js";
import { computeAllowlistHash } from "./signing.js";
import {
  createSignatureJSON,
  verifySignatureJSON,
  computeSealHashAsync,
} from "./signing-service.js";
import { buildEncryptedPayload } from "./encryption.js";
import { incrementLastNumericSequence } from "./general-invoice/utils.js";

// ── Batch / statistics result types ──────────────────────────────────────

/**
 * Result of decrypting multiple {@link MajikInvoice} instances.
 *
 * Successful invoices are returned in `decrypted`; invoices that could not
 * be processed are returned in `errors` without aborting the entire batch.
 */
export interface BatchDecryptResult {
  /**
   * `true` when every invoice was processed successfully.
   *
   * An invoice being signed-only counts as a successful pass-through because
   * no decryption is required.
   */
  success: boolean;

  /** Successfully processed invoice instances. */
  decrypted: MajikInvoice[];

  /** Per-invoice decryption failures. */
  errors: Array<{
    invoiceId: string;
    reason: string;
  }>;
}

/**
 * Result of clearing decrypted runtime caches across a batch.
 */
export interface BatchLockResult {
  /** Number of encrypted invoices whose decrypted cache was cleared. */
  locked: number;

  /** Number of signed-only invoices skipped because they have no encrypted cache. */
  skipped: number;
}

/**
 * Result of automatically detecting and marking overdue invoices.
 */
export interface OverdueMarkResult {
  /**
   * Updated invoice instances that were detected as overdue and transitioned
   * to `overdue`.
   */
  marked: MajikInvoice[];

  /**
   * Invoices that were intentionally not marked.
   *
   * - `encrypted` — plaintext could not be accessed
   * - `not-overdue` — due date has not passed
   * - `wrong-status` — current lifecycle does not permit the transition
   */
  skipped: Array<{
    invoiceId: string;
    reason: "encrypted" | "not-overdue" | "wrong-status";
  }>;
}

// ── Sync types ───────────────────────────────────────────────────────────

/**
 * Result of comparing local and remote invoice collections by invoice ID.
 */
export interface BatchSyncStatusResult {
  /** Invoices whose local and remote content are identical. */
  synced: MajikInvoice[];

  /** Invoices that exist on both sides but have different content hashes. */
  conflicts: SyncConflict[];

  /** Invoices found locally but not remotely. */
  localOnly: MajikInvoice[];

  /** Invoices found remotely but not locally. */
  remoteOnly: MajikInvoice[];
}

/**
 * A single local/remote invoice synchronization conflict.
 */
export interface SyncConflict {
  /** Shared invoice ID identifying the conflicting document. */
  id: string;

  /** Local invoice version. */
  local: MajikInvoice;

  /** Remote invoice version. */
  remote: MajikInvoice;

  /** Structured comparison of the local and remote copies. */
  diff: InvoiceDiff;
}

// ── Batch duplication ────────────────────────────────────────────────────

/**
 * Result of duplicating multiple invoices.
 *
 * Successful duplicates are returned in `duplicated`; individual failures are
 * collected in `errors`.
 */
export interface BatchDuplicateResult {
  /** Successfully duplicated invoices. */
  duplicated: MajikInvoice[];

  /** Per-invoice duplication failures. */
  errors: Array<{
    invoiceId: string;
    reason: string;
  }>;
}

/**
 * Result of decrypting a {@link MajikInvoice} into its underlying
 * {@link GeneralInvoice}.
 *
 * `instance` is the corresponding MajikInvoice instance containing the
 * runtime decrypted cache.
 */
export interface InvoiceDecryptionResult {
  /** Decrypted business invoice. */
  invoice: GeneralInvoice;

  /**
   * MajikInvoice instance containing the decrypted runtime cache.
   *
   * This may be a new instance because decrypted state is intentionally
   * represented as runtime state rather than persisted payload data.
   */
  instance: MajikInvoice;
}

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * Serialized schema version for the MajikInvoice envelope.
 *
 * This identifies the JSON representation of the cryptographic envelope and
 * is independent of the inner `GeneralInvoice` schema version.
 */
const MAJIK_INVOICE_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// MajikInvoice
// ---------------------------------------------------------------------------

/**
 * Cryptographically secured invoice envelope.
 *
 * `MajikInvoice` wraps a {@link GeneralInvoice} with:
 *
 * - SHA-256 content integrity
 * - optional ML-KEM-768 encryption
 * - hybrid Ed25519 + ML-DSA-87 signatures
 * - signer allowlists
 * - tamper-evident sealing
 * - recipient routing information
 * - runtime-only decrypted caching
 * - JSON and binary serialization
 * - CSV export
 * - invoice synchronization and conflict analysis
 *
 * ### Payload modes
 *
 * #### `signed-only`
 *
 * The underlying `GeneralInvoice` is available directly in plaintext.
 *
 * This mode is useful when confidentiality is not required but document
 * integrity and/or signatures are still required.
 *
 * #### `encrypted-and-signed`
 *
 * The underlying `GeneralInvoice` is encrypted in a {@link MajikEnvelope}.
 *
 * Without decryption, consumers can access only the public invoice summary
 * and cryptographic metadata. The full invoice becomes available after
 * successful decryption with an authorized {@link MajikKey}.
 *
 * ### Cryptographic layers
 *
 * The envelope separates three concepts:
 *
 * `contentHash`
 * → SHA-256 commitment to the canonical `GeneralInvoice`
 *
 * signatures
 * → cryptographic authorization over the invoice commitment
 *
 * seal
 * → final cryptographic state indicating that no further signatures should
 *   be added
 *
 * These concepts are intentionally independent:
 *
 * - an invoice can be unsigned
 * - signed but not sealed
 * - fully signed but not sealed
 * - sealed after signing
 *
 * ### Public vs private data
 *
 * `public` is intentionally plaintext and contains the minimum summary needed
 * for routing, display, and indexing.
 *
 * The full `GeneralInvoice` may remain inside `payload` when signed-only or
 * inside the encrypted envelope when encrypted-and-signed.
 *
 * ### Immutability
 *
 * Operations that produce a changed invoice generally return a new
 * `MajikInvoice` rather than mutating the existing envelope.
 *
 * Runtime decrypted cache clearing is the notable exception because it is a
 * security-oriented in-memory operation.
 *
 * @example Signed-only invoice
 * ```ts
 * const invoice = await MajikInvoice.create({
 *   mode: "signed-only",
 *   signerKey: aliceKey,
 *   issuer: {
 *     legalName: "Alice Corporation",
 *     tin: "123-456-789-000",
 *   },
 *   recipient: {
 *     legalName: "Bob Inc",
 *   },
 *   currency: "PHP",
 *   lineItems: [
 *     {
 *       description: "Design Services",
 *       quantity: 1,
 *       unitPrice: 50000,
 *     },
 *   ],
 * });
 *
 * console.log(invoice.status);
 * console.log(invoice.public.formattedTotal);
 * ```
 *
 * @example Encrypted-and-signed invoice
 * ```ts
 * const invoice = await MajikInvoice.create({
 *   mode: "encrypted-and-signed",
 *   signerKey: aliceKey,
 *   recipients: [bobRecipient],
 *   issuer: {
 *     legalName: "Alice Corporation",
 *   },
 *   recipient: {
 *     legalName: "Bob Inc",
 *   },
 *   currency: "PHP",
 *   lineItems: [
 *     {
 *       description: "Confidential Services",
 *       quantity: 1,
 *       unitPrice: 100000,
 *     },
 *   ],
 * });
 *
 * const decrypted = await invoice.decrypt(bobKey);
 * console.log(decrypted.invoice.totals.grandTotal.format());
 * ```
 */
export class MajikInvoice {
  // ── Identity ──────────────────────────────────────────────────────────────

  /**
   * Stable unique identifier shared with the wrapped `GeneralInvoice`.
   */
  readonly id: string;

  /**
   * Serialized MajikInvoice envelope schema version.
   */
  readonly version: string;

  /**
   * Security/envelope mode of the invoice.
   */
  readonly mode: MajikInvoiceMode;

  // ── Cloud Routing & Ownership ────────────────────────────────────────────

  /**
   * Optional cloud/user ownership identifier associated with the invoice.
   */
  readonly userId?: string;

  /**
   * Optional account identifier used by cloud routing/storage.
   */
  readonly accountId?: string;

  /**
   * Optional public routing addresses for invoice recipients.
   *
   * These are routing/public-key identifiers rather than decrypted invoice
   * recipients contained inside the encrypted payload.
   */
  recipients?: MajikKeyAddress[];

  // ── Public summary — always plaintext ────────────────────────────────────

  /**
   * Public invoice summary available without decrypting the payload.
   *
   * This contains presentation and routing information intended to remain
   * plaintext even when the underlying `GeneralInvoice` is encrypted.
   */
  readonly public: PublicInvoiceSummary;

  // ── Payload ───────────────────────────────────────────────────────────────

  /**
   * Actual invoice payload.
   *
   * In `signed-only` mode this contains the serialized `GeneralInvoice`.
   *
   * In `encrypted-and-signed` mode this contains the encrypted envelope
   * string and recipient fingerprint metadata.
   */
  readonly payload: MajikInvoicePayload;

  // ── Integrity ─────────────────────────────────────────────────────────────

  /**
   * Cryptographic integrity and signing state for the invoice.
   *
   * Contains the canonical content hash, attached signatures, allowlist
   * information, and optional seal metadata.
   */
  readonly integrity: IntegrityBlock;

  // ── Timestamps ────────────────────────────────────────────────────────────

  /**
   * Timestamp at which the MajikInvoice envelope was created.
   */
  readonly createdAt: string;

  /**
   * Timestamp of the most recent envelope rebuild.
   */
  readonly updatedAt: string;

  /**
   * Optional timestamp indicating when the invoice was sent/routed.
   */
  readonly sentAt?: string;

  // ── Runtime-only decrypted cache (NOT persisted) ──────────────────────────

  /**
   * Runtime-only decrypted invoice cache.
   *
   * This field is deliberately excluded from serialized output so plaintext
   * invoice data is not persisted merely because it was decrypted in memory.
   */
  private _decrypted?: DecryptedCache;

  /**
   * Construct a MajikInvoice from normalized envelope state.
   *
   * This constructor is protected because instances should generally be
   * produced through the public factories or controlled internal rebuild paths.
   *
   * @param opts - Fully initialized MajikInvoice state.
   */
  protected constructor(opts: MajikInvoiceConstructorOptions) {
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
    this.sentAt = opts.sentAt;
  }

  /**
   * Rebuild the envelope while preserving unchanged state by default.
   *
   * The invoice ID, mode, payload, integrity, ownership, routing, and creation
   * timestamp are carried forward unless explicitly overridden.
   *
   * `updatedAt` is refreshed for the rebuilt instance.
   *
   * @param overrides - Fields to replace in the rebuilt instance.
   * @returns A new `MajikInvoice`.
   * @internal
   */
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
      recipients: this.recipients,
      sentAt: this.sentAt,
      ...overrides,
    });
  }

  // ==========================================================================
  // ── STATIC FACTORY
  // ==========================================================================

  /**
   * Create a new MajikInvoice from {@link MajikInvoiceInput}.
   *
   * The creation pipeline is:
   *
   * 1. Validate security-specific input requirements.
   * 2. Build the underlying {@link GeneralInvoice}.
   * 3. Build the always-plaintext public summary.
   * 4. Calculate the canonical content hash.
   * 5. Build either a plaintext or encrypted payload.
   * 6. Create the initial integrity block.
   * 7. Optionally sign immediately when `signerKey` is provided.
   *
   * Encryption occurs before the invoice is exposed as a completed
   * `MajikInvoice`, while signatures operate on the canonical invoice
   * commitment rather than directly on the encrypted envelope.
   *
   * @param input - Invoice, security, recipient, and routing configuration.
   * @returns Newly created MajikInvoice.
   * @throws {@link MajikInvoiceError} When input configuration is invalid.
   * @throws {@link MajikInvoiceKeyError} When required keys/recipients are
   * missing or unusable.
   * @throws {@link MajikInvoiceEncryptionError} When payload encryption fails.
   * @throws {@link MajikInvoiceSignatureError} When initial signing fails.
   *
   * @example
   * ```ts
   * const invoice = await MajikInvoice.create({
   *   mode: "signed-only",
   *   issuer: { legalName: "Acme Corp" },
   *   recipient: { legalName: "Client Inc" },
   *   currency: "PHP",
   *   lineItems: [
   *     {
   *       description: "Development",
   *       quantity: 1,
   *       unitPrice: 25000,
   *     },
   *   ],
   * });
   * ```
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
      recipientPublicKeys,
      ...generalInput
    } = input;
    const generalInvoice = GeneralInvoice.create(generalInput);

    // ── 2. Build public summary ─────────────────────────────────────────────
    const publicSummary = MajikInvoice._buildPublicSummary(generalInvoice);

    // ── 3. Canonical bytes for signing/hashing ──────────────────────────────
    const canonicalBytes = generalInvoice.toCanonicalBytes();
    const contentHash = sha256Hex(canonicalBytes);

    // ── 4. Build payload ────────────────────────────────────────────────────
    let payload: MajikInvoicePayload;

    if (mode === "encrypted-and-signed") {
      if (!recipients || recipients.length === 0) {
        throw new MajikInvoiceKeyError(
          "recipients are required when mode is 'encrypted-and-signed'.",
        );
      }

      payload = await buildEncryptedPayload(
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

    // ── 5. Build integrity block ────────────────────────────────────────────
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
      recipients: recipientPublicKeys,
      sentAt: undefined,
    });

    // ── 6. Sign immediately if signerKey provided ───────────────────────────
    if (signerKey) {
      return instance.sign(
        signerKey,
        expectedSigners ? { expectedSigners } : undefined,
      );
    }

    return instance;
  }

  // ── Invoice restart ──────────────────────────────────────────────────────

  /**
   * Restart the underlying invoice as a fresh draft envelope.
   *
   * Financial data, parties, line items, taxes, dates, references, notes, tags,
   * and metadata are preserved by the underlying `GeneralInvoice.restartInvoice`
   * operation.
   *
   * The resulting invoice:
   *
   * - has `draft` lifecycle status
   * - has all proof-of-payment records cleared
   * - has all signatures and seal state cleared
   * - must be signed again before it can be sealed
   *
   * Encrypted invoices must first be decrypted. The restarted result is
   * converted to `signed-only` mode.
   *
   * @param decryptKey - Required when the current invoice is encrypted.
   * @returns A restarted, unsigned `MajikInvoice`.
   * @throws {@link MajikInvoiceError} When an encrypted invoice is missing
   * the required decryption key.
   * @throws {@link MajikInvoiceKeyError} When the decryption key is invalid.
   * @throws {@link MajikInvoiceEncryptionError} When decryption fails.
   */
  async restartInvoice(decryptKey?: MajikKey): Promise<MajikInvoice> {
    let gi: GeneralInvoice;

    let finalInvoice: MajikInvoice = this;

    if (this.isEncrypted) {
      if (!decryptKey) {
        throw new MajikInvoiceError(
          "restartInvoice(): decryptKey is required for encrypted-and-signed invoices.",
        );
      }
      const decryptedResult = await this.decrypt(decryptKey);
      gi = decryptedResult.invoice;
      finalInvoice = decryptedResult.instance;
      finalInvoice = await finalInvoice.toSignedOnly(decryptKey, decryptKey, {
        dropSignatures: true,
      });
    } else {
      gi = this._requirePlaintextInvoice("restartInvoice");
    }

    const restarted = gi.restartInvoice();

    // Financial content is unchanged, so preserve the existing content hash.
    finalInvoice = finalInvoice._reissueFromMutation(restarted, {
      recomputeHash: false,
    });

    // Restart requires a completely fresh signature/seal state.
    const clearedIntegrity: IntegrityBlock = {
      ...finalInvoice.integrity,
      signatures: [],
      isSealed: false,
      sealInfo: undefined,
    };

    return finalInvoice.rebuild({ integrity: clearedIntegrity });
  }

  // ==========================================================================
  // ── METADATA & SETTLEMENT MUTATIONS
  // ==========================================================================

  /**
   * Set the cloud/user ownership identifier.
   *
   * @param userId - Non-empty user identifier.
   * @returns A new invoice with the updated user ID.
   * @throws {@link MajikInvoiceError} When `userId` is empty.
   */
  withUserId(userId: string): MajikInvoice {
    if (!userId?.trim()) {
      throw new MajikInvoiceError("userId cannot be empty.");
    }
    return this.rebuild({ userId: userId.trim() });
  }

  /**
   * Set the account identifier used by cloud routing/storage.
   *
   * @param accountId - Non-empty account identifier.
   * @returns A new invoice with the updated account ID.
   * @throws {@link MajikInvoiceError} When `accountId` is empty.
   */
  withAccountId(accountId: string): MajikInvoice {
    if (!accountId?.trim()) {
      throw new MajikInvoiceError("accountId cannot be empty.");
    }
    return this.rebuild({ accountId: accountId.trim() });
  }

  /**
   * Add a proof-of-payment record to the underlying invoice.
   *
   * Settlement state is recalculated by `GeneralInvoice`, then reflected in
   * the MajikInvoice envelope.
   *
   * @param proof - Payment proof to add.
   * @returns A new MajikInvoice with updated settlement state.
   * @throws Errors from underlying invoice payment validation.
   */
  addPayment(proof: ProofOfPayment): MajikInvoice {
    const invoice = this._requirePlaintextInvoice("addPayment");

    const updated = invoice.addPayment(proof);

    return this._reissueFromMutation(updated);
  }

  /**
   * Remove a proof-of-payment record.
   *
   * @param paymentId - ID of the payment proof to remove.
   * @returns A new MajikInvoice with recalculated settlement state.
   * @throws Errors from underlying invoice payment validation.
   */
  removePayment(paymentId: string): MajikInvoice {
    const invoice = this._requirePlaintextInvoice("removePayment");

    const updated = invoice.removePayment(paymentId);

    return this._reissueFromMutation(updated);
  }

  /**
   * Remove all payment records from the underlying invoice.
   *
   * @returns A new MajikInvoice with an empty payment history.
   * @throws Errors from underlying invoice settlement validation.
   */
  clearPayments(): MajikInvoice {
    const invoice = this._requirePlaintextInvoice("clearPayments");

    const updated = invoice.clearPayments();

    return this._reissueFromMutation(updated);
  }

  // ==========================================================================
  // ── GETTERS
  // ==========================================================================

  /**
   * Get the total amount recorded as paid.
   *
   * Returns `null` while an encrypted invoice remains locked because the
   * payment history is part of the private `GeneralInvoice`.
   *
   * @returns Total paid as `MajikMoney`, or `null` while encrypted and
   * undecrypted.
   */
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

  /**
   * Determine whether the invoice is fully settled.
   *
   * Returns `null` while an encrypted invoice remains locked because settlement
   * cannot be determined from the public summary alone.
   *
   * @returns `true`, `false`, or `null` when encrypted and locked.
   */
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

  /**
   * Get the derived payment settlement state.
   *
   * Returns `null` while an encrypted invoice remains locked.
   *
   * @returns Current {@link PaymentStatus}, or `null` when settlement data is
   * inaccessible.
   */
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

  /**
   * Get all recorded payment proofs.
   *
   * Returns `null` while an encrypted invoice is locked.
   *
   * @returns A copy of the payment-proof collection, or `null` when unavailable.
   */
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

  /**
   * Get the public issue date as a JavaScript `Date`.
   *
   * This getter reads from the always-plaintext public summary and therefore
   * does not require decryption.
   */
  get issueDate(): Date {
    const parsedDate: Date = new Date(this.public.issuedAt);
    return parsedDate;
  }

  /**
   * Get the public due date as a JavaScript `Date`.
   *
   * Returns `null` when no due date is present in the public summary.
   */
  get dueDate(): Date | null {
    if (!this.public.dueDate?.trim()) {
      return null;
    }
    const parsedDate: Date = new Date(this.public.dueDate);
    return parsedDate;
  }

  // ==========================================================================
  // ── MODE CONVERSION
  // ==========================================================================

  /**
   * Convert a signed-only invoice into an encrypted-and-signed invoice.
   *
   * The original invoice is not modified.
   *
   * By default, existing signatures and seal information are carried forward.
   * Set `dropSignatures: true` to intentionally clear the existing cryptographic
   * authorization state and require re-signing.
   *
   * When an allowlist override is supplied, signatures must be dropped because
   * existing signatures contain the previous allowlist commitment.
   *
   * Supplying `signerKey` optionally signs the converted envelope immediately.
   * When the signer is already represented in the preserved signature set,
   * no redundant signature operation is performed.
   *
   * @param recipients - ML-KEM recipients for the encrypted payload.
   * @param recipientPublicKeys - Optional public routing addresses for the recipients.
   * @param signerKey - Optional key used to sign the converted invoice immediately.
   * @param options - Signature/allowlist conversion controls.
   * @returns A new encrypted-and-signed invoice.
   * @throws {@link MajikInvoiceError} When already encrypted or when an
   * incompatible allowlist override is supplied.
   * @throws {@link MajikInvoiceKeyError} When recipient information or keys
   * are invalid.
   * @throws {@link MajikInvoiceEncryptionError} When encryption fails.
   */
  async toEncrypted(
    recipients: MajikRecipient[],
    recipientPublicKeys?: MajikKeyAddress[],
    signerKey?: MajikKey,
    options?: { dropSignatures?: boolean; expectedSigners?: ExpectedSigner[] },
  ): Promise<MajikInvoice> {
    if (this.mode === "encrypted-and-signed") {
      throw new MajikInvoiceError(
        "Invoice is already in 'encrypted-and-signed' mode.",
      );
    }

    const dropSignatures = options?.dropSignatures ?? false;

    // Existing signatures embed their allowlist hash, so an allowlist
    // override requires a fresh signature set.
    if (options?.expectedSigners && !dropSignatures) {
      throw new MajikInvoiceError(
        "toEncrypted(): expectedSigners override requires dropSignatures: true. " +
          "Existing signatures embed their own allowlistHash and cannot be rebound to a new allowlist.",
      );
    }

    const expectedSigners =
      options?.expectedSigners ?? this.integrity.expectedSigners;

    const generalInvoice = this._requirePlaintextInvoice("toEncrypted");
    const payload = await buildEncryptedPayload(
      generalInvoice,
      recipients,
      signerKey,
    );

    const now = new Date().toISOString();
    const integrity: IntegrityBlock = {
      contentHash: this.integrity.contentHash,
      hashAlgorithm: "SHA-256",
      signatures: dropSignatures ? [] : [...this.integrity.signatures],
      isSealed: dropSignatures ? false : this.integrity.isSealed,
      expectedSigners,
      allowlistSignerId: this.integrity.allowlistSignerId,
      ...(dropSignatures ? {} : { sealInfo: this.integrity.sealInfo }),
    };

    const converted = new MajikInvoice({
      id: this.id,
      mode: "encrypted-and-signed",
      public: this.public,
      payload,
      integrity,
      createdAt: this.createdAt,
      updatedAt: now,
      recipients: recipientPublicKeys,
      sentAt: this.sentAt,
      accountId: this.accountId,
      decrypted: this._decrypted,
      userId: this.userId,
    });

    if (signerKey) {
      // Avoid creating a redundant replacement signature when the same signer
      // already exists in the preserved signature collection.
      if (converted.hasSigned(signerKey)) return converted;

      return converted.sign(signerKey, { expectedSigners });
    }
    return converted;
  }

  /**
   * Convert an encrypted-and-signed invoice into a signed-only invoice.
   *
   * The original invoice remains untouched.
   *
   * Existing signatures and seal state are preserved by default. Setting
   * `dropSignatures: true` intentionally produces an unsigned plaintext
   * invoice that must be signed again.
   *
   * Because the underlying invoice must be decrypted first, an authorized
   * ML-KEM decryption key is required.
   *
   * @param decryptKey - Key used to decrypt the encrypted envelope.
   * @param signerKey - Optional key used to sign the resulting plaintext invoice.
   * @param options - Signature/allowlist conversion controls.
   * @returns A new signed-only invoice.
   * @throws {@link MajikInvoiceError} When already signed-only or when an
   * incompatible allowlist override is supplied.
   * @throws {@link MajikInvoiceKeyError} When the decryption key is unusable.
   * @throws {@link MajikInvoiceEncryptionError} When decryption fails.
   */
  async toSignedOnly(
    decryptKey: MajikKey,
    signerKey?: MajikKey,
    options?: { dropSignatures?: boolean; expectedSigners?: ExpectedSigner[] },
  ): Promise<MajikInvoice> {
    if (this.mode === "signed-only") {
      throw new MajikInvoiceError("Invoice is already in 'signed-only' mode.");
    }

    const { invoice } = await this.decrypt(decryptKey);
    const canonicalBytes = invoice.toCanonicalBytes();
    const contentHash = sha256Hex(canonicalBytes);

    const now = new Date().toISOString();
    const payload: SignedOnlyPayload = {
      kind: "signed-only",
      invoice: invoice.toJSON(),
    };

    const dropSignatures = options?.dropSignatures ?? false;

    // Existing signatures embed their allowlist hash, so an allowlist
    // override requires a fresh signature set.
    if (options?.expectedSigners && !dropSignatures) {
      throw new MajikInvoiceError(
        "toSignedOnly(): expectedSigners override requires dropSignatures: true. " +
          "Existing signatures embed their own allowlistHash and cannot be rebound to a new allowlist.",
      );
    }

    const expectedSigners =
      options?.expectedSigners ?? this.integrity.expectedSigners;

    const integrity: IntegrityBlock = {
      contentHash: contentHash,
      hashAlgorithm: "SHA-256",
      signatures: dropSignatures ? [] : [...this.integrity.signatures],
      isSealed: dropSignatures ? false : this.integrity.isSealed,
      expectedSigners: expectedSigners,
      allowlistSignerId: this.integrity.allowlistSignerId,
      ...(dropSignatures ? {} : { sealInfo: this.integrity.sealInfo }),
    };

    const converted = new MajikInvoice({
      id: this.id,
      mode: "signed-only",
      public: this.public,
      payload,
      integrity,
      createdAt: this.createdAt,
      updatedAt: now,
      sentAt: this.sentAt,
      accountId: this.accountId,
      decrypted: this._decrypted,
      recipients: this.recipients,
      userId: this.userId,
    });

    this.secureLock();

    if (signerKey) {
      if (converted.hasSigned(signerKey)) return converted;

      return converted.sign(signerKey, { expectedSigners: expectedSigners });
    }
    return converted;
  }

  // ==========================================================================
  // ── GETTERS
  // ==========================================================================

  /**
   * Get the cryptographic integrity posture of the invoice.
   *
   * Possible values include:
   *
   * - `unsigned` — no signatures exist
   * - `partially-signed` — signatures exist but the expected signer set is not complete
   * - `fully-signed` — all expected signers have signed
   * - `sealed` — invoice has been cryptographically sealed
   * - `invalid` — structural validation failed
   *
   * This describes cryptographic state and should not be confused with
   * {@link status}, which describes business/lifecycle state.
   */
  get integrityStatus(): MajikInvoiceStatus {
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

  /**
   * Get the current business/lifecycle status of the invoice.
   *
   * For encrypted invoices that are still locked, the value is taken from the
   * public summary because the underlying `GeneralInvoice` is inaccessible.
   *
   * This is intentionally separate from {@link integrityStatus}.
   */
  get status(): InvoiceStatus {
    return this.isLocked ? this.public.status : this.invoice.status;
  }

  /**
   * Get a human-readable presentation label for the cryptographic invoice state.
   *
   * This combines integrity posture with encryption state for UI display.
   */
  get displayStatus(): string {
    if (this.integrityStatus === "invalid") return "Invalid";
    if (this.integrityStatus === "unsigned") return "Unsigned";

    if (this.integrityStatus === "partially-signed") {
      return this.isEncrypted
        ? "Partially Signed (Encrypted)"
        : "Partially Signed";
    }

    if (this.integrityStatus === "fully-signed") {
      return this.isEncrypted ? "Fully Signed (Encrypted)" : "Fully Signed";
    }

    if (this.integrityStatus === "sealed") {
      return this.isEncrypted ? "Sealed (Encrypted)" : "Sealed";
    }

    return "Unknown";
  }

  /**
   * Whether this invoice uses the encrypted-and-signed payload mode.
   */
  get isEncrypted(): boolean {
    return this.mode === "encrypted-and-signed";
  }

  /**
   * Whether this invoice uses the signed-only plaintext mode.
   */
  get isSignedOnly(): boolean {
    return this.mode === "signed-only";
  }

  /**
   * Whether an encrypted invoice is currently locked.
   *
   * Signed-only invoices are never considered locked because their
   * `GeneralInvoice` payload is already available in plaintext.
   */
  get isLocked(): boolean {
    if (this.isSignedOnly) return false;

    return !this.decryptedInvoice || !this.decryptedCache;
  }

  /**
   * Whether at least one cryptographic signature is attached.
   */
  get isSigned(): boolean {
    return this.integrity.signatures.length > 0;
  }

  /**
   * Whether the invoice is sealed against further signatures.
   */
  get isSealed(): boolean {
    return this.integrity.isSealed;
  }

  /**
   * Number of signatures currently attached to the invoice.
   */
  get signatureCount(): number {
    return this.integrity.signatures.length;
  }

  /**
   * Get the fingerprints of all signers currently represented in the signature set.
   */
  get signerIds(): string[] {
    return this.integrity.signatures.map((s) => s.signerId);
  }

  /**
   * Whether a runtime decrypted cache currently exists.
   *
   * This does not indicate whether the cached plaintext is persisted—it is
   * intentionally runtime-only.
   */
  get hasDecryptedCache(): boolean {
    return this._decrypted !== undefined;
  }

  /**
   * Get the cached decrypted {@link GeneralInvoice}, when available.
   *
   * Returns `undefined` when no decrypted cache exists.
   */
  get decryptedInvoice(): GeneralInvoice | undefined {
    return this._decrypted?.invoice;
  }

  /**
   * Get decrypted cache metadata.
   *
   * This can be used to inspect who decrypted the invoice and when.
   */
  get decryptedCache(): DecryptedCache | undefined {
    return this._decrypted;
  }

  /**
   * Get the SHA-256 content commitment for the underlying invoice.
   *
   * This is the hash stored in the integrity block and used as the basis for
   * signature input.
   */
  get hash(): string {
    return this.integrity.contentHash;
  }

  /**
   * Access the underlying plaintext {@link GeneralInvoice}.
   *
   * In signed-only mode the plaintext payload can be reconstructed directly.
   *
   * In encrypted-and-signed mode, the invoice is available only when a
   * successful decryption has populated the runtime cache.
   *
   * @throws {@link MajikInvoiceError} When the invoice is encrypted and has
   * not yet been decrypted.
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

  /**
   * Alias for the always-plaintext public invoice summary.
   */
  get summary(): PublicInvoiceSummary {
    return this.public;
  }

  /**
   * Reissue the invoice after a genuine business/financial modification.
   *
   * A reissue represents changed source content, so the resulting invoice
   * receives a new canonical content commitment and all previous signatures
   * are discarded.
   *
   * For encrypted invoices, a new recipient list and recipient routing keys
   * are required because the modified payload must be encrypted again.
   *
   * The original invoice is not modified.
   *
   * @param updatedInvoice - Modified underlying GeneralInvoice.
   * @param options - Optional signing, recipient, allowlist, and routing inputs.
   * @returns Newly reissued MajikInvoice.
   * @throws {@link MajikInvoiceKeyError} When encrypted reissuance lacks
   * required recipients or routing keys.
   * @throws {@link MajikInvoiceEncryptionError} When re-encryption fails.
   * @throws {@link MajikInvoiceSignatureError} When signing is requested and fails.
   */
  async reissue(
    updatedInvoice: GeneralInvoice,
    options: {
      signerKey?: MajikKey;
      recipients?: MajikRecipient[];
      expectedSigners?: ExpectedSigner[];
      recipientPublicKeys?: MajikKeyAddress[];
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
      assertKeyUnlocked(options.signerKey, "reissue");
      assertKeyHasSigningKeys(options.signerKey, "reissue");
    }

    let reissued: MajikInvoice;

    if (this.mode === "encrypted-and-signed") {
      if (
        !options?.recipientPublicKeys ||
        options.recipientPublicKeys.length === 0
      ) {
        throw new MajikInvoiceKeyError(
          "recipientPublicKeys are required to reissue an encrypted-and-signed invoice.",
        );
      }

      const publicSummary = MajikInvoice._buildPublicSummary(updatedInvoice);
      const contentHash = sha256Hex(updatedInvoice.toCanonicalBytes());
      const payload = await buildEncryptedPayload(
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
      reissued = this.rebuild({
        id: updatedInvoice.id,
        mode: this.mode,
        public: publicSummary,
        payload,
        integrity,
        createdAt: this.createdAt,
        updatedAt: new Date().toISOString(),
        recipients: options.recipientPublicKeys || this.recipients,
        userId: this.userId,
        accountId: this.accountId,
      });
    } else {
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

  /**
   * Internal recipient-side mutation pipeline shared by `receive()` and
   * `countersign()`.
   *
   * The method enforces recipient authorization before rebuilding the invoice.
   *
   * Common invariants include:
   *
   * - the invoice must not be sealed
   * - an expected-signer allowlist must exist
   * - the signer must be on that allowlist
   * - the issuer cannot use the recipient mutation path
   * - the updated invoice must retain the same invoice ID
   *
   * For encrypted invoices the updated payload is re-encrypted before the
   * recipient signature is appended.
   *
   * @param updatedInvoice - Mutated underlying GeneralInvoice.
   * @param options - Authorized recipient signing and, when required,
   * re-encryption participants.
   * @returns A new MajikInvoice containing the recipient mutation/signature.
   * @internal
   */
  private async _receiveBase(
    updatedInvoice: GeneralInvoice,
    options: {
      signerKey: MajikKey;
      recipients?: MajikRecipient[];
    },
  ): Promise<MajikInvoice> {
    const { signerKey, recipients } = options;

    // ── 1. Key assertions ────────────────────────────────────────────────────
    assertKeyUnlocked(signerKey, "receive");
    assertKeyHasSigningKeys(signerKey, "receive");

    // ── 2. Sealed invoices are immutable ─────────────────────────────────────
    if (this.integrity.isSealed) {
      throw new MajikInvoiceSealError(
        "Cannot call receive() on a sealed invoice. Sealed invoices are immutable.",
      );
    }

    // ── 3. Allowlist must exist ───────────────────────────────────────────────
    if (
      !this.integrity.expectedSigners ||
      this.integrity.expectedSigners.length === 0
    ) {
      throw new MajikInvoiceSignatureError(
        "receive() requires an expectedSigners allowlist. " +
          "The issuer must establish the allowlist when creating the invoice.",
      );
    }

    // ── 4. Issuer is never permitted — enforced regardless of mode ────────────
    if (
      this.integrity.allowlistSignerId &&
      this.integrity.allowlistSignerId === signerKey.fingerprint
    ) {
      throw new MajikInvoiceSignatureError(
        `receive(): key "${signerKey.fingerprint}" is the issuer of this invoice. ` +
          "Issuers must use reissue() for mutations, not receive().",
      );
    }

    // ── 5. Signer must be on the allowlist ───────────────────────────────────
    const isAllowed = this.integrity.expectedSigners.some(
      (es) => es.signerId === signerKey.fingerprint,
    );
    if (!isAllowed) {
      throw new MajikInvoiceSignatureError(
        `receive(): key "${signerKey.fingerprint}" is not on the allowlist for this invoice. ` +
          `Allowed signers: [${this.integrity.expectedSigners.map((s) => s.signerId).join(", ")}].`,
      );
    }

    // ── 6. Updated invoice must share the same id ────────────────────────────
    if (updatedInvoice.id !== this.id) {
      throw new MajikInvoiceError(
        `receive(): updatedInvoice.id ("${updatedInvoice.id}") does not match ` +
          `this invoice's id ("${this.id}"). You must mutate the same invoice.`,
      );
    }

    // ── 7. Build the updated instance depending on mode ──────────────────────

    let rebuilt: MajikInvoice;

    if (this.mode === "encrypted-and-signed") {
      // ML-KEM capability is required for the encrypted recipient path.
      assertKeyHasMlKem(signerKey, "receive");

      if (!this.canDecrypt(signerKey)) {
        throw new MajikInvoiceEncryptionError(
          `receive(): key "${signerKey.fingerprint}" is not a recipient of this ` +
            "invoice's encrypted envelope and cannot decrypt it.",
        );
      }

      if (!recipients || recipients.length === 0) {
        throw new MajikInvoiceKeyError(
          "receive(): recipients are required for re-encryption on an " +
            "encrypted-and-signed invoice.",
        );
      }

      // Validate recipient access by successfully decrypting the existing envelope.
      await this.decrypt(signerKey);

      const newPayload = await buildEncryptedPayload(
        updatedInvoice,
        recipients,
      );

      const newPublic = MajikInvoice._buildPublicSummary(updatedInvoice);

      // Preserve the issuer-established integrity/signing configuration.
      const newIntegrity: IntegrityBlock = {
        contentHash: this.integrity.contentHash,
        hashAlgorithm: this.integrity.hashAlgorithm,
        signatures: [...this.integrity.signatures],
        isSealed: this.integrity.isSealed,
        expectedSigners: this.integrity.expectedSigners,
        allowlistSignerId: this.integrity.allowlistSignerId,
        sealInfo: this.integrity.sealInfo,
      };

      rebuilt = new (this.constructor as typeof MajikInvoice)({
        id: this.id,
        mode: "encrypted-and-signed",
        userId: this.userId,
        accountId: this.accountId,
        public: newPublic,
        payload: newPayload,
        integrity: newIntegrity,
        createdAt: this.createdAt,
        updatedAt: new Date().toISOString(),
        recipients: this.recipients,
      } as MajikInvoiceConstructorOptions);
    } else {
      // Plaintext recipient path. Existing integrity/signature state is retained.
      rebuilt = this._reissueFromMutation(updatedInvoice, {
        recomputeHash: false,
      });
    }

    // Append or replace the recipient's signature.
    return rebuilt.sign(signerKey);
  }

  /**
   * Recipient-side mutation workflow for encrypted invoices.
   *
   * Requires an `encrypted-and-signed` invoice and an expected-signer allowlist.
   * The recipient decrypts, applies the updated GeneralInvoice, re-encrypts the
   * payload for the supplied participant set, and adds their signature.
   *
   * @param updatedInvoice - Updated underlying GeneralInvoice.
   * @param options - Recipient signing key and full re-encryption recipient set.
   * @returns A new encrypted-and-signed MajikInvoice.
   * @throws {@link MajikInvoiceError} When used with a signed-only invoice.
   * @throws {@link MajikInvoiceKeyError} When required keys/recipients are missing.
   * @throws {@link MajikInvoiceEncryptionError} When decryption/re-encryption fails.
   * @throws {@link MajikInvoiceSignatureError} When recipient authorization fails.
   */
  async receive(
    updatedInvoice: GeneralInvoice,
    options: {
      signerKey: MajikKey;
      recipients: MajikRecipient[];
    },
  ): Promise<MajikInvoice> {
    if (this.mode !== "encrypted-and-signed") {
      throw new MajikInvoiceError(
        'receive() requires an "encrypted-and-signed" invoice. ' +
          "Recipients never interact with plaintext invoices at the transport layer. " +
          "For signed-only use cases call _receiveBase() directly.",
      );
    }

    return this._receiveBase(updatedInvoice, options);
  }

  /**
   * Recipient-side signing workflow for signed-only invoices.
   *
   * This is the plaintext counterpart to {@link GeneralInvoice.receive}.
   * It applies the same recipient/allowlist protections without performing
   * envelope re-encryption.
   *
   * @param updatedInvoice - Updated underlying GeneralInvoice.
   * @param signerKey - Authorized recipient signing key.
   * @returns A new signed-only MajikInvoice containing the recipient signature.
   * @throws {@link MajikInvoiceError} When the invoice is encrypted.
   * @throws {@link MajikInvoiceSignatureError} When recipient authorization fails.
   */
  async countersign(
    updatedInvoice: GeneralInvoice,
    signerKey: MajikKey,
  ): Promise<MajikInvoice> {
    if (this.mode !== "signed-only") {
      throw new MajikInvoiceError(
        'countersign() requires a "signed-only" invoice. ' +
          "For encrypted-and-signed invoices use receive() instead.",
      );
    }

    return this._receiveBase(updatedInvoice, { signerKey });
  }

  // ==========================================================================
  // ── MODE SETTING
  // ==========================================================================

  /**
   * Convert this invoice between supported payload modes.
   *
   * Use this as the general-purpose mode conversion API.
   *
   * Conversions:
   *
   * - signed-only → encrypted-and-signed
   *   Requires recipients and recipient public routing keys.
   *
   * - encrypted-and-signed → signed-only
   *   Requires a decryption key.
   *
   * Optional signing can be performed immediately after conversion.
   *
   * @param targetMode - Desired invoice payload mode.
   * @param options - Conversion, encryption, decryption, signing, allowlist,
   * and routing configuration.
   * @returns A new invoice in the requested mode.
   * @throws {@link MajikInvoiceError} When the invoice is already in the target mode.
   * @throws {@link MajikInvoiceKeyError} When conversion prerequisites are missing.
   * @throws {@link MajikInvoiceEncryptionError} When conversion requires
   * encryption/decryption and the cryptographic operation fails.
   */
  async setMode(
    targetMode: MajikInvoiceMode,
    options: {
      recipients?: MajikRecipient[];
      decryptKey?: MajikKey;
      signerKey?: MajikKey;
      expectedSigners?: ExpectedSigner[];
      recipientPublicKeys?: MajikKeyAddress[];
      dropSignatures?: boolean;
    } = {},
  ): Promise<MajikInvoice> {
    if (this.mode === targetMode) {
      throw new MajikInvoiceError(
        `Invoice is already in "${targetMode}" mode.`,
      );
    }

    const dropSignatures = options.dropSignatures ?? false;

    if (targetMode === "encrypted-and-signed") {
      if (!options.recipients || options.recipients.length === 0) {
        throw new MajikInvoiceKeyError(
          `recipients are required when converting to "encrypted-and-signed" mode.`,
        );
      }

      if (
        !options.recipientPublicKeys ||
        options.recipientPublicKeys.length === 0
      ) {
        throw new MajikInvoiceKeyError(
          `recipientPublicKeys are required when converting to "encrypted-and-signed" mode.`,
        );
      }

      return this.toEncrypted(
        options.recipients,
        options.recipientPublicKeys,
        options.signerKey,
        {
          dropSignatures: dropSignatures,
          expectedSigners: dropSignatures ? options.expectedSigners : undefined,
        },
      );
    }

    // targetMode === "signed-only"
    if (this.mode === "encrypted-and-signed") {
      if (!options.decryptKey) {
        throw new MajikInvoiceKeyError(
          `decryptKey is required when converting from "encrypted-and-signed" to "signed-only".`,
        );
      }

      return this.toSignedOnly(options.decryptKey, options.signerKey, {
        dropSignatures: dropSignatures,
        expectedSigners: dropSignatures ? options.expectedSigners : undefined,
      });
    }

    throw new MajikInvoiceError(`Unrecognised target mode "${targetMode}".`);
  }

  // ── Quick-access wrappers ─────────────────────────────────────────────────

  /**
   * Convenience wrapper for converting the invoice to encrypted-and-signed mode.
   *
   * @param recipients - ML-KEM recipients for the encrypted payload.
   * @param signerKey - Optional key used to sign immediately.
   * @returns A new encrypted-and-signed invoice.
   */
  async encrypt(
    recipients: MajikRecipient[],
    signerKey?: MajikKey,
  ): Promise<MajikInvoice> {
    return this.toEncrypted(recipients, this.recipients, signerKey);
  }

  /**
   * Convenience wrapper for converting the invoice to signed-only mode.
   *
   * The unusual method name is retained for API compatibility.
   *
   * @param decryptKey - Key used to decrypt the current encrypted payload.
   * @param signerKey - Optional key used to sign the resulting plaintext invoice.
   * @returns A new signed-only invoice.
   */
  async decrypt_mode(
    decryptKey: MajikKey,
    signerKey?: MajikKey,
  ): Promise<MajikInvoice> {
    return this.setMode("signed-only", { decryptKey, signerKey });
  }

  // ==========================================================================
  // ── ENCRYPTION & DECRYPTION
  // ==========================================================================

  /**
   * Attach a decrypted GeneralInvoice to the runtime cache of a rebuilt instance.
   *
   * The cached plaintext is intentionally runtime-only and is not serialized
   * into the persisted envelope.
   *
   * @param invoice - Decrypted GeneralInvoice to cache.
   * @param decryptedBy - Fingerprint of the key used to decrypt it.
   * @returns A new MajikInvoice containing the runtime decrypted cache.
   * @internal
   */
  withDecryptedCache(
    invoice: GeneralInvoice,
    decryptedBy: string,
  ): MajikInvoice {
    return this.rebuild({
      decrypted: {
        invoice,
        decryptedAt: new Date().toISOString(),
        decryptedBy,
      },
    });
  }

  /**
   * Decrypt an encrypted invoice using an authorized MajikKey.
   *
   * Successful decryption creates a runtime cache so subsequent access to
   * `.invoice` can reuse the decrypted GeneralInvoice without repeating the
   * envelope decryption operation for the same key.
   *
   * The returned `instance` contains the cached runtime state.
   *
   * Signed-only invoices are not decryptable because their payload is already
   * plaintext.
   *
   * @param key - Unlocked MajikKey containing the required ML-KEM secret key.
   * @returns Decrypted invoice plus the instance carrying its runtime cache.
   * @throws {@link MajikInvoiceError} When the invoice is signed-only.
   * @throws {@link MajikInvoiceKeyError} When the key is locked or lacks ML-KEM.
   * @throws {@link MajikInvoiceEncryptionError} When decryption fails.
   */
  async decrypt(key: MajikKey): Promise<InvoiceDecryptionResult> {
    if (this.mode === "signed-only") {
      throw new MajikInvoiceError(
        "Invoice is not encrypted (mode: 'signed-only'). Access .invoice directly.",
      );
    }

    // Return cached result when this exact key already decrypted the invoice.
    if (this._decrypted && this._decrypted.decryptedBy === key.fingerprint) {
      return {
        instance: this,
        invoice: this._decrypted.invoice,
      };
    }

    assertKeyUnlocked(key, "decrypt");
    assertKeyHasMlKem(key, "decrypt");

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

      const stamped = this.withDecryptedCache(generalInvoice, key.fingerprint);
      return { invoice: generalInvoice, instance: stamped };
    } catch (err) {
      if (err instanceof MajikInvoiceError) throw err;
      throw new MajikInvoiceEncryptionError(
        "Decryption failed — wrong key, corrupted envelope, or key is not a recipient.",
        err,
      );
    }
  }

  /**
   * Clear the in-memory decrypted invoice cache.
   *
   * This does not modify the serialized payload, signatures, or integrity
   * metadata. It only removes runtime plaintext from the current instance.
   *
   * For encrypted invoices, subsequent `.invoice` access requires another
   * successful call to {@link decrypt}.
   *
   * @returns Nothing.
   */
  clearDecryptedCache(): void {
    this._decrypted = undefined;
  }

  /**
   * Check whether a key appears in the encrypted envelope's recipient list.
   *
   * This performs a fingerprint membership check only. It does not attempt
   * actual decryption and therefore does not prove that the key can successfully
   * decrypt the payload.
   *
   * Signed-only invoices always return `false`.
   *
   * @param key - Candidate decryption key.
   * @returns `true` when the key fingerprint appears among the envelope recipients.
   */
  canDecrypt(key: MajikKey): boolean {
    if (this.mode === "signed-only") return false;
    const ep = this.payload as EncryptedPayload;
    return ep.recipientFingerprints.includes(key.fingerprint);
  }

  // ==========================================================================
  // ── SIGNING
  // ==========================================================================

  /**
   * Add or replace a signature from a MajikKey.
   *
   * The signature is created over the invoice's canonical content commitment,
   * not over the encrypted envelope bytes themselves.
   *
   * When an `expectedSigners` allowlist is supplied for an unsigned invoice,
   * the allowlist becomes part of the signature metadata and the first signer
   * establishes the issuer identity.
   *
   * Signing the same key again replaces that signer's existing signature entry.
   *
   * A sealed invoice cannot be signed.
   *
   * @param key - Unlocked MajikKey with signing capabilities.
   * @param options - Optional expected-signer allowlist and signature timestamp.
   * @returns A new MajikInvoice containing the signature.
   * @throws {@link MajikInvoiceKeyError} When the key is locked or has no signing keys.
   * @throws {@link MajikInvoiceSealError} When the invoice is sealed.
   * @throws {@link MajikInvoiceSignatureError} When signer authorization or
   * signature creation fails.
   */
  async sign(
    key: MajikKey,
    options?: {
      expectedSigners?: ExpectedSigner[];
      timestamp?: string;
    },
  ): Promise<MajikInvoice> {
    assertKeyUnlocked(key, "sign");
    assertKeyHasSigningKeys(key, "sign");

    if (this.integrity.isSealed) {
      throw new MajikInvoiceSealError(
        "Cannot sign a sealed invoice. Sealed invoices are immutable.",
      );
    }

    // Existing allowlists restrict signing membership.
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

    // Sign the canonical identity/content commitment.
    const contentBytes = await canonicalBytesForSigning(
      this.integrity.contentHash,
      this.id,
    );

    // Expected signer configuration is committed into the signature metadata.
    let allowlistHash: string | undefined;
    const signers = options?.expectedSigners ?? this.integrity.expectedSigners;
    if (signers && signers.length > 0) {
      allowlistHash = computeAllowlistHash(signers);
    }

    try {
      const sigJSON = await createSignatureJSON(contentBytes, key, {
        timestamp: options?.timestamp,
        allowlistHash,
      });

      // Replace the existing signature from the same signer, or append a new one.
      const existingIdx = this.integrity.signatures.findIndex(
        (s) => s.signerId === key.fingerprint,
      );
      const newSignatures = [...this.integrity.signatures];
      if (existingIdx >= 0) {
        newSignatures[existingIdx] = sigJSON;
      } else {
        newSignatures.push(sigJSON);
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
   * Cryptographically seal the invoice.
   *
   * Sealing marks the current signature set as final and prevents subsequent
   * signatures from being added.
   *
   * When an allowlist issuer exists, only that issuer may seal. Without an
   * explicit issuer identity, the key must already be one of the invoice's
   * signers.
   *
   * The resulting seal contains:
   *
   * - signer identity of the sealer
   * - seal timestamp
   * - SHA3-512 seal hash over the current signature set and timestamp
   *
   * @param key - Key authorized to seal the invoice.
   * @param options - Optional explicit seal timestamp.
   * @returns A new sealed MajikInvoice.
   * @throws {@link MajikInvoiceKeyError} When the key is locked.
   * @throws {@link MajikInvoiceSealError} When already sealed or the caller is
   * not authorized to seal.
   * @throws {@link MajikInvoiceSignatureError} When no signatures exist.
   */
  async seal(
    key: MajikKey,
    options?: { timestamp?: string },
  ): Promise<MajikInvoice> {
    assertKeyUnlocked(key, "seal");

    if (this.integrity.isSealed) {
      throw new MajikInvoiceSealError("Invoice is already sealed.");
    }

    if (this.integrity.signatures.length === 0) {
      throw new MajikInvoiceSignatureError(
        "Cannot seal an unsigned invoice. At least one signature is required.",
      );
    }

    // An established allowlist issuer has exclusive sealing authority.
    if (
      this.integrity.allowlistSignerId &&
      this.integrity.allowlistSignerId !== key.fingerprint
    ) {
      throw new MajikInvoiceSealError(
        `Only the issuer ("${this.integrity.allowlistSignerId}") may seal this invoice. ` +
          `Provided key fingerprint: "${key.fingerprint}".`,
      );
    }

    // Without a designated issuer, the sealer must already be a signer.
    if (
      !this.integrity.allowlistSignerId &&
      !this.integrity.signatures.some((s) => s.signerId === key.fingerprint)
    ) {
      throw new MajikInvoiceSealError(
        `Key "${key.fingerprint}" has not signed this invoice and cannot seal it.`,
      );
    }

    const sealTimestamp = options?.timestamp ?? new Date().toISOString();

    // Seal hash covers full signature information for tamper evidence.
    const sealHash = await computeSealHashAsync(
      this.integrity.signatures,
      sealTimestamp,
    );

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
  // ── SIGNATURE VERIFICATION
  // ==========================================================================

  /**
   * Verify every signature currently attached to the invoice.
   *
   * One verification result is returned for each signature, preserving the
   * signature collection's order.
   *
   * Signature verification validates the signature over the canonical content
   * commitment; it does not by itself validate the entire invoice structure.
   *
   * @returns One {@link VerificationResult} per signature.
   * @throws {@link MajikInvoiceSignatureError} When the invoice has no signatures.
   */
  async verifySignatures(): Promise<VerificationResult[]> {
    if (this.integrity.signatures.length === 0) {
      throw new MajikInvoiceSignatureError(
        "No signatures to verify on this invoice.",
      );
    }

    const contentBytes = await canonicalBytesForSigning(
      this.integrity.contentHash,
      this.id,
    );

    const results: VerificationResult[] = [];

    for (const sigJSON of this.integrity.signatures) {
      try {
        const result = verifySignatureJSON(sigJSON, contentBytes);
        results.push(result);
      } catch (err) {
        results.push({
          valid: false,
          signerId: sigJSON.signerId,
          contentHash: sigJSON.contentHash,
          timestamp: sigJSON.timestamp,
          reason: `Verification threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return results;
  }

  /**
   * Verify the signature belonging to one specific signer.
   *
   * @param signerId - Fingerprint of the signer whose signature should be verified.
   * @returns Verification result for the requested signer.
   * @throws {@link MajikInvoiceSignatureError} When no signature from the
   * specified signer exists or verification fails.
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

    const contentBytes = await canonicalBytesForSigning(
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
   * Verify the invoice seal hash.
   *
   * This verifies that the current signature set still matches the hash
   * embedded in `sealInfo`.
   *
   * It does not independently verify each signature; use
   * {@link verifySignatures} for that.
   *
   * @returns Seal verification result.
   *
   * A non-sealed invoice returns an invalid result with the reason
   * `"Invoice is not sealed."`.
   */
  async verifySeal(): Promise<SealVerificationResult> {
    if (!this.integrity.isSealed || !this.integrity.sealInfo) {
      return {
        valid: false,
        reason: "Invoice is not sealed.",
      } as SealVerificationResult;
    }

    const info = this.integrity.sealInfo;
    const recomputedHash = await computeSealHashAsync(
      this.integrity.signatures,
      info.sealTimestamp,
    );

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
  // ── CAPABILITY CHECKS
  // ==========================================================================

  /**
   * Determine whether a key is currently permitted to sign the invoice.
   *
   * The check considers:
   *
   * - whether the invoice is sealed
   * - whether the key has signing keys
   * - whether the key is unlocked
   * - whether an expected-signer allowlist exists
   * - whether the key is included in that allowlist
   *
   * This is a capability preflight check and does not perform signing.
   *
   * @param key - Candidate signing key.
   * @returns Object containing permission state and, when denied, a reason.
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
   * Determine whether a key is currently permitted to seal the invoice.
   *
   * The check considers:
   *
   * - whether the invoice is already sealed
   * - whether at least one signature exists
   * - whether the key is unlocked
   * - whether a designated issuer exists
   * - whether the candidate key is that issuer or an existing signer
   *
   * @param key - Candidate sealing key.
   * @returns Object containing permission state and, when denied, a reason.
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
   * Check whether a specific key already has a signature on the invoice.
   *
   * @param key - Candidate signer.
   * @returns `true` when the key fingerprint appears in the signature set.
   */
  hasSigned(key: MajikKey): boolean {
    return this.integrity.signatures.some(
      (s) => s.signerId === key.fingerprint,
    );
  }

  /**
   * Get expected signers who have not yet signed.
   *
   * When no allowlist exists, the result is an empty array.
   *
   * @returns Expected signer entries that are still pending.
   */
  get pendingSigners(): ExpectedSigner[] {
    if (!this.integrity.expectedSigners) return [];
    return this.integrity.expectedSigners.filter(
      (es) =>
        !this.integrity.signatures.some((s) => s.signerId === es.signerId),
    );
  }

  /**
   * Determine whether the invoice has satisfied its expected signing set.
   *
   * When no explicit allowlist exists, at least one signature is sufficient
   * to report a fully signed state.
   *
   * @returns `true` when the invoice has reached its expected signer state.
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
  // ── VALIDATION
  // ==========================================================================

  /**
   * Validate the structural integrity of the MajikInvoice envelope.
   *
   * This checks envelope structure and required fields but does **not**
   * cryptographically verify attached signatures.
   *
   * Use {@link verifySignatures} and {@link verifySeal} for cryptographic
   * verification.
   *
   * @returns Structural validation result containing validity and field errors.
   */
  validate(): MajikInvoiceValidationResult {
    return this._validateStructure();
  }

  /**
   * Perform internal structural validation of the envelope.
   *
   * Validation covers:
   *
   * - invoice ID
   * - supported mode
   * - public summary fields
   * - mode-specific payload structure
   * - integrity content hash
   * - supported hash algorithm
   * - seal metadata requirements
   *
   * @returns Structural validation result.
   * @internal
   */
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
      errors.push({
        field: "payload",
        message: "Payload is required",
      });
    } else {
      const payloadKind = this.payload.kind;

      if (
        payloadKind !== "signed-only" &&
        payloadKind !== "encrypted-and-signed"
      ) {
        errors.push({
          field: "payload.kind",
          message: `Unsupported payload kind: "${String(payloadKind)}"`,
        });
      } else {
        if (payloadKind !== this.mode) {
          errors.push({
            field: "payload.kind",
            message: `Payload kind "${payloadKind}" does not match invoice mode "${this.mode}"`,
          });
        }

        if (payloadKind === "signed-only") {
          if (!this.payload.invoice) {
            errors.push({
              field: "payload.invoice",
              message: "Invoice JSON is required for signed-only mode",
            });
          }
        }

        if (payloadKind === "encrypted-and-signed") {
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
   * Remove the runtime decrypted cache from memory.
   *
   * For encrypted invoices this returns the instance to a locked state.
   *
   * This does not modify serialized invoice data.
   *
   * @returns The current instance for convenient chaining.
   */
  secureLock(): this {
    if (this.mode === "encrypted-and-signed") {
      this._decrypted = undefined;
    }

    return this;
  }

  // ==========================================================================
  // ── BATCH OPERATIONS
  // ==========================================================================

  /**
   * Decrypt multiple invoices concurrently.
   *
   * Signed-only invoices pass through unchanged.
   * Encrypted invoices are decrypted using the supplied key when the key is
   * listed as an envelope recipient.
   *
   * Individual failures are collected instead of aborting the entire batch.
   *
   * @param invoices - Invoices to process.
   * @param key - Unlocked key authorized to decrypt applicable invoices.
   * @returns Batch decryption result with successes and individual failures.
   */
  static async batchDecrypt(
    invoices: MajikInvoice[],
    key: MajikKey,
  ): Promise<BatchDecryptResult> {
    const errors: BatchDecryptResult["errors"] = [];

    const results = await Promise.allSettled(
      invoices.map(async (inv) => {
        if (inv.mode === "signed-only") return inv;
        if (inv.hasDecryptedCache) return inv;
        if (!inv.canDecrypt(key)) {
          throw new Error(
            `Key "${key.fingerprint}" is not a recipient of this invoice.`,
          );
        }
        const { instance } = await inv.decrypt(key);
        return instance;
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
   * Clear the decrypted runtime cache from every encrypted invoice in a batch.
   *
   * Signed-only invoices are counted as skipped because they do not maintain
   * an encrypted runtime cache.
   *
   * @param invoices - Invoices whose runtime plaintext should be cleared.
   * @returns Counts of locked and skipped invoices.
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
   * Detect invoices whose due dates have passed and mark them as overdue.
   *
   * Signed-only and already-decrypted encrypted invoices can be evaluated
   * immediately.
   *
   * Encrypted invoices may optionally be decrypted with `decryptKey`.
   * When decryption is unavailable:
   *
   * - `strict: false` records the invoice as skipped
   * - `strict: true` throws instead
   *
   * Marked invoices are returned as new MajikInvoice instances. Persistence
   * and any subsequent re-signing are the caller's responsibility.
   *
   * @param invoices - Invoices to inspect.
   * @param options - Strictness and optional decryption key.
   * @returns Overdue processing result.
   * @throws {@link MajikInvoiceKeyError} In strict mode when encrypted invoice
   * access fails.
   * @throws {@link MajikInvoiceError} In strict mode when encrypted access is
   * unavailable.
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
        // Attempt decrypt — skip if this key is not authorized.
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
          const { invoice } = await inv.decrypt(decryptKey);
          gi = invoice;
        } catch (error) {
          if (strict) throw error;
          skipped.push({ invoiceId: inv.id, reason: "encrypted" });
          continue;
        }
      } else {
        // Encrypted but no decryption key was supplied.
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

      // ── 4. Mark overdue after explicitly validating the date condition ─────
      const updatedGi = gi.markAsOverdue(true);

      // Rebuild the MajikInvoice shell. Financial content is unchanged,
      // so the existing content commitment can be carried forward.
      const updatedMajik = inv._reissueFromMutation(updatedGi);
      marked.push(updatedMajik);
    }

    return { marked, skipped };
  }

  // ==========================================================================
  // ── DASHBOARD STATISTICS
  // ==========================================================================

  /**
   * Calculate aggregate dashboard statistics across a collection of invoices.
   *
   * The method is designed to operate on mixed locked/unlocked collections.
   *
   * For encrypted invoices without a decrypted cache:
   *
   * - public-summary metrics remain available
   * - detailed financial metrics requiring `GeneralInvoice` are omitted from
   *   the detailed aggregation
   *
   * @param invoices - Invoice collection to analyze.
   * @param options - Dashboard calculation options.
   * @returns Aggregate invoice statistics.
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
    let weightedTaxRate = 0;
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
      // Detailed financials are available only when the inner invoice
      // can currently be reconstructed in plaintext.
      let gi: GeneralInvoice | null = null;
      try {
        if (inv.mode === "signed-only" || inv.hasDecryptedCache) {
          gi = inv.invoice;
        }
      } catch {
        gi = null;
      }

      const pub = inv.public;
      const invStatus = gi ? gi.effectiveStatus : (pub.status ?? "draft");
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
      if (inv.integrityStatus === "unsigned") unsignedCount++;
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

        // Days from issue date to first recorded payment.
        if (gi.proofOfPayments.length > 0 && gi.issueDate) {
          const issueMs = new Date(gi.issueDate).getTime();
          const firstPayMs = new Date(
            gi.proofOfPayments[0].settledAt,
          ).getTime();
          const days = (firstPayMs - issueMs) / 86_400_000;
          if (days >= 0) daysToPaymentList.push(days);
        }

        // Aggregate additive taxes by type.
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
  // ── BINARY
  // ==========================================================================

  /**
   * Serialize the complete MajikInvoice into the compact MJKI binary format.
   *
   * The binary container consists of:
   *
   * 1. MJKI magic bytes
   * 2. binary format version
   * 3. reserved/flag bytes
   * 4. big-endian JSON payload length
   * 5. UTF-8 encoded JSON payload
   *
   * The underlying invoice data remains the same as {@link toJSON}; this
   * method changes only the transport representation.
   *
   * @returns Binary invoice envelope as an `ArrayBuffer`.
   */
  toBinary(): ArrayBuffer {
    const json = encoder.encode(JSON.stringify(this.toJSON()));

    const buffer = new Uint8Array(MJKI_HEADER_SIZE + json.length);
    const view = new DataView(buffer.buffer);

    // ── Magic ─────────────────────────────
    buffer.set(MJKI_MAGIC, 0);

    // ── Version ──────────────────────────
    buffer[4] = MJKI_VERSION;

    // ── Reserved flags (future use) ───────
    buffer[5] = this.isEncrypted ? 1 : 0;
    buffer[6] = 0;
    buffer[7] = 0;

    // ── Length ────────────────────────────
    view.setUint32(8, json.length, false);

    // ── Payload ───────────────────────────
    buffer.set(json, MJKI_HEADER_SIZE);

    return buffer.buffer;
  }

  /**
   * Parse a MajikInvoice from the MJKI binary format.
   *
   * The binary header and declared payload length are validated before the
   * embedded JSON is decoded and passed through {@link MajikInvoice.fromJSON}.
   *
   * @param blob - Binary MJKI representation.
   * @returns Deserialized MajikInvoice.
   * @throws {@link MajikInvoiceSerializationError} When the binary header,
   * version, length, or JSON payload is invalid.
   */
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
  // ── SERIALIZATION
  // ==========================================================================

  /**
   * Serialize the envelope into its canonical JSON transport representation.
   *
   * The serialized form includes:
   *
   * - envelope identity and version
   * - payload mode
   * - public summary
   * - payload
   * - integrity/signature metadata
   * - timestamps
   * - recipient routing addresses
   *
   * Runtime decrypted cache is intentionally excluded.
   *
   * @returns JSON-safe MajikInvoice representation.
   */
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
      recipients: this.recipients || [],
    };
  }

  /**
   * Convert the invoice into the cloud-routing `MajikahInvoiceJSON` format.
   *
   * This method adds the routing/ownership fields expected by the cloud layer:
   *
   * - `user_id`
   * - `account_id`
   * - recipient routing addresses
   * - sender public key
   * - `sent_at`
   * - public invoice status
   *
   * The invoice is securely locked before the serialized routing payload is
   * returned.
   *
   * Encrypted invoices are required unless `forceSignedOnly` is explicitly set.
   *
   * @param sender - Public sender key/address used for cloud routing.
   * @param options - Optional ownership/routing overrides.
   * @returns Cloud-oriented serialized invoice representation.
   * @throws {@link MajikInvoiceError} When required cloud routing information
   * is missing or encryption requirements are not satisfied.
   */
  toMajikahInvoiceJSON(
    sender: MajikKeyAddress,
    options?: {
      userId?: string;
      accountId?: string;
      recipients?: MajikKeyAddress[];
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

  /**
   * Reconstruct a MajikInvoice from its JSON or cloud-routing JSON form.
   *
   * The method accepts either:
   *
   * - an already parsed object
   * - a JSON string
   * - a cloud `MajikahInvoiceJSON` containing compatible routing fields
   *
   * After reconstruction, the resulting envelope is structurally validated.
   * Cryptographic signatures are not automatically verified.
   *
   * @param json - Serialized MajikInvoice data or its JSON string.
   * @returns Reconstructed MajikInvoice instance.
   * @throws {@link MajikInvoiceSerializationError} When parsing, required
   * fields, or structural validation fail.
   */
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

      // Map cloud ownership fields back to the internal representation.
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
        sentAt: parsed?.sent_at,
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

  /**
   * Serialize the invoice to a JSON string.
   *
   * @param pretty - Whether to indent the resulting JSON for readability.
   * @returns Serialized invoice JSON.
   */
  toString(pretty = false): string {
    return JSON.stringify(this.toJSON(), null, pretty ? 2 : 0);
  }

  // ==========================================================================
  // ── PRIVATE HELPERS
  // ==========================================================================

  /**
   * Rebuild the MajikInvoice after a mutation to its underlying
   * {@link GeneralInvoice}.
   *
   * The `recomputeHash` option controls whether the modification represents
   * cryptographically committed content changes.
   *
   * - `false`
   *   Preserve the existing content hash and signature set. Intended for
   *   lifecycle/payment mutations that are intentionally excluded from the
   *   canonical signable invoice.
   *
   * - `true`
   *   Recompute the canonical content hash and clear signatures/seal state.
   *   Intended for genuine financial/document changes.
   *
   * Encrypted invoices cannot use this helper because changing their
   * underlying payload requires recipient/re-encryption context. Use
   * {@link reissue} for those cases.
   *
   * @param updatedInvoice - Updated underlying GeneralInvoice.
   * @param options - Hash recomputation behaviour.
   * @returns Rebuilt MajikInvoice.
   * @internal
   */
  protected _reissueFromMutation(
    updatedInvoice: GeneralInvoice,
    options: {
      /**
       * Recompute the content hash from the updated invoice when `true`.
       * Preserve the existing hash when `false`.
       */
      recomputeHash?: boolean;
    } = {},
  ): MajikInvoice {
    // Lifecycle/status/payment mutations can preserve the current content
    // commitment; genuine financial changes require a new commitment.
    const publicSummary = MajikInvoice._buildPublicSummary(updatedInvoice);

    const contentHash = options.recomputeHash
      ? sha256Hex(updatedInvoice.toCanonicalBytes())
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

    // Preserve signatures for non-signable lifecycle mutations; drop them
    // when the canonical financial content has changed.
    const integrity: IntegrityBlock = {
      contentHash,
      hashAlgorithm: "SHA-256",
      signatures: options.recomputeHash ? [] : [...this.integrity.signatures],
      isSealed: options.recomputeHash ? false : this.integrity.isSealed,
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
      sentAt: this.sentAt,
    });
  }

  /**
   * Build the plaintext public summary exposed by every MajikInvoice.
   *
   * The summary intentionally contains enough information for display,
   * routing, and basic indexing without requiring access to the complete
   * underlying invoice.
   *
   * @param invoice - Source GeneralInvoice.
   * @returns Public invoice summary.
   * @internal
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
   * Build an encrypted invoice payload from a GeneralInvoice.
   *
   * This delegates to the package encryption service.
   *
   * @param invoice - Invoice to encrypt.
   * @param recipients - ML-KEM recipients.
   * @param _signerKey - Optional signer key passed through to the encryption layer.
   * @returns Encrypted payload representation.
   * @internal
   */
  private static async _buildEncryptedPayload(
    invoice: GeneralInvoice,
    recipients: MajikRecipient[],
    _signerKey?: MajikKey,
  ): Promise<EncryptedPayload> {
    return buildEncryptedPayload(invoice, recipients, _signerKey);
  }

  /**
   * Resolve the underlying GeneralInvoice for operations that require
   * plaintext access.
   *
   * Signed-only invoices are reconstructed directly from their payload.
   * Encrypted invoices require a runtime decrypted cache.
   *
   * @param operation - Name of the operation requesting plaintext access.
   * @returns Underlying GeneralInvoice.
   * @throws {@link MajikInvoiceError} When an encrypted invoice has not been decrypted.
   * @internal
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

  // ── Input validation ──────────────────────────────────────────────────────

  /**
   * Validate security-specific input required to construct a MajikInvoice.
   *
   * General invoice semantics are delegated to {@link GeneralInvoice.create};
   * this method validates the additional cryptographic/envelope constraints.
   *
   * @param input - MajikInvoice creation input.
   * @throws {@link MajikInvoiceError} When mode or allowlist configuration is invalid.
   * @throws {@link MajikInvoiceKeyError} When required keys are missing/locked.
   * @internal
   */
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
  // ── CSV EXPORT
  // ==========================================================================

  /**
   * Export multiple MajikInvoice instances as one CSV document.
   *
   * Invoice handling depends on payload accessibility:
   *
   * - signed-only
   *   Full GeneralInvoice-backed export.
   *
   * - encrypted + decrypted cache
   *   Full GeneralInvoice-backed export.
   *
   * - encrypted + `decryptKey`
   *   Attempts decryption and exports full data when successful.
   *
   * - encrypted + inaccessible
   *   Produces a partial row using only public-summary-capable columns.
   *
   * Locked encrypted invoices are therefore not silently discarded.
   * Their unavailable columns are reported in `partialExports`.
   *
   * Duplicate invoice IDs are removed before export.
   *
   * @param invoices - Invoices to export.
   * @param options - Optional CSV columns and decryption key.
   * @returns CSV output plus export diagnostics.
   */
  static async batchExportToCSV(
    invoices: MajikInvoice[],
    options: {
      columns?: CSVColumn[];
      decryptKey?: MajikKey;
    } = {},
  ): Promise<CSVExportResult> {
    const rawColumns = options.columns ?? DEFAULT_CSV_COLUMNS;
    const columns = dedupeColumns(rawColumns);

    const uniqueInvoices = dedupeInvoices(invoices);

    const partialExports: CSVExportResult["partialExports"] = [];
    const errors: CSVExportResult["errors"] = [];
    const rows: string[] = [];

    // Header row is emitted even for an empty invoice collection.
    rows.push(buildCSVHeader(columns));

    for (const inv of uniqueInvoices) {
      try {
        let generalInvoice: GeneralInvoice | undefined;

        if (inv.mode === "signed-only") {
          generalInvoice = inv.invoice;
        } else if (inv.hasDecryptedCache) {
          generalInvoice = inv.invoice;
        } else if (options.decryptKey) {
          try {
            const result = await inv.decrypt(options.decryptKey);
            generalInvoice = result.invoice;
          } catch {
            generalInvoice = undefined;
          }
        }

        // Unavailable plaintext becomes a partial export rather than being
        // silently dropped from the CSV.
        if (!generalInvoice) {
          const unavailable = columns
            .filter((col) => {
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
            reason:
              inv.mode === "encrypted-and-signed"
                ? "encrypted-no-cache"
                : "invoice-unavailable",
            unavailableColumns: unavailable,
          });
        }

        const ctx: CSVResolveContext = {
          invoice: generalInvoice,
          public: inv.public,
          invoiceId: inv.id,
        };

        rows.push(buildCSVRow(ctx, columns));
      } catch (err) {
        // Record hard export failures without aborting the rest of the batch.
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

  // ── Duplication ───────────────────────────────────────────────────────────

  /**
   * Create a new invoice derived from this invoice.
   *
   * Duplication intentionally creates a new business document:
   *
   * - new invoice ID
   * - draft status
   * - no signatures
   * - no seal
   * - no payments
   *
   * Financial structure, parties, taxes, dates, references, notes, tags,
   * and metadata are preserved.
   *
   * Existing invoice numbers are incremented through the package's numeric
   * sequence helper when possible.
   *
   * Encrypted invoices require decryption access before duplication and are
   * returned as signed-only invoices.
   *
   * @param decryptKey - Optional key required when the source is encrypted.
   * @returns A new unsigned draft MajikInvoice.
   * @throws {@link MajikInvoiceError} When encrypted plaintext is unavailable.
   * @throws {@link MajikInvoiceKeyError} When the supplied decryption key is unusable.
   * @throws {@link MajikInvoiceEncryptionError} When decryption fails.
   */
  async duplicate(decryptKey?: MajikKey): Promise<MajikInvoice> {
    let gi: GeneralInvoice;

    if (this.mode === "encrypted-and-signed") {
      if (this.isLocked) {
        if (!decryptKey) {
          throw new MajikInvoiceError(
            "duplicate(): decryptKey is required for encrypted-and-signed invoices.",
          );
        }
        const decryptedResult = await this.decrypt(decryptKey);

        gi = decryptedResult.invoice;
      } else {
        gi = this.invoice;
      }
    } else {
      gi = this._requirePlaintextInvoice("duplicate");
    }

    // Build a fresh GeneralInvoice with a new id, draft status, and no payments.
    const baseInput = gi.toMajikInvoiceInput();

    const incrementedInvoiceNumber = !!baseInput.invoiceNumber?.trim()
      ? incrementLastNumericSequence(baseInput.invoiceNumber)
      : undefined;

    const clonedGi = GeneralInvoice.create({
      ...baseInput,
      id: undefined,
      status: "draft",
      invoiceNumber: incrementedInvoiceNumber,
    });

    const publicSummary = MajikInvoice._buildPublicSummary(clonedGi);
    const contentHash = sha256Hex(clonedGi.toCanonicalBytes());
    const now = new Date().toISOString();

    const payload: SignedOnlyPayload = {
      kind: "signed-only",
      invoice: clonedGi.toJSON(),
    };

    const integrity: IntegrityBlock = {
      contentHash,
      hashAlgorithm: "SHA-256",
      signatures: [],
      isSealed: false,
    };

    return new MajikInvoice({
      id: clonedGi.id,
      mode: "signed-only" as MajikInvoiceMode,
      public: publicSummary,
      payload,
      integrity,
      createdAt: now,
      updatedAt: now,
      sentAt: undefined,
    });
  }

  /**
   * Duplicate multiple invoices concurrently.
   *
   * Encrypted invoices require a decryption key. Individual failures are
   * collected so successful duplicates can still be returned.
   *
   * Each duplicate receives its own new ID, draft status, and fresh unsigned
   * cryptographic state.
   *
   * @param invoices - Invoices to duplicate.
   * @param decryptKey - Optional decryption key for encrypted invoices.
   * @returns Batch duplication result.
   */
  static async batchDuplicate(
    invoices: MajikInvoice[],
    decryptKey?: MajikKey,
  ): Promise<BatchDuplicateResult> {
    const errors: BatchDuplicateResult["errors"] = [];

    const results = await Promise.allSettled(
      invoices.map((inv) => inv.duplicate(decryptKey)),
    );

    const duplicated: MajikInvoice[] = [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        duplicated.push(result.value);
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

    return { duplicated, errors };
  }

  // ==========================================================================
  // ── SEND / RETENTION HELPERS
  // ==========================================================================

  /**
   * Determine whether `sentAt` exists and can be parsed as a valid date.
   *
   * @returns `true` when `sentAt` is present and represents a valid date.
   */
  public hasValidSentAt(): boolean {
    if (!this.sentAt) return false;

    const date = new Date(this.sentAt);

    return !Number.isNaN(date.getTime());
  }

  /**
   * Determine whether the invoice is older than a specified number of days
   * from its `sentAt` timestamp.
   *
   * Returns `false` when `sentAt` is absent or invalid.
   *
   * @param days - Retention/deletion-window length in days.
   * @returns `true` when the elapsed time since `sentAt` is greater than
   * the supplied number of days.
   *
   * @example
   * ```ts
   * invoice.isPastDeletionWindow(30);
   * ```
   */
  public isPastDeletionWindow(days: number): boolean {
    if (!this.hasValidSentAt()) return false;

    const sentDate = new Date(this.sentAt!);
    const now = new Date();

    const diffMs = now.getTime() - sentDate.getTime();

    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    return diffDays > days;
  }

  /**
   * Get the sent timestamp as a JavaScript `Date`.
   *
   * Falls back to the public issue date when no valid `sentAt` timestamp exists.
   */
  get sentDate(): Date {
    return this.hasValidSentAt() ? new Date(this.sentAt!) : this.issueDate;
  }

  /**
   * Determine whether a key is the initial signer/issuer of the invoice.
   *
   * The issuer is identified by the first signer entry in the signature set.
   *
   * @param key - Key whose fingerprint should be compared.
   * @returns `true` when the key matches the first signer.
   * @throws {@link MajikInvoiceKeyError} When a valid fingerprint-bearing key is not supplied.
   */
  isIssuer(key: MajikKey): boolean {
    if (!key || !key?.fingerprint) {
      throw new MajikInvoiceKeyError(
        "A valid Majik Key with fingerprint is required for this method.",
      );
    }
    if (this.signatureCount <= 0) return false;

    const initSigner = this.signerIds[0];
    return initSigner === key.fingerprint;
  }

  // ==========================================================================
  // ── SYNCING
  // ==========================================================================

  /**
   * Compare two invoices using only their canonical content hash.
   *
   * This deliberately ignores:
   *
   * - invoice ID
   * - invoice number
   * - mode
   * - lifecycle status
   * - updated timestamp
   *
   * It answers only whether the committed invoice content is identical.
   *
   * @param a - First invoice.
   * @param b - Second invoice.
   * @returns `true` when both content hashes are identical.
   */
  static isSameContent(a: MajikInvoice, b: MajikInvoice): boolean {
    return a.integrity.contentHash === b.integrity.contentHash;
  }

  /**
   * Determine whether two invoices are fully synchronized.
   *
   * A pair is considered synchronized when they have:
   *
   * - the same invoice ID
   * - the same invoice number
   * - the same content hash
   *
   * This is appropriate as a "no sync work required" guard.
   *
   * @param a - First invoice.
   * @param b - Second invoice.
   * @returns `true` when both copies represent the same synchronized document.
   */
  static isSynced(a: MajikInvoice, b: MajikInvoice): boolean {
    if (a.id !== b.id) return false;
    if (a.public.invoiceNumber !== b.public.invoiceNumber) return false;
    return MajikInvoice.isSameContent(a, b);
  }

  /**
   * Return whichever invoice has the later `updatedAt` timestamp.
   *
   * If the timestamps are equal, the first argument wins.
   *
   * This method does not inspect content or resolve conflicts semantically;
   * it only compares update timestamps.
   *
   * @param a - First invoice.
   * @param b - Second invoice.
   * @returns Invoice with the later update timestamp, or `a` on a tie.
   */
  static latest(a: MajikInvoice, b: MajikInvoice): MajikInvoice {
    const tA = new Date(a.updatedAt).getTime();
    const tB = new Date(b.updatedAt).getTime();
    return tB > tA ? b : a;
  }

  /**
   * Produce a structured comparison of two invoice envelopes.
   *
   * The diff reports:
   *
   * - whether committed content is identical
   * - whether invoice numbers match
   * - whether modes match
   * - whether public statuses match
   * - update timestamp delta
   * - whether the content hash changed
   *
   * Cross-ID comparisons are allowed even though synchronization workflows
   * normally compare invoices with the same ID.
   *
   * @param a - First invoice.
   * @param b - Second invoice.
   * @returns Structured invoice difference.
   */
  static diff(a: MajikInvoice, b: MajikInvoice): InvoiceDiff {
    return {
      sameContent: MajikInvoice.isSameContent(a, b),
      sameInvoiceNumber: a.public.invoiceNumber === b.public.invoiceNumber,
      sameMode: a.mode === b.mode,
      sameStatus: a.public.status === b.public.status,
      updatedAtDeltaMs:
        new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
      contentHashChanged: a.integrity.contentHash !== b.integrity.contentHash,
    };
  }

  /**
   * Compare local and remote invoice collections and classify every invoice.
   *
   * Matching is performed by invoice ID.
   *
   * Classification:
   *
   * - `synced`
   *   Same ID and same content hash.
   *
   * - `conflicts`
   *   Same ID but different content hashes.
   *
   * - `localOnly`
   *   Present only in the local collection.
   *
   * - `remoteOnly`
   *   Present only in the remote collection.
   *
   * Conflicts include a full {@link InvoiceDiff} for downstream handling.
   *
   * @param local - Local invoice collection.
   * @param remote - Remote invoice collection.
   * @returns Batch synchronization classification.
   */
  static batchSyncStatus(
    local: MajikInvoice[],
    remote: MajikInvoice[],
  ): BatchSyncStatusResult {
    const remoteMap = new Map(remote.map((inv) => [inv.id, inv]));
    const localMap = new Map(local.map((inv) => [inv.id, inv]));

    const synced: MajikInvoice[] = [];
    const conflicts: SyncConflict[] = [];
    const localOnly: MajikInvoice[] = [];
    const remoteOnly: MajikInvoice[] = [];

    for (const localInv of local) {
      const remoteInv = remoteMap.get(localInv.id);

      if (!remoteInv) {
        localOnly.push(localInv);
        continue;
      }

      if (MajikInvoice.isSameContent(localInv, remoteInv)) {
        synced.push(localInv);
      } else {
        conflicts.push({
          id: localInv.id,
          local: localInv,
          remote: remoteInv,
          diff: MajikInvoice.diff(localInv, remoteInv),
        });
      }
    }

    for (const remoteInv of remote) {
      if (!localMap.has(remoteInv.id)) {
        remoteOnly.push(remoteInv);
      }
    }

    return { synced, conflicts, localOnly, remoteOnly };
  }

  /**
   * Resolve a local/remote synchronization conflict using an explicit strategy.
   *
   * Supported strategies:
   *
   * - `local-wins` — return local as winner
   * - `remote-wins` — return remote as winner
   * - `latest-wins` — compare `updatedAt` and use the newer copy
   *
   * When timestamps are equal under `latest-wins`, the local copy wins.
   *
   * This method does not merge fields. It selects one complete invoice
   * instance as the winner and exposes the other as the loser.
   *
   * @param local - Local invoice copy.
   * @param remote - Remote invoice copy.
   * @param strategy - Conflict-selection strategy.
   * @returns Winner, loser, and the strategy used.
   * @throws {@link MajikInvoiceError} When the two invoices have different IDs.
   */
  static resolveConflict(
    local: MajikInvoice,
    remote: MajikInvoice,
    strategy: ConflictResolutionStrategy = "latest-wins",
  ): {
    winner: MajikInvoice;
    loser: MajikInvoice;
    strategy: ConflictResolutionStrategy;
  } {
    if (local.id !== remote.id) {
      throw new MajikInvoiceError(
        `resolveConflict(): local.id ("${local.id}") and remote.id ("${remote.id}") ` +
          "must match. You cannot resolve a conflict between two different invoices.",
      );
    }

    let winner: MajikInvoice;
    let loser: MajikInvoice;

    switch (strategy) {
      case "local-wins":
        winner = local;
        loser = remote;
        break;
      case "remote-wins":
        winner = remote;
        loser = local;
        break;
      case "latest-wins":
      default: {
        const tLocal = new Date(local.updatedAt).getTime();
        const tRemote = new Date(remote.updatedAt).getTime();
        if (tRemote > tLocal) {
          winner = remote;
          loser = local;
        } else {
          // Equal timestamps also resolve to local.
          winner = local;
          loser = remote;
        }
        break;
      }
    }

    return { winner, loser, strategy };
  }
}

/**
 * Remove duplicate MajikInvoice instances by invoice ID.
 *
 * Only the first occurrence of each ID is retained; original input ordering
 * is preserved.
 *
 * @param invoices - Invoice collection to deduplicate.
 * @returns A new array containing the first invoice for each unique ID.
 */
export function dedupeInvoices(invoices: MajikInvoice[]): MajikInvoice[] {
  const seen = new Set<string>();

  return invoices.filter((inv) => {
    if (seen.has(inv.id)) return false;
    seen.add(inv.id);
    return true;
  });
}

// Freeze static methods
Object.freeze(MajikInvoice);

// Freeze instance methods
Object.freeze(MajikInvoice.prototype);
