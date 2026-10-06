/**

* @file majik-invoice-types.ts
*
* @description
* MajikInvoice-specific type definitions for the
* `@majikah/majik-invoice` cryptographic invoice envelope.
*
* This module defines the type-level contract for:
*
* * invoice security modes
* * cryptographic integrity state
* * public invoice summaries
* * plaintext and encrypted payloads
* * decrypted runtime cache
* * invoice creation input
* * persisted JSON envelopes
* * Majikah cloud-routing envelopes
* * validation results
* * internal constructor state
* * dashboard analytics
* * synchronization and conflict resolution
*
* The underlying business invoice model is represented by `GeneralInvoice`
* and its related types. These types describe the additional envelope,
* security, transport, and synchronization layer provided by `MajikInvoice`.
  */

import type { MajikKey, MajikKeyAddress } from "@majikah/majik-key";
import type {
  CurrencyCode,
  GeneralInvoice,
  GeneralInvoiceInput,
  GeneralInvoiceJSON,
  InvoiceStatus,
  InvoiceType,
  ISODateString,
  ISODateTimeString,
  PaymentStatus,
} from "./general-invoice/index.js";
import type {
  ExpectedSigner,
  MajikSignatureJSON,
  SealInfo,
} from "@majikah/majik-signature";
import { MajikRecipient } from "@majikah/majik-envelope";

/**

* Identifier for a Majik cloud user.
*
* This remains a string alias so the type can be used consistently across
* local, serialized, and cloud-routing representations.
  */
export type MajikUserID = string;

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**

* Security mode of a MajikInvoice.
*
* `signed-only`
* The underlying {@link GeneralInvoice} remains plaintext inside the
* payload. Its canonical content can still be integrity-protected,
* signed, and sealed.
*
* `encrypted-and-signed`
* The underlying `GeneralInvoice` is encrypted inside a MajikEnvelope.
* Only the public invoice summary and envelope metadata are available
* without decryption.
*
* @example
* ```ts
  ```
* const mode: MajikInvoiceMode = "encrypted-and-signed";
* ```
  ```

*/
export type MajikInvoiceMode = "signed-only" | "encrypted-and-signed";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**

* Cryptographic/integrity posture of a MajikInvoice.
*
* This is deliberately separate from {@link InvoiceStatus}, which represents
* the business/lifecycle state of the invoice.
*
* `invalid`
* The envelope failed structural validation.
*
* `unsigned`
* No signatures are currently attached.
*
* `partially-signed`
* One or more signatures exist, but the expected signer set has not been
* completely satisfied.
*
* `fully-signed`
* The invoice satisfies its expected signer set but is not yet sealed.
*
* `sealed`
* The invoice has been sealed and no further signatures are permitted.
  */
export type MajikInvoiceStatus =
  | "invalid"
  | "unsigned"
  | "partially-signed"
  | "fully-signed"
  | "sealed";

// ---------------------------------------------------------------------------
// Public summary — always plaintext, always present
// ---------------------------------------------------------------------------

/**

* Minimal invoice information intentionally exposed in plaintext.
*
* `PublicInvoiceSummary` is present even when the underlying invoice is
* encrypted and locked.
*
* It is intended for:
*
* * display
* * indexing
* * routing
* * notification
* * basic invoice identification
*
* It should not be treated as a complete representation of the invoice.
* Detailed line-item, accounting, tax, discount, payment, and metadata
* information remains part of the underlying `GeneralInvoice`.
  */
export interface PublicInvoiceSummary {
  /**

  * Legal name of the invoice issuer.
    */
  issuerName: string;

  /**

* Name of the invoice recipient.
*
* Optional because the public envelope may contain only the minimum
* information required by a particular workflow.
  */
  recipientName?: string;

  /**

* Currency in which the invoice is denominated.
  */
  currency: CurrencyCode;

  /**

* Invoice grand total expressed in major currency units.
*
* This may be available without decryption because it is included in the
* public summary.
  */
  totalAmount?: number;

  /**

* Human-readable representation of the public grand total.
*
* @example
* ```ts
  ```
* "₱61,600.00"
* ```
  ```

*/
  formattedTotal?: string;

  /**

* Business/document type of the invoice.
  */
  invoiceType: InvoiceType;

  /**

* Invoice issue date.
  */
  issuedAt: ISODateString;

  /**

* Optional invoice due date.
  */
  dueDate?: ISODateString;

  /**

* Optional customer-facing invoice number.
  */
  invoiceNumber?: string;

  /**

* Current business/lifecycle status exposed by the public envelope.
*
* This allows locked encrypted invoices to expose their lifecycle state
* without decrypting the underlying document.
  */
  status: InvoiceStatus;

  /**

* Derived payment state exposed in the public summary.
  */
  paymentStatus: PaymentStatus;
}

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/**

* Plaintext payload used by a `signed-only` MajikInvoice.
*
* The complete {@link GeneralInvoice} is serialized into the payload.
  */
export interface SignedOnlyPayload {
  /**

  * Discriminator identifying this payload as plaintext.
    */
  kind: "signed-only";

  /**

* Complete serialized GeneralInvoice.
*
* In this mode, the invoice contents are directly accessible without
* decryption.
  */
  invoice: GeneralInvoiceJSON;
}

/**

* Encrypted payload used by an `encrypted-and-signed` MajikInvoice.
*
* The complete GeneralInvoice is contained inside a MajikEnvelope rather than
* being stored directly in plaintext.
  */
export interface EncryptedPayload {
  /**

  * Discriminator identifying this payload as encrypted.
    */
  kind: "encrypted-and-signed";

  /**

* Serialized MajikEnvelope containing the encrypted GeneralInvoice.
*
* This is the envelope transport representation rather than the plaintext
* invoice itself.
  */
  envelopeString: string;

  /**

* Cryptographic algorithm identifier describing the envelope construction.
*
* The current representation uses:
*
* `ML-KEM-768 + AES-256-GCM`
  */
  algorithm: string;

  /**

* Fingerprints of the keys authorized to decrypt the envelope.
*
* A single fingerprint represents a single-recipient envelope.
* Multiple fingerprints represent a group-recipient envelope.
  */
  recipientFingerprints: string[];
}

/**

* Discriminated union containing the actual invoice payload.
*
* The `kind` field identifies whether the underlying GeneralInvoice is
* directly available or encrypted inside a MajikEnvelope.
  */
export type MajikInvoicePayload = SignedOnlyPayload | EncryptedPayload;

// ---------------------------------------------------------------------------
// Integrity block
// ---------------------------------------------------------------------------

/**

* Cryptographic integrity and authorization metadata attached to a MajikInvoice.
*
* The integrity block binds the underlying invoice content to its signatures
* and optional seal.
*
* Conceptually:
*
* `contentHash`
* → commitment to the canonical GeneralInvoice
*
* `signatures`
* → authorization/identity proofs over that commitment
*
* `sealInfo`
* → final tamper-evident state of the signature collection
  */
export interface IntegrityBlock {
  /**

  * SHA-256 hexadecimal digest of the canonical invoice content.
  *
  * The hash is calculated from the underlying GeneralInvoice before encryption.
  * Therefore, both `signed-only` and `encrypted-and-signed` invoices commit to
  * the same logical invoice content rather than to the transport representation.
  *
  * This is the content commitment used as the basis for MajikSignature input.
    */
  contentHash: string;

  /**

* Hash algorithm used for `contentHash`.
*
* The current MajikInvoice envelope schema uses SHA-256.
  */
  hashAlgorithm: "SHA-256";

  /**

* Cryptographic signatures currently attached to the invoice.
*
* Multiple signatures are supported to represent multi-party signing flows.
  */
  signatures: MajikSignatureJSON[];

  /**

* Optional allowlist of signers permitted to sign the invoice.
*
* When present, only signer fingerprints included in this collection may
* add signatures.
  */
  expectedSigners?: ExpectedSigner[];

  /**

* Fingerprint of the signer that established the expected-signer allowlist.
*
* This identity is treated as the invoice issuer for sealing purposes, and
* only this signer may seal an allowlisted invoice.
  */
  allowlistSignerId?: string;

  /**

* Cryptographic seal metadata.
*
* Present only after the invoice has been sealed.
  */
  sealInfo?: SealInfo;

  /**

* Whether the invoice has reached its sealed state.
*
* A sealed invoice rejects subsequent signing operations.
  */
  isSealed: boolean;
}

// ---------------------------------------------------------------------------
// Decrypted cache — runtime only, NOT persisted
// ---------------------------------------------------------------------------

/**

* Runtime-only cache containing a successfully decrypted GeneralInvoice.
*
* This structure is intentionally not persisted by `MajikInvoice.toJSON()`.
*
* It exists to avoid repeated decryption while still ensuring that plaintext
* invoice data is not stored in the serialized envelope merely because it was
* decrypted during the current session.
  */
export interface DecryptedCache {
  /**

  * Reconstructed plaintext GeneralInvoice.
    */
  invoice: GeneralInvoice;

  /**

* Timestamp at which decryption succeeded.
  */
  decryptedAt: ISODateTimeString;

  /**

* Fingerprint of the identity/key that successfully decrypted the invoice.
  */
  decryptedBy: string;
}

// ---------------------------------------------------------------------------
// Create input
// ---------------------------------------------------------------------------

/**

* Input required to construct a {@link MajikInvoice}.
*
* Extends {@link GeneralInvoiceInput} with cryptographic, recipient, and
* cloud-routing configuration.
*
* This represents creation-time configuration and should not be confused
* with the persisted `MajikInvoiceJSON` representation.
  */
export interface MajikInvoiceInput extends GeneralInvoiceInput {
  /**

  * Security mode of the resulting invoice.
  *
  * Defaults to `signed-only` when omitted.
    */
  mode?: MajikInvoiceMode;

  /**

* Encryption recipients for `encrypted-and-signed` mode.
*
* A single recipient produces a single-recipient envelope.
* Multiple recipients produce a group-recipient envelope.
  */
  recipients?: MajikRecipient[];

  /**

* Optional signing key used to sign the invoice during creation.
*
* When omitted, the invoice can be signed later with `sign()`.
*
* When supplied, the key must be unlocked and contain the required signing
* capability.
  */
  signerKey?: MajikKey;

  /**

* Optional expected-signer allowlist.
*
* When present, only keys whose fingerprints occur in this collection may
* sign the invoice.
*
* The initial signer establishes the invoice's allowlist identity.
  */
  expectedSigners?: ExpectedSigner[];

  /**

* Optional Majik cloud user identifier associated with the invoice owner.
*
* Required when producing a cloud-routing `MajikahInvoiceJSON` unless an
* equivalent value is supplied later.
  */
  userId?: string;

  /**

* Optional Majik cloud organization/account identifier.
*
* When omitted from cloud serialization, `userId` may be used as the
* account identifier.
  */
  accountId?: string;

  /**

* Optional public routing identifiers for recipients.
*
* These are used for cloud delivery/routing and are distinct from the
* encryption recipients used by the underlying MajikEnvelope.
  */
  recipientPublicKeys?: MajikKeyAddress[];
}

// ---------------------------------------------------------------------------
// JSON shape for persistence — base MajikInvoice
// ---------------------------------------------------------------------------

/**

* Persisted/transport-safe JSON representation of a MajikInvoice.
*
* Contains the complete envelope representation required to reconstruct a
* MajikInvoice locally.
*
* Runtime-only decrypted cache state is intentionally excluded.
  */
export interface MajikInvoiceJSON {
  /**

  * MajikInvoice serialized schema version.
    */
  version: string;

  /**

* Stable invoice identifier.
  */
  id: string;

  /**

* Payload security mode.
  */
  mode: MajikInvoiceMode;

  /**

* Always-plaintext public invoice summary.
  */
  public: PublicInvoiceSummary;

  /**

* Actual signed-only or encrypted payload.
  */
  payload: MajikInvoicePayload;

  /**

* Cryptographic integrity/signature/seal metadata.
  */
  integrity: IntegrityBlock;

  /**

* Envelope creation timestamp.
  */
  created_at: ISODateTimeString;

  /**

* Most recent envelope update timestamp.
  */
  updated_at: ISODateTimeString;

  /**

* Public recipient identifiers used for routing.
*
* These are intended for delivery/routing and do not expose the encrypted
* invoice contents.
  */
  recipients: MajikKeyAddress[];
}

// ---------------------------------------------------------------------------
// MajikahInvoiceJSON — extended cloud envelope
// ---------------------------------------------------------------------------

/**

* Extended cloud-facing MajikInvoice representation.
*
* `MajikahInvoiceJSON` adds ownership, routing, sender identity, and delivery
* metadata required by the Majikah cloud layer.
*
* It is produced by {@link MajikInvoice.toMajikahInvoiceJSON} and accepted by
* {@link MajikInvoice.fromJSON}.
*
* ### Cloud routing lifecycle
*
* ```text
  ```
* issuer
* │
* ├── toMajikahInvoiceJSON()
* │
* ▼
* Majikah cloud
* │
* ├── route by recipients[]
* │
* ▼
* recipient
* │
* └── decrypt / verify / store locally
* ```
  ```

*/
export interface MajikahInvoiceJSON extends MajikInvoiceJSON {
  /**

* Majik cloud user ID associated with the invoice owner/issuer.
*
* Required when generating this cloud representation.
  */
  user_id: string;

  /**

* Majik cloud organization/account ID.
*
* May fall back to `user_id` when an explicit account ID is not supplied.
  */
  account_id: string;

  /**

* Public key identifier of the original invoice issuer.
*
* This value allows recipients or cloud services to associate the envelope
* with the issuer's cryptographic identity without requiring the complete
* private key material.
  */
  public_key: string;

  /**

* Publicly routed invoice status.
*
* This mirrors the invoice's public lifecycle state for cloud workflows.
  */
  status: string;

  /**

* Timestamp at which the invoice was submitted/sent through the cloud flow.
  */
  sent_at: ISODateTimeString;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

/**

* Result of structural MajikInvoice validation.
*
* A validation failure is represented as structured field-level information
* rather than requiring an exception-based control flow.
  */
export interface MajikInvoiceValidationResult {
  /**

  * Whether the invoice passed all performed structural checks.
    */
  valid: boolean;

  /**

* Structural validation failures.
*
* An empty array indicates that no errors were detected.
  */
  errors: Array<{
    /**

  * Envelope/property path associated with the validation failure.
    */
    field: string;

    /**

 * Human-readable explanation of the validation failure.
 */
    message: string;
  }>;
}

// ---------------------------------------------------------------------------
// Internal constructor state
// ---------------------------------------------------------------------------

/**

* Fully initialized internal state used to construct or rebuild a
* {@link MajikInvoice}.
*
* This type represents the normalized state of an already-created envelope
* and is not intended to be the primary public creation API.
*
* @internal
  */
export interface MajikInvoiceConstructorOptions {
  /**

  * Stable invoice identifier.
    */
  id: string;

  /**

* Invoice security mode.
  */
  mode: MajikInvoiceMode;

  /**

* Always-plaintext invoice summary.
  */
  public: PublicInvoiceSummary;

  /**

* Complete plaintext or encrypted payload.
  */
  payload: MajikInvoicePayload;

  /**

* Integrity, signatures, allowlist, and seal metadata.
  */
  integrity: IntegrityBlock;

  /**

* Optional Majik cloud user ownership identifier.
  */
  userId?: string;

  /**

* Optional Majik cloud account/organization identifier.
  */
  accountId?: string;

  /**

* Envelope creation timestamp.
  */
  createdAt: ISODateTimeString;

  /**

* Most recent envelope update timestamp.
  */
  updatedAt: ISODateTimeString;

  /**

* Runtime-only decrypted state.
*
* Never intended for persistence.
  */
  decrypted?: DecryptedCache;

  /**

* Optional recipient routing identifiers.
  */
  recipients?: MajikKeyAddress[];

  /**

* Optional cloud send timestamp.
  */
  sentAt?: ISODateTimeString;
}

/**

* Aggregate statistics calculated across a collection of MajikInvoice instances.
*
* The structure is divided into:
*
* * invoice counts
* * monetary totals
* * payment settlement metrics
* * tax/financial metrics
* * invoice sizing
* * relationship metrics
* * temporal metrics
*
* Some detailed metrics may be based only on invoices whose plaintext
* GeneralInvoice is currently accessible.
  */
export interface DashboardStats {
  // ── Counts ────────────────────────────────

  /** Total number of invoices analyzed. */
  total: number;

  /** Number of invoices currently classified as paid. */
  paidCount: number;

  /** Number of invoices currently classified as partially paid. */
  partialCount: number;

  /** Number of invoices currently classified as overdue. */
  overdueCount: number;

  /** Number of invoices currently classified as draft. */
  draftCount: number;

  /** Number of invoices currently classified as void. */
  voidCount: number;

  /**

* Number of encrypted invoices that are currently locked.
*
* These invoices have no accessible decrypted runtime cache.
  */
  encryptedCount: number;

  /** Number of invoices with no attached signatures. */
  unsignedCount: number;

  /**

* Invoice count grouped by lifecycle status.
  */
  byStatus: Record<string, number>;

  // ── Amounts ───────────────────────────────

  /**

* Sum of public invoice grand totals across the analyzed collection.
  */
  totalAmount: number;

  /**

* Sum of grand totals for invoices classified as paid.
  */
  paidAmount: number;

  /**

* Sum of grand totals for invoices classified as partially paid.
  */
  partialAmount: number;

  /**

* Aggregate amount not represented by paid or partial categories.
*
* Derived as:
*
* `totalAmount - paidAmount - partialAmount`
  */
  unpaidAmount: number;

  /**

* Sum of grand totals for invoices classified as overdue.
  */
  overdueAmount: number;

  /**

* Invoice monetary totals grouped by lifecycle status.
  */
  byStatusAmount: Record<string, number>;

  // ── Payment settlement ────────────────────

  /**

* Sum of recorded payment amounts across accessible invoices.
  */
  totalCollected: number;

  /**

* Sum of calculated outstanding balances across invoices whose payment
* information is accessible.
  */
  totalOutstanding: number;

  /**

* Average number of days between invoice issue date and first recorded
* payment.
*
* `null` indicates that no qualifying payment interval was available.
  */
  avgDaysToPayment: number | null;

  // ── Tax & financials ──────────────────────

  /**

* Sum of additive tax amounts across accessible invoices.
  */
  taxCollected: number;

  /**

* Sum of withholding tax amounts across accessible invoices.
  */
  withholdingTotal: number;

  /**

* Sum of amounts actually payable after withholding.
  */
  netPayable: number;

  /**

* Aggregate discount amount granted across accessible invoices.
  */
  discountGiven: number;

  /**

* Aggregate effective additive tax rate.
*
* Calculated as a weighted relationship between tax amount and taxable base
* across accessible invoices.
  */
  effectiveTaxRate: number;

  /**

* Aggregate additive tax amounts grouped by tax type.
  */
  taxBreakdown: Array<{
    /**

  * Canonical/application tax type identifier.
    */
    taxType: string;

    /**


```
 * Aggregate amount for the tax type.
 */
    amount: number;

    /**
     * Aggregate/average effective rate represented by the grouped entries.
     */
    rate: number;
  }>;

  // ── Invoice sizing ────────────────────────

  /**

* Average invoice grand-total value.
  */
  avgInvoiceValue: number;

  /** Largest public invoice grand-total value. */
  largestInvoice: number;

  /** Smallest public invoice grand-total value. */
  smallestInvoice: number;

  /** Median public invoice grand-total value. */
  medianInvoiceValue: number;

  // ── Relationships ─────────────────────────

  /**

* Top recipients ranked by aggregate invoice value.
  */
  topRecipients: Array<{
    /** Recipient display/legal name. */
    name: string;

    /** Aggregate invoice value associated with the recipient. */

    totalAmount: number;

    /** Number of invoices associated with the recipient. */
    count: number;

    /** Aggregate value of invoices classified as paid. */
    paidAmount: number;
  }>;

  /** Number of unique recipients represented in the analyzed collection. */
  uniqueRecipientCount: number;

  /** Number of unique issuers represented in the analyzed collection. */
  uniqueIssuerCount: number;

  // ── Temporal ─────────────────────────────

  /**

* Earliest invoice issue date found in the analyzed collection.
  */
  oldestInvoiceDate: string | null;

  /**

* Latest invoice issue date found in the analyzed collection.
  */
  newestInvoiceDate: string | null;

  /**

* Number of invoices whose due date falls within the configured upcoming
* due-date window.
*
* The default window used by the dashboard calculator is 7 days.
  */
  dueSoonCount: number;
}

/**

* Association between a content hash and a MajikSignature representation.
*
* This can be used when a workflow needs to retain both the committed content
* identity and the signature object together.
  */
export interface InvoiceSignature {
  /** Content hash associated with the signature. */
  hash: string;

  /** Serialized MajikSignature data. */
  signature: MajikSignatureJSON;
}

// ── Sync types ────────────────────────────────────────────────────────────

/**

* Classification of an invoice during local/remote synchronization.
*
* `synced`
* Both copies represent the same committed invoice content.
*
* `conflict`
* Both copies have the same invoice identity but different committed content.
*
* `local-only`
* Invoice exists locally but not remotely.
*
* `remote-only`
* Invoice exists remotely but not locally.
  */
export type SyncStatus = "synced" | "conflict" | "local-only" | "remote-only";

/**

* Strategy used to select a winner when local and remote invoice copies
* conflict.
*
* `latest-wins`
* Compare `updatedAt` timestamps. The newer invoice wins; equal timestamps
* resolve to the local copy.
*
* `local-wins`
* Always retain the local copy.
*
* `remote-wins`
* Always retain the remote copy.
  */
export type ConflictResolutionStrategy =
  | "latest-wins"
  | "local-wins"
  | "remote-wins";

/**

* Structured comparison between two MajikInvoice instances.
*
* This describes which important synchronization characteristics match without
* attempting to merge the invoice contents.
  */
export interface InvoiceDiff {
  /**

  * Whether the canonical content hashes match.
    */
  sameContent: boolean;

  /**

* Whether the public invoice numbers match.
  */
  sameInvoiceNumber: boolean;

  /**

* Whether both invoices use the same security mode.
  */
  sameMode: boolean;

  /**

* Whether both public invoice lifecycle statuses match.
  */
  sameStatus: boolean;

  /**

* Difference between the two `updatedAt` timestamps.
*
* * positive → the local/first invoice is newer
* * negative → the remote/second invoice is newer
* * zero → timestamps are identical
    */
  updatedAtDeltaMs: number;

  /**

* Whether the canonical content hash differs.
*
* Equivalent to the inverse of `sameContent`.
  */
  contentHashChanged: boolean;
}
