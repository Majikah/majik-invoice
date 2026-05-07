# Majik Invoice

[![Developed by Zelijah](https://img.shields.io/badge/Developed%20by-Zelijah-red?logo=github&logoColor=white)](https://thezelijah.world) ![GitHub Sponsors](https://img.shields.io/github/sponsors/jedlsf?style=plastic&label=Sponsors&link=https%3A%2F%2Fgithub.com%2Fsponsors%2Fjedlsf)



Domain model for invoices with an optional cryptographic envelope (signing and encryption).

This repository provides two interoperable classes:
- `GeneralInvoice`: a pure accounting invoice model (line items, taxes, totals, projections).
- `MajikInvoice`: a wrapper that can sign and/or encrypt a `GeneralInvoice`.

This README focuses on the library as implemented in the source. It avoids product claims and sticks to the code and documented behavior.

![npm](https://img.shields.io/npm/v/@majikah/majik-invoice) ![npm downloads](https://img.shields.io/npm/dm/@majikah/majik-invoice) ![npm bundle size](https://img.shields.io/bundlephobia/min/%40majikah%2Fmajik-invoice) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) ![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)

## Overview

`@majikah/majik-invoice` provides two main classes:

- `GeneralInvoice` — a pure, accounting-focused invoice model. It manages line items, discounts, taxes, totals, CSV export, and can project itself to a journal entry or sub-ledger entry. It has no cryptographic dependencies and can be used standalone.
- `MajikInvoice` — a light envelope around `GeneralInvoice` that adds cryptographic features via optional peer libraries:
  - Signing and verification via `@majikah/majik-signature`.
  - Optional encryption via `@majikah/majik-envelope`.

Both classes are implemented as immutable value objects. Mutations use `with*` methods and return new instances; originals are not modified.

## Features

- Immutable value objects — `with*` methods return new instances; originals are unchanged.
- Invoice totals and breakdowns are computed from line items (`InvoiceTotals`).
- Per-line and invoice-level tax support (additive and withholding taxes, inclusive/exclusive).
- `Party` shape includes TIN and structured address fields; types follow ISO currency/country codes.
- Accounting projections: `toJournalEntry()` and `toSubLedgerEntry()` (these validate balance and can accept a chart-of-accounts override).
- Accounting branch discriminant via `InvoiceType` (e.g., `commercial`, `proforma`, `tax`, `project`, etc.).
- Lifecycle guards and transitions are enforced; use `withStatus()` to move between allowed states.
- Optional cryptography:
  - Signing/verification via `@majikah/majik-signature` (used by `MajikInvoice`).
  - Encryption via `@majikah/majik-envelope` — implementation uses an "ML-KEM-768 + AES-256-GCM" envelope string when encrypting.
  - Multi-sig support with an expected-signers allowlist and a sealing operation.
- Deterministic canonical serialization (`toCanonicalBytes()` / `toCanonicalJSON()`) for signing.
- Integrates with `@thezelijah/majik-money` for currency-aware arithmetic and serialization.
- CSV export helpers for single and batch exports (`toCSV()`, `batchExportToCSV()`).

## Installation

Install the package:

```bash
npm install @majikah/majik-invoice
```

Required peer dependency:

```bash
npm install @thezelijah/majik-money
```

Optional (runtime) dependencies for `MajikInvoice` cryptographic features:

```bash
npm install @majikah/majik-key @majikah/majik-signature @majikah/majik-envelope
```

Note: `MajikInvoice` will throw if signing or encryption is requested but the relevant keys or packages are not available or are locked.

## Usage

The following examples follow the runtime API implemented in `src/core`.

### GeneralInvoice — basic

```ts
import { GeneralInvoice } from "@majikah/majik-invoice";

const invoice = GeneralInvoice.create({
  issuer: {
    legalName: "Acme Corp",
    tin: "123-456-789-000",
    address: {
      line1: "123 Ayala Avenue",
      city: "Makati",
      country: "PH",
      branchCode: "000",
    },
  },
  recipient: { legalName: "Beta Inc", tin: "987-654-321-000" },
  currency: "PHP",
  defaultTaxes: [{ taxType: "VAT", rate: 0.12 }],
  lineItems: [
    { description: "Web Development", quantity: 1, unitPrice: 50000 },
    { description: "UI Design", quantity: 3, unitPrice: 8000 },
  ],
});

console.log(invoice.totals.grandTotal.format());
console.log(invoice.totals.hasTax);
```

### GeneralInvoice — immutable mutations

All structural mutations return a new `GeneralInvoice` instance.

```ts
const draft = GeneralInvoice.create({ /* ... */ });

const updated = draft
  .withLineItem({ description: "Hosting", quantity: 1, unitPrice: 5000 })
  .withInvoiceNumber("INV-2025-001")
  .withStatus("issued");

console.log(updated.lineItems.length);
```

### Updating a line item

```ts
const lineItemId = invoice.lineItems[0].id;
const corrected = invoice.withUpdatedLineItem(lineItemId, {
  quantity: 2,
  unitPrice: 45000,
});
```

### Tax operations

GeneralInvoice exposes helpers for:
- applying taxes to individual lines
- changing invoice-level default taxes
- removing taxes on all lines
- getting tax breakdowns by type

Example:

```ts
const vatOnly = invoice.taxTotalByType("VAT");
```

### Accounting projections

Use `toJournalEntry()` to produce a draft double-entry journal (it validates balance).
Use `toSubLedgerEntry()` for AR/AP sub-ledger entries.

Both can accept an optional `AccountingContext` to override account codes and add metadata.

Example:

```ts
const entry = invoice.toJournalEntry();
const ar = invoice.toSubLedgerEntry();
```

### Lifecycle

The library enforces allowed status transitions. Use `withStatus()` to change state; illegal transitions throw an `InvoiceLifecycleError`.

```ts
const issued = invoice.withStatus("issued");
```

### MajikInvoice — signed-only

`MajikInvoice` can be created in `signed-only` mode. If you provide `signerKey` (an unlocked `MajikKey`) it will attempt to sign immediately.

```ts
import { MajikInvoice } from "@majikah/majik-invoice";

const signed = await MajikInvoice.create({
  mode: "signed-only",
  signerKey: aliceKey,
  issuer: { legalName: "Alice Corporation", tin: "123-456-789-000" },
  recipient: { legalName: "Bob Inc" },
  currency: "PHP",
  defaultTaxes: [{ taxType: "VAT", rate: 0.12 }],
  lineItems: [{ description: "Design Services", quantity: 1, unitPrice: 50000 }],
});

console.log(signed.status);
console.log(signed.isSigned);
```

### MajikInvoice — encrypted-and-signed

Use `mode: "encrypted-and-signed"` and provide `recipients` to encrypt the payload. The public summary (`public`) remains available without decryption.

```ts
const enc = await MajikInvoice.create({
  mode: "encrypted-and-signed",
  signerKey: aliceKey,
  recipients: [bobRecipient],
  issuer: { legalName: "Alice Corporation" },
  recipient: { legalName: "Bob Inc" },
  currency: "PHP",
  lineItems: [{ description: "Confidential Services", quantity: 1, unitPrice: 100000 }],
});

if (enc.canDecrypt(bobKey)) {
  const decrypted = await enc.decrypt(bobKey);
  console.log(decrypted.totals.grandTotal.format());
}
```

### Multi-signature workflows

`MajikInvoice` supports an `expectedSigners` allowlist. Signatures are recorded in the integrity block and a sealing operation can lock the envelope from further signatures.

```ts
const inv = await MajikInvoice.create({
  mode: "signed-only",
  signerKey: aliceKey,
  expectedSigners: [{ signerId: aliceKey.fingerprint, label: "Issuer" }, { signerId: bobKey.fingerprint, label: "Approver" }],
});

const cosigned = await inv.sign(bobKey);
const sealed = await cosigned.seal(aliceKey);
```

### Reissue after changes

Modify the inner `GeneralInvoice` and call `reissue()` on the `MajikInvoice` to create a new envelope; signatures are cleared and you must re-sign as appropriate.

```ts
const updatedGi = inv.invoice.withLineItem({ description: "Extra Work", quantity: 2, unitPrice: 5000 });
const reissued = await inv.reissue(updatedGi, { signerKey: aliceKey, recipients: [bobRecipient] });
```

## Error types

The codebase exposes several error classes. Common ones include:

- `InvoiceValidationError` — invalid `GeneralInvoice` input.
- `InvoiceLifecycleError` — illegal status transition.
- `InvoiceMutationError` — mutation attempted on non-editable invoice.
- `InvoiceProjectionError` — journal projection failed (empty/unbalanced).
- `LineItemValidationError` — invalid line item data.
- `MajikInvoiceError` — base class for Majik-specific errors.
- `MajikInvoiceKeyError` — key-related errors (locked or missing keys).
- `MajikInvoiceEncryptionError` — encryption/decryption failures.
- `MajikInvoiceSignatureError` — signing/verification failures.
- `MajikInvoiceSealError` — seal/allowlist misuse.
- `MajikInvoiceSerializationError` — malformed JSON during rehydrate.

## Accounting branch support

`InvoiceType` selects the accounting branch. Supported values are:
`commercial`, `proforma`, `credit`, `debit`, `tax`, `government`, `intercompany`, `project`, `recurring`, `forensic`, `environmental`.

## Serialization

Both classes provide `toJSON()` / `fromJSON()` / `toCanonicalBytes()` helpers. `MajikMoney` values are serialized using the provided `serializeMoney` helpers and are rehydrated during `fromJSON()`. Totals are always derived from line items on deserialization.

```ts
const json = invoice.toJSON();
const restored = GeneralInvoice.fromJSON(json);
const canonical = invoice.toCanonicalBytes();
```


## Related Projects

### [Majik Key](https://www.npmjs.com/package/@majikah/majik-key)
Seed phrase account library — required peer dependency for signing.

### [Majik Signature](https://www.npmjs.com/package/@majikah/majik-signature)
A hybrid post-quantum content signing and verification library for the Majikah ecosystem. Built on top of **Majik Key**, it provides tamper-proof, forgery-resistant digital signatures for any content format — plaintext, JSON, PDF, audio, video, binary — using a dual-algorithm architecture that combines classical Ed25519 with post-quantum ML-DSA-87 (FIPS-204).

### [Majik Envelope](https://www.npmjs.com/package/@majikah/majik-envelope)
**Majik Envelope** is the core cryptographic engine of the [Majik Message](https://github.com/Majikah/majik-message) platform. It provides a post-quantum secure "envelope" format that handles message encryption, multi-recipient key encapsulation, and transparent compression using NIST-standardized algorithms.


---

## Contributing

If you want to contribute or help extend support to more platforms, reach out via email. All contributions are welcome!

---

## License

[Apache-2.0](LICENSE) — free for personal and commercial use.

---

## Author

Made with 💙 by [@thezelijah](https://github.com/jedlsf)

**Developer**: Josef Elijah Fabian  
**GitHub**: [https://github.com/jedlsf](https://github.com/jedlsf)  
**Project Repository**: [https://github.com/Majikah/majik-invoice](https://github.com/Majikah/majik-invoice)

---

## Contact

- **Business Email**: [business@thezelijah.world](mailto:business@thezelijah.world)
- **Official Website**: [https://www.thezelijah.world](https://www.thezelijah.world)