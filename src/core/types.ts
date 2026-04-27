/**
 * @file majik-invoice-types.ts
 * @description MajikInvoice-specific types — mode, status, payloads, integrity,
 * proof of payment, and the Majikah cloud envelope (MajikahInvoiceJSON).
 */

import type { MajikKey } from "@majikah/majik-key";
import type {
  CurrencyCode,
  GeneralInvoice,
  GeneralInvoiceInput,
  GeneralInvoiceJSON,
  InvoiceType,
  ISODateString,
  ISODateTimeString,
  ProofOfPayment,
} from "./general-invoice";
import type {
  ExpectedSigner,
  MajikSignatureJSON,
  SealInfo,
} from "@majikah/majik-signature";
import { MajikRecipient } from "@majikah/majik-envelope";

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export type MajikInvoiceMode = "signed-only" | "encrypted-and-signed";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Runtime posture of the MajikInvoice.
 *
 * "sealed"          — sealed and signed  (encrypted or plaintext)
 * "fully-signed"    — all expected signers have signed; not yet sealed
 * "partially-signed"— at least one signature but allowlist not fully satisfied
 * "unsigned"        — invoice created but no signatures attached yet
 * "invalid"         — structural or cryptographic verification failed
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
 * Minimal plaintext summary exposed even on encrypted invoices.
 * Never contains sensitive line-item detail.
 */
export interface PublicInvoiceSummary {
  issuerName: string;
  recipientName: string;
  currency: CurrencyCode;
  /** Grand total in major units */
  totalAmount: number;
  /** Formatted grand total string (e.g. "₱61,600.00") */
  formattedTotal: string;
  invoiceType: InvoiceType;
  issuedAt: ISODateString;
  dueDate?: ISODateString;
  invoiceNumber?: string;
}

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

export interface SignedOnlyPayload {
  kind: "signed-only";
  /** The full GeneralInvoice serialized to JSON — plaintext */
  invoice: GeneralInvoiceJSON;
}

export interface EncryptedPayload {
  kind: "encrypted-and-signed";
  /**
   * MajikEnvelope scanner string (base64-encoded binary envelope).
   * Contains the encrypted GeneralInvoice JSON.
   */
  envelopeString: string;
  /** Algorithm identifier — always "ML-KEM-768 + AES-256-GCM" */
  algorithm: string;
  /**
   * Recipient fingerprint(s) — identifies who can decrypt.
   * Single-recipient: one entry. Group: multiple entries.
   */
  recipientFingerprints: string[];
}

export type MajikInvoicePayload = SignedOnlyPayload | EncryptedPayload;

// ---------------------------------------------------------------------------
// Integrity block
// ---------------------------------------------------------------------------

export interface IntegrityBlock {
  /**
   * SHA-256 hex of the canonical payload bytes.
   * For signed-only: canonical bytes of the embedded GeneralInvoice.
   * For encrypted: canonical bytes of the GeneralInvoice BEFORE encryption.
   * This is the value that MajikSignature covers.
   */
  contentHash: string;
  hashAlgorithm: "SHA-256";
  /** All attached signatures — one per signer */
  signatures: MajikSignatureJSON[];
  /**
   * Allowlist of expected signers (optional).
   * When present, only listed signers may add signatures.
   */
  expectedSigners?: ExpectedSigner[];
  /**
   * Fingerprint of the signer who established the allowlist.
   * Only this signer may call seal().
   */
  allowlistSignerId?: string;
  /** Seal info — present only after seal() has been called */
  sealInfo?: SealInfo;
  /** Whether this envelope has been sealed (no further signatures allowed) */
  isSealed: boolean;
}

// ---------------------------------------------------------------------------
// Decrypted cache — runtime only, NOT persisted
// ---------------------------------------------------------------------------

export interface DecryptedCache {
  invoice: GeneralInvoice;
  decryptedAt: ISODateTimeString;
  /** Fingerprint of the identity that decrypted this session */
  decryptedBy: string;
}

// ---------------------------------------------------------------------------
// Create input
// ---------------------------------------------------------------------------

export interface MajikInvoiceInput extends GeneralInvoiceInput {
  mode?: MajikInvoiceMode;
  /**
   * Required when mode is "encrypted-and-signed".
   * Single key = single-recipient envelope.
   * Multiple keys = group envelope (MajikEnvelope group mode).
   */
  recipients?: MajikRecipient[];
  /**
   * The signing key. Required unless you intend to sign later via sign().
   * Must be unlocked.
   */
  signerKey?: MajikKey;
  /**
   * Restrict future signers on this invoice.
   * When provided, only keys whose fingerprint appears here may sign.
   */
  expectedSigners?: ExpectedSigner[];
  /**
   * Optional cloud user identifier — owner of this invoice.
   * Required when calling toMajikahInvoiceJSON().
   */
  userId?: string;
  /**
   * Optional cloud organization/account identifier.
   * Falls back to userId when calling toMajikahInvoiceJSON() if not provided.
   */
  accountId?: string;
}

// ---------------------------------------------------------------------------
// JSON shape for persistence — base MajikInvoice
// ---------------------------------------------------------------------------

export interface MajikInvoiceJSON {
  __type: "MajikInvoice" | "MajikahInvoice";
  version: string;
  id: string;
  mode: MajikInvoiceMode;
  public: PublicInvoiceSummary;
  payload: MajikInvoicePayload;
  integrity: IntegrityBlock;
  /** Proofs of payment attached to this invoice — may be empty */
  proofOfPayments: ProofOfPayment[];
  /** Optional cloud user identifier */
  userId?: string;
  /** Optional cloud organization/account identifier */
  accountId?: string;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

// ---------------------------------------------------------------------------
// MajikahInvoiceJSON — extended cloud envelope
// ---------------------------------------------------------------------------

/**
 * Extended MajikInvoice shape used when submitting to or reading from the
 * Majikah cloud. Carries the ownership and routing fields required by the
 * backend to associate the invoice with a user and organization, and to
 * deliver it to the correct recipient(s).
 *
 * Produced by `MajikInvoice.toMajikahInvoiceJSON()`.
 * `fromJSON()` accepts this shape and rehydrates it as a MajikInvoice.
 *
 * Cloud routing flow:
 *   issuer calls toMajikahInvoiceJSON() → submits to cloud
 *   cloud routes to recipient(s) via `recipients` array
 *   recipient confirms → invoice stored to their local storage
 */
export interface MajikahInvoiceJSON extends MajikInvoiceJSON {
  __type: "MajikahInvoice";
  /**
   * Cloud user ID of the invoice owner/issuer.
   * Required — toMajikahInvoiceJSON() throws if absent.
   */
  user_id: string;
  /**
   * Cloud organization/account ID.
   * Falls back to user_id if not explicitly provided.
   */
  account_id: string;
  /**
   * Recipient identifiers for cloud routing.
   * Used to deliver the invoice to the correct user(s) or org(s).
   *
   * Defaults to:
   *   [issuer's signer fingerprint, ...expectedSigner fingerprints]
   * when not explicitly provided.
   */
  recipients: string[];
  /**
   * Ed25519 public key of the original invoice issuer.
   * Taken from `MajikKeyJSON.publicKey` — base64-encoded.
   * Derived from the first attached signature at serialization time.
   * Allows recipients to verify the issuer's identity without a keyserver lookup.
   */
  public_key: string;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface MajikInvoiceValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Internal constructor state
// ---------------------------------------------------------------------------

export interface MajikInvoiceConstructorOptions {
  id: string;
  mode: MajikInvoiceMode;
  public: PublicInvoiceSummary;
  payload: MajikInvoicePayload;
  integrity: IntegrityBlock;
  proofOfPayments?: ProofOfPayment[];
  userId?: string;
  accountId?: string;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  decrypted?: DecryptedCache;
}
