
# Majik Invoice

[![Developed by Zelijah](https://img.shields.io/badge/Developed%20by-Zelijah-red?logo=github&logoColor=white)](https://thezelijah.world) ![GitHub Sponsors](https://img.shields.io/github/sponsors/jedlsf?style=plastic&label=Sponsors&link=https%3A%2F%2Fgithub.com%2Fsponsors%2Fjedlsf)

Domain model for post-quantum secured invoices — structured accounting primitives with optional hybrid digital signatures and encryption.

Part of the [Majikah](https://github.com/Majikah) ecosystem.

![npm](https://img.shields.io/npm/v/@majikah/majik-invoice) ![npm downloads](https://img.shields.io/npm/dm/@majikah/majik-invoice) ![npm bundle size](https://img.shields.io/bundlephobia/min/%40majikah%2Fmajik-invoice) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) ![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)


----

- [Majik Invoice](#majik-invoice)
  - [Overview](#overview)
  - [Features](#features)
  - [Installation](#installation)
    - [Peer dependencies](#peer-dependencies)
  - [Usage](#usage)
    - [GeneralInvoice — basic](#generalinvoice--basic)
    - [GeneralInvoice — with\* mutation](#generalinvoice--with-mutation)
    - [GeneralInvoice — updating a line item](#generalinvoice--updating-a-line-item)
    - [GeneralInvoice — tax operations](#generalinvoice--tax-operations)
    - [GeneralInvoice — accounting projections](#generalinvoice--accounting-projections)
    - [GeneralInvoice — lifecycle](#generalinvoice--lifecycle)
    - [MajikInvoice — signed-only](#majikinvoice--signed-only)
    - [MajikInvoice — encrypted-and-signed](#majikinvoice--encrypted-and-signed)
    - [MajikInvoice — multi-sig with allowlist](#majikinvoice--multi-sig-with-allowlist)
    - [MajikInvoice — reissue after changes](#majikinvoice--reissue-after-changes)
  - [Error types](#error-types)
  - [Accounting branch support](#accounting-branch-support)
  - [Serialization](#serialization)
  - [Related Projects](#related-projects)
    - [Majik Key](#majik-key)
    - [Majik Signature](#majik-signature)
    - [Majik Envelope](#majik-envelope)
  - [Contributing](#contributing)
  - [License](#license)
  - [Author](#author)
  - [Contact](#contact)


---

## Overview

`@majikah/majik-invoice` provides two invoice domain objects designed to work together:

**`GeneralInvoice`** is a pure, accounting-neutral invoice model. It handles line items, tax calculation, discounts, totals, and can project itself into double-entry journal entries and sub-ledger entries. It has no cryptographic dependencies and can be used standalone in any accounting context.

**`MajikInvoice`** wraps `GeneralInvoice` with cryptographic security — hybrid Ed25519 + ML-DSA-87 digital signatures via `@majikah/majik-signature`, and optional ML-KEM-768 encryption via `@majikah/majik-envelope`. It supports two modes: signed-only (plaintext invoice with integrity seal) and encrypted-and-signed (invoice encrypted for specific recipients, with a public summary always visible).

Both classes are immutable by design. All mutation methods follow the `with*` pattern and return new instances — originals are never modified.

---

## Features

- **Immutable domain objects** — `with*` pattern throughout; originals are never mutated
- **Auto-computed totals** — subtotal, tax, discount, and grand total derived from line items; never stale
- **Per-line and invoice-level tax** — supports VAT, GST, withholding tax, inclusive and exclusive rates, multi-jurisdiction
- **BIR-compatible `Party` model** — TIN, registered address, branch code, RDO district, trade name, nature of business; globally compatible via ISO 3166-1 and ISO 4217
- **Accounting projections** — `toJournalEntry()` produces balanced double-entry journal entries; `toSubLedgerEntry()` produces AR/AP sub-ledger entries
- **Multi-branch accounting support** — commercial, tax, government, project, forensic, environmental, and more via `InvoiceType` discriminant
- **Lifecycle state machine** — explicit status transitions with guards (`draft → issued → paid → void`)
- **Post-quantum signing** — hybrid Ed25519 + ML-DSA-87 via `@majikah/majik-signature`
- **Post-quantum encryption** — ML-KEM-768 + AES-256-GCM via `@majikah/majik-envelope`
- **Multi-sig with allowlists** — restrict which keys may sign; seal when complete
- **Deterministic canonical serialization** — `toCanonicalBytes()` is stable for signing and hashing
- **Full `MajikMoney` integration** — arbitrary-precision, currency-aware arithmetic via `@thezelijah/majik-money`
- **Round-trip stable JSON** — `toJSON()` / `fromJSON()` with full `MajikMoney` serialization and rehydration

---

## Installation

```bash
npm install @majikah/majik-invoice
```

### Peer dependencies

```bash
npm install @thezelijah/majik-money
```

For `MajikInvoice` (signing and encryption):

```bash
npm install @majikah/majik-key @majikah/majik-signature @majikah/majik-envelope
```

---

## Usage

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
      stateOrProvince: "Metro Manila",
      postalCode: "1226",
      country: "PH",
      branchCode: "000",
    },
  },
  recipient: {
    legalName: "Beta Inc",
    tin: "987-654-321-000",
  },
  currency: "PHP",
  defaultTax: { taxType: "VAT", rate: 0.12 },
  lineItems: [
    { description: "Web Development", quantity: 1, unitPrice: 50000 },
    { description: "UI Design",       quantity: 3, unitPrice: 8000 },
  ],
});

console.log(invoice.totals.grandTotal.format()); // "₱73,024.00"
console.log(invoice.hasTax);                     // true
console.log(invoice.taxBreakdown());
// [{ taxType: "VAT", rate: 0.12, taxableBase: 74000, taxAmount: 8880, ... }]
```

---

### GeneralInvoice — with* mutation

All mutations return new instances. The original is always untouched.

```ts
const draft = GeneralInvoice.create({ ... });

const updated = draft
  .withLineItem({ description: "Hosting", quantity: 1, unitPrice: 5000 })
  .withInvoiceNumber("INV-2025-001")
  .withDueDate("2025-05-22")
  .withTag("q2")
  .withMetadata({ projectId: "proj-abc" })
  .withStatus("issued");

console.log(updated.lineItemCount);   // 3
console.log(updated.formattedTotal);  // "₱78,624.00"
console.log(updated.isDraft);         // false
```

---

### GeneralInvoice — updating a line item

```ts
const lineItemId = invoice.lineItems[0].id;

const corrected = invoice.withUpdatedLineItem(lineItemId, {
  quantity: 2,
  unitPrice: 45000,
});
```

---

### GeneralInvoice — tax operations

```ts
// Apply a specific tax to one line
const withWht = invoice.withTaxOnLineItem(lineItemId, {
  taxType: "WHT",
  rate: 0.02,
  label: "Withholding Tax (2%)",
});

// Change the invoice-level default tax
const withGst = invoice.withDefaultTax({ taxType: "GST", rate: 0.10 });

// Remove tax from all lines
const taxFree = invoice.withoutTaxOnAllLineItems();

// Breakdown by type (useful for BIR returns)
const breakdown = invoice.taxBreakdown();
// [{ taxType: "VAT", taxableBase: 74000, taxAmount: 8880 }, ...]

// Tax total for a specific type
const vatOnly = invoice.taxTotalByType("VAT"); // 8880
```

---

### GeneralInvoice — accounting projections

```ts
// Journal entry (double-entry, always "draft")
const entry = invoice.toJournalEntry();
// DR  Accounts Receivable  78,624.00
// CR  Revenue              74,000.00  (or per account code)
// CR  Tax Payable           8,880.00  (if tax applies)

// With a custom Chart of Accounts
const entry = invoice.toJournalEntry({
  accounts: {
    receivable: "1100",
    revenue:    "4100",
    tax:        "2200",
  },
});

// AR sub-ledger entry
const arEntry = invoice.toSubLedgerEntry();
// { type: "AR", partyName: "Beta Inc", balance: 78624, status: "open" }

// FX conversion (read-only — does not modify invoice)
const usdTotals = invoice.computeWithFxRate(0.0175, "USD");
// { grandTotal: 1375.92, formatted: { grandTotal: "US$1,375.92" } }

// Amount due after partial payment
const paid    = MajikMoney.fromMajor(30000, "PHP");
const due     = invoice.amountDue(paid);
const isFullyPaid = invoice.isFullyPaid(paid); // false
```

---

### GeneralInvoice — lifecycle

```ts
console.log(invoice.allowedTransitions()); // ["issued", "void"]
console.log(invoice.canTransitionTo("paid")); // false

const issued = invoice.withStatus("issued");
const paid   = issued.withStatus("paid");

// Voided invoices are terminal
const voided = paid.withStatus("void");
voided.withNotes("test"); // throws InvoiceMutationError
```

---

### MajikInvoice — signed-only

```ts
import { MajikInvoice } from "@majikah/majik-invoice";

// aliceKey must be unlocked and have signing keys
const invoice = await MajikInvoice.create({
  mode: "signed-only",
  signerKey: aliceKey,
  issuer: { legalName: "Alice Corporation", tin: "123-456-789-000" },
  recipient: { legalName: "Bob Inc" },
  currency: "PHP",
  defaultTax: { taxType: "VAT", rate: 0.12 },
  lineItems: [
    { description: "Design Services", quantity: 1, unitPrice: 50000 },
  ],
});

console.log(invoice.status);              // "sealed"
console.log(invoice.public.formattedTotal); // "₱56,000.00"
console.log(invoice.isSigned);            // true

// Verify signatures
const results = await invoice.verifySignatures();
// [{ valid: true, signerId: "alice-fingerprint", ... }]

// Access the inner GeneralInvoice directly
const general = invoice.invoice;
const entry = general.toJournalEntry();
```

---

### MajikInvoice — encrypted-and-signed

```ts
const invoice = await MajikInvoice.create({
  mode: "encrypted-and-signed",
  signerKey: aliceKey,
  recipientKeys: [bobKey],
  issuer: { legalName: "Alice Co" },
  recipient: { legalName: "Bob Inc" },
  currency: "PHP",
  lineItems: [
    { description: "Confidential Services", quantity: 1, unitPrice: 100000 },
  ],
});

// Public summary is always visible without decryption
console.log(invoice.public.issuerName);     // "Alice Co"
console.log(invoice.public.totalAmount);    // 100000
console.log(invoice.canDecrypt(bobKey));    // true

// Decrypt with Bob's key
const general = await invoice.decrypt(bobKey);
console.log(general.totals.grandTotal.format()); // "₱100,000.00"

// Decrypted invoice cached on the instance
const general2 = invoice.invoice; // uses cache — no re-decrypt
```

---

### MajikInvoice — multi-sig with allowlist

```ts
const invoice = await MajikInvoice.create({
  mode: "signed-only",
  signerKey: aliceKey,
  expectedSigners: [
    { signerId: aliceKey.fingerprint, label: "Issuer" },
    { signerId: bobKey.fingerprint,   label: "Approver" },
  ],
  ...invoiceInput,
});

// Alice has signed; Bob still pending
console.log(invoice.pendingSigners);  // [{ signerId: "bob-fingerprint", label: "Approver" }]
console.log(invoice.isFullySigned);   // false

// Bob co-signs
const cosigned = await invoice.sign(bobKey);
console.log(cosigned.isFullySigned);  // true

// Alice seals (as the allowlist issuer)
const sealed = await cosigned.seal(aliceKey);
console.log(sealed.isSealed);         // true

sealed.sign(bobKey); // throws MajikInvoiceSealError — no further signatures
```

---

### MajikInvoice — reissue after changes

```ts
// Modify the inner invoice (returns a new GeneralInvoice)
const updated = invoice.invoice
  .withLineItem({ description: "Extra Work", quantity: 2, unitPrice: 5000 })
  .withNotes("Revised scope");

// Reissue as a new MajikInvoice — all signatures cleared, re-sign
const reissued = await invoice.reissue(updated, { signerKey: aliceKey });
console.log(reissued.status); // "sealed"
```

---

## Error types

| Error                            | When thrown                                        |
| -------------------------------- | -------------------------------------------------- |
| `InvoiceValidationError`         | Invalid `GeneralInvoice` input                     |
| `InvoiceLifecycleError`          | Illegal status transition                          |
| `InvoiceMutationError`           | Structural mutation on non-draft or voided invoice |
| `InvoiceProjectionError`         | Unbalanced or empty invoice projected to journal   |
| `LineItemValidationError`        | Invalid line item input                            |
| `MajikInvoiceError`              | General `MajikInvoice` error (base class)          |
| `MajikInvoiceValidationError`    | Invalid `MajikInvoice` structure or input          |
| `MajikInvoiceKeyError`           | Locked key, missing signing/ML-KEM keys            |
| `MajikInvoiceEncryptionError`    | Encryption or decryption failure                   |
| `MajikInvoiceSignatureError`     | Signing or verification failure                    |
| `MajikInvoiceSealError`          | Illegal seal operation                             |
| `MajikInvoiceSerializationError` | Malformed JSON on `fromJSON()`                     |

---

## Accounting branch support

`InvoiceType` controls which accounting branch the invoice belongs to. The same `GeneralInvoice` structure supports all branches — no parallel class hierarchies.

| Type            | Branch                                            |
| --------------- | ------------------------------------------------- |
| `commercial`    | Financial Accounting — standard B2B               |
| `proforma`      | Pre-invoice, not a legal document                 |
| `credit`        | Credit note / reversal (journal entries reversed) |
| `debit`         | Debit note                                        |
| `tax`           | Tax Accounting — VAT / GST invoice                |
| `government`    | Government / Public procurement                   |
| `intercompany`  | Managerial — internal transfer pricing            |
| `project`       | Project Accounting — milestone billing            |
| `recurring`     | Subscription / periodic billing                   |
| `forensic`      | Forensic / Audit — flagged for investigation      |
| `environmental` | Social & Environmental Accounting                 |

---

## Serialization

Both classes are round-trip stable. `MajikMoney` instances are serialized via `serializeMoney()` and rehydrated via `deserializeMoney()` on `fromJSON()`. Totals are always re-derived from line items on deserialization — they can never be stale or tampered with independently.

```ts
// Serialize
const json = invoice.toJSON();
const str  = JSON.stringify(json);

// Rehydrate
const restored = GeneralInvoice.fromJSON(JSON.parse(str));

// Canonical bytes — deterministic, for signing
const bytes = invoice.toCanonicalBytes();
```

---

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