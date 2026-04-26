// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

import type { MajikKey } from "@majikah/majik-key";
import type {
  CurrencyCode,
  GeneralInvoice,
  GeneralInvoiceInput,
  GeneralInvoiceJSON,
  InvoiceType,
  ISODateString,
} from "./general-invoice";
import type {
  ExpectedSigner,
  MajikSignatureJSON,
  SealInfo,
} from "@majikah/majik-signature";
import { MajikRecipient } from "@majikah/majik-envelope";

export type MajikInvoiceMode = "signed-only" | "encrypted-and-signed";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Runtime posture of the MajikInvoice.
 *
 * "sealed"    — at least one valid signature present (encrypted or plaintext)
 * "unsigned"  — invoice created but no signatures attached yet
 * "decrypted" — was encrypted; has been decrypted in this session (cached)
 * "invalid"   — structural or cryptographic verification failed
 */
export type MajikInvoiceStatus =
  | "sealed"
  | "unsigned"
  | "decrypted"
  | "invalid";

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
   * Single-recipient: one entry. Group: multiple entries (mirrors Envelope keys array).
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
   * Established by the first signer who calls sign() with expectedSigners.
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
  decryptedAt: string; // ISODateTimeString
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
   * The signerKey is automatically added as the issuer/allowlist owner.
   */
  expectedSigners?: ExpectedSigner[];
}

// ---------------------------------------------------------------------------
// JSON shape for persistence
// ---------------------------------------------------------------------------

export interface MajikInvoiceJSON {
  __type: "MajikInvoice";
  version: string;
  id: string;
  mode: MajikInvoiceMode;
  public: PublicInvoiceSummary;
  payload: MajikInvoicePayload;
  integrity: IntegrityBlock;
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
  updatedAt: string;
  decrypted?: DecryptedCache;
}
