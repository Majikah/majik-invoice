# MJKI — Majik Invoice Binary Format

**File Extension:** `.mjki`  
**Media Type:** `application/vnd.majikah.invoice`  
**Category:** Cryptographically secured invoice envelope  
**Specification Version:** 1.0  
**Format Version Byte:** `0x01`  
**Status:** Implementation-aligned  

---

## 1. Overview

MJKI (Majik Invoice) is the binary serialization format for the Majik Invoice system. It provides a compact, self-identifying container for `MajikInvoice` objects, which wrap a general invoice with post-quantum digital signatures and optional post-quantum encryption.

The format supports two operational modes:

- **signed-only:** The invoice content remains plaintext but is integrity-sealed via signatures.
- **encrypted-and-signed:** The invoice content is encrypted using ML-KEM-768; only a public summary remains visible to non-recipients.

---

## 2. Design Goals

- **PQC Security:** Utilizes FIPS 203 (ML-KEM) for encryption and hybrid Ed25519 + ML-DSA-87 for digital signatures.
- **Self-Identification:** Uses a fixed magic-byte header for reliable file type detection.
- **Deterministic Integrity:** Content is hashed using SHA-256 and signed to ensure non-repudiation.
- **Cloud Compatibility:** Includes fields for routing and multi-tenancy (`userId`, `accountId`).

---

## 3. Binary Layout

All multi-byte integer fields are big-endian.

### 3.1 Fixed Header

The first 12 bytes of every `.mjki` file:

| Offset | Length | Field          | Description                               |
| ------ | ------ | -------------- | ----------------------------------------- |
| 0      | 4      | Magic bytes    | ASCII `"MJKI"` (0x4D 0x4A 0x4B 0x49)      |
| 4      | 1      | Version        | Current version: `0x01`                   |
| 5      | 3      | Reserved       | Future flags (currently `0x00 0x00 0x00`) |
| 8      | 4      | Payload Length | Big-endian uint32 length of JSON payload  |

Reserved bytes MUST be zero and SHOULD be validated during parsing.

---

### 3.2 Payload Section

Following the header is the variable-length JSON payload:

| Offset | Length | Field                                           |
| ------ | ------ | ----------------------------------------------- |
| 12     | N      | Payload JSON (UTF-8 encoded `MajikInvoiceJSON`) |


---

## 4. Payload JSON Schema

The payload follows the `MajikInvoiceJSON` structure.

```ts
interface MajikInvoiceJSON {
  version: string;             // Schema version (e.g., "1.0.0")
  id: string;                  // Unique invoice UUID
  mode: "signed-only" | "encrypted-and-signed";

  public: PublicSummary;       // Plaintext metadata
  payload: InvoicePayload;     // Plaintext or encrypted envelope
  integrity: IntegrityBlock;   // Signatures and hashes

  proofOfPayments: any[];      // Settlement history

  userId?: string;             // Owner ID
  accountId?: string;          // Account ID

  createdAt: string;           // ISO timestamp
  updatedAt: string;           // ISO timestamp
}
```

### 4.1 Public Summary

The Public Summary is always visible, even when the invoice payload is encrypted. It contains non-sensitive metadata used for indexing, display, and lightweight verification.

Fields include:

- `issuerName`
- `recipientName`
- `totalAmount`
- `currency`
- `formattedTotal`
- `issuedAt`
- `dueDate`
- `invoiceNumber`

This section is intentionally designed to remain readable in all `mode` configurations to support search, previews, and routing logic without decrypting the full invoice.

---

### 4.2 Integrity Block

The Integrity Block ensures the invoice has not been altered after signing or encryption. It is the cryptographic trust anchor of the MJKI format.

Fields include:

- `contentHash`:  
  A SHA-256 hash of the canonicalized invoice bytes. This ensures deterministic integrity across platforms.

- `signatures`:  
  An array of `MajikSignature` objects. Each signature may represent:
  - individual signer approval
  - multi-signature workflows
  - system-level attestations

- `isSealed`:  
  Boolean flag indicating immutability.  
  When `true`, the invoice becomes strictly append-only and must reject any further modifications or signatures.

- `expectedSigners` (optional):  
  A list of authorized signer identifiers used for multi-party validation or approval pipelines.

- `hashAlgorithm`: string (required, default: "SHA-256")
- `allowlistSignerId`: string (optional)
- `sealInfo`:
  - sealedBy: string
  - timestamp: string
  - hash: string

---

### 4.3 Payload Variants

#### SignedOnlyPayload:
- kind: "signed-only"
- invoice: GeneralInvoiceJSON

#### EncryptedPayload:
- kind: "encrypted-and-signed"
- envelopeString: string
- recipientFingerprints: string[]
- algorithm: string

---

## 5. Cryptographic Pipeline

### 5.1 Signing (signed-only mode)

In `signed-only` mode, the invoice remains readable but cryptographically sealed.

Steps:

1. Serialize `GeneralInvoice` into a canonical JSON representation.
2. Compute:
   - `contentHash = SHA-256(canonical_bytes)`
3. Construct a signing payload:
```ts
majik-invoice-v1:{
"contentHash": "...",
"invoiceId": "..."
}
```
4. Sign the payload using a hybrid scheme:
   - Ed25519 (classical signature)
   - ML-DSA-87 (post-quantum signature)

5. Attach resulting signatures into `integrity.signatures`.

This ensures both current and post-quantum verifiability.

---

### 5.2 Encryption (encrypted-and-signed mode)

In `encrypted-and-signed` mode, the invoice payload is fully encrypted.

Steps:

1. Serialize `GeneralInvoice` into JSON.
2. Encrypt using:
   - ML-KEM-768 (key encapsulation)
   - AES-256-GCM (symmetric payload encryption)
3. Store encrypted result in:
   - `payload.envelopeString`
4. Store recipient access control metadata in:
   - `payload.recipientFingerprints`

5. Only the `public` section and integrity metadata remain visible outside decryption.

---

### 5.3 Canonicalization Rules
- JSON keys must be lexicographically sorted
- UTF-8 encoding only
- no whitespace or indentation
- deterministic number formatting
- stable date serialization (ISO 8601)

---

## 6. Implementation Notes

### 6.1 Serialization (To Binary)

To encode a `MajikInvoice` into `.mjki`:

1. Convert object → JSON string
2. UTF-8 encode JSON → byte array
3. Construct header:

   - Bytes `0–3`: `0x4D 4A 4B 49` ("MJKI")
   - Byte `4`: version `0x01`
   - Bytes `5–7`: reserved (`0x00 0x00 0x00`)
   - Bytes `8–11`: uint32BE payload length

4. Append JSON payload bytes

Final structure:
**[HEADER (12 bytes)] + [JSON PAYLOAD (N bytes)]**


---

### 6.2 Deserialization (From Binary)

To decode `.mjki`:

1. Read first 4 bytes → must equal `"MJKI"`
2. Validate version byte = `0x01`
3. Read payload length from offset `8`
4. Extract payload slice using length
5. Decode UTF-8 → JSON string
6. Parse JSON into `MajikInvoice`
7. Validate against schema constraints

---

## 7. Security Considerations

### Seal Enforcement
If:
```ts
integrity.isSealed === true
```


Then implementations MUST:

- Reject all modifications
- Reject re-signing attempts
- Treat invoice as immutable artifact

---

### Canonical Signing

Canonical invoice bytes are used only for computing contentHash.
Signatures operate on a derived payload (contentHash + invoiceId).

This prevents:

- replay attacks
- hash substitution
- invoice swapping under identical structure

---

## 8. Runtime Status (Non-persistent)
Status values are derived at runtime and are NOT serialized:
- unsigned
- partially-signed
- fully-signed
- sealed
- invalid
  
---

## 9. Transport Layer (MajikahInvoiceJSON)
This is NOT part of MJKI format and is used only for cloud routing/export.
This format is used for:
- API transmission
- cloud storage
- multi-tenant routing

It MUST NOT be used for binary serialization.

---

### Post-Quantum Hybrid Model

MJKI uses hybrid cryptography:

- Classical: Ed25519 (compatibility + performance)
- Post-Quantum: ML-DSA-87 (future resilience)
- Encryption: ML-KEM-768 + AES-256-GCM

This ensures security across both classical and quantum threat models.


## 14. Reference Implementation

**Library:** `@majikah/majik-invoice` (TypeScript)

---

## Author

Made with 💙 by [@thezelijah](https://github.com/jedlsf)

**Developer:** Josef Elijah Fabian  
**GitHub:** [https://github.com/jedlsf](https://github.com/jedlsf)  
**Project Repository:** [https://github.com/Majikah/majik-invoice](https://github.com/Majikah/majik-invoice)  
**Business Email:** [business@thezelijah.world](mailto:business@thezelijah.world)  
**Website:** [https://www.thezelijah.world](https://www.thezelijah.world)