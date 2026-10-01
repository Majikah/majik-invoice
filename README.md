
# Majik Invoice

[![Developed by Zelijah](https://img.shields.io/badge/Developed%20by-Zelijah-red?logo=github&logoColor=white)](https://thezelijah.world) [![GitHub Sponsors](https://img.shields.io/github/sponsors/jedlsf?style=plastic&label=Sponsors&link=https%3A%2F%2Fgithub.com%2Fsponsors%2Fjedlsf)](https://github.com/sponsors/jedlsf)
[![npm](https://img.shields.io/npm/v/@majikah/majik-invoice)](https://www.npmjs.com/package/@majikah/majik-invoice) [![npm downloads](https://img.shields.io/npm/dm/@majikah/majik-invoice)](https://www.npmjs.com/package/@majikah/majik-invoice) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/)

A TypeScript invoice domain library that combines **structured accounting logic** with an optional **cryptographic envelope** for signing, verification, encryption, sealing, serialization, and secure document workflows.

`@majikah/majik-invoice` is built around two complementary domain objects:

- `GeneralInvoice` — the business and accounting document.
- `MajikInvoice` — the cryptographic and transport envelope around that document.

The package is designed so the accounting model can be used independently while security-sensitive workflows can opt into the Majikah cryptographic stack.

---
# Table of Contents
- [Majik Invoice](#majik-invoice)
- [Table of Contents](#table-of-contents)
  - [Overview](#overview)
    - [`GeneralInvoice`](#generalinvoice)
    - [`MajikInvoice`](#majikinvoice)
  - [Design Principles](#design-principles)
    - [Immutable domain state](#immutable-domain-state)
    - [Accounting first, cryptography second](#accounting-first-cryptography-second)
    - [Public metadata can remain accessible](#public-metadata-can-remain-accessible)
    - [Cryptographic state is explicit](#cryptographic-state-is-explicit)
- [Features](#features)
  - [General Invoice Domain](#general-invoice-domain)
  - [Cryptographic Invoice Envelope](#cryptographic-invoice-envelope)
  - [Batch Workflows](#batch-workflows)
  - [CSV Export](#csv-export)
- [Installation](#installation)
- [GeneralInvoice](#generalinvoice-1)
  - [Creating an Invoice](#creating-an-invoice)
  - [Reading Totals](#reading-totals)
  - [Immutable Mutations](#immutable-mutations)
  - [Updating a Line Item](#updating-a-line-item)
- [Taxes](#taxes)
- [Accounting Projections](#accounting-projections)
    - [Journal entry](#journal-entry)
    - [Sub-ledger entry](#sub-ledger-entry)
- [Invoice Types](#invoice-types)
- [Lifecycle](#lifecycle)
- [MajikInvoice](#majikinvoice-1)
  - [`signed-only`](#signed-only)
  - [`encrypted-and-signed`](#encrypted-and-signed)
- [MajikInvoice Status](#majikinvoice-status)
- [Signing](#signing)
- [Multi-Signature Workflows](#multi-signature-workflows)
- [Sealing](#sealing)
- [Verification](#verification)
- [Decryption](#decryption)
- [Public Invoice Summary](#public-invoice-summary)
- [Reissuing](#reissuing)
- [Serialization](#serialization)
  - [GeneralInvoice JSON](#generalinvoice-json)
  - [Canonical Representation](#canonical-representation)
  - [MajikInvoice JSON](#majikinvoice-json)
- [Cloud Envelope](#cloud-envelope)
- [Synchronization and Conflicts](#synchronization-and-conflicts)
- [Batch Operations](#batch-operations)
- [Dashboard Statistics](#dashboard-statistics)
    - [Counts](#counts)
    - [Monetary totals](#monetary-totals)
    - [Taxes and settlement](#taxes-and-settlement)
    - [Relationships](#relationships)
    - [Temporal information](#temporal-information)
- [CSV Column System](#csv-column-system)
- [CSV Export Result](#csv-export-result)
- [Error Handling](#error-handling)
- [Security Architecture](#security-architecture)
  - [Signing](#signing-1)
  - [Encryption](#encryption)
- [Canonical Signing Context](#canonical-signing-context)
- [API Surface](#api-surface)
  - [Domain classes](#domain-classes)
  - [MajikInvoice types](#majikinvoice-types)
  - [CSV primitives](#csv-primitives)
  - [Cryptographic utilities](#cryptographic-utilities)
- [Example Workflow](#example-workflow)
- [Intended Use](#intended-use)
- [Related Majikah Projects](#related-majikah-projects)
  - [Majik Key](#majik-key)
  - [Majik Signature](#majik-signature)
  - [Majik Envelope](#majik-envelope)
  - [Majik Money](#majik-money)
- [Repository](#repository)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Author](#author)


---

## Overview

### `GeneralInvoice`

`GeneralInvoice` represents the actual invoice and its business meaning.

It handles:

- issuer and recipient information;
- invoice identity and numbering;
- invoice types and lifecycle status;
- dates, payment terms, and billing periods;
- line items;
- discounts;
- additive and withholding taxes;
- tax inclusivity;
- invoice totals and financial breakdowns;
- payment and proof-of-payment records;
- accounting metadata;
- journal-entry and sub-ledger projections;
- validation;
- serialization/deserialization;
- canonical representations;
- CSV export.

`GeneralInvoice` does not require a cryptographic envelope to represent or calculate an invoice.

### `MajikInvoice`

`MajikInvoice` wraps the business document in a security-aware envelope.

It adds:

- signed-only and encrypted-and-signed modes;
- content hashing and integrity metadata;
- digital signatures;
- expected-signer allowlists;
- multi-signature workflows;
- sealing;
- recipient-based encryption;
- decryption and runtime decrypted state;
- public invoice summaries;
- encrypted payload handling;
- batch signing and verification;
- batch CSV export;
- JSON and binary serialization;
- cloud envelope serialization;
- synchronization and conflict helpers;
- reissue and restart workflows.

The separation is intentional:

> `GeneralInvoice` answers **“What is this invoice?”**  
> `MajikInvoice` answers **“How is this invoice protected, transported, signed, and verified?”**

---

## Design Principles

### Immutable domain state

Invoice state is modeled as immutable snapshots.

Operations that change the invoice return a new instance instead of modifying the original object. This applies to normal invoice mutations as well as security-sensitive workflows such as signing, sealing, reissuing, and mode changes.

This makes invoice transformations easier to reason about and prevents accidental mutation of previously created document states.

### Accounting first, cryptography second

The accounting model remains usable without the cryptographic envelope.

This means applications that only need invoice creation, tax calculation, totals, reporting, accounting projections, or CSV export do not need to adopt the full security workflow.

### Public metadata can remain accessible

Encrypted invoices do not expose their full business payload until decryption succeeds.

At the same time, `MajikInvoice` maintains a `PublicInvoiceSummary` containing selected non-secret information such as:

- issuer name;
- recipient name;
- currency;
- total amount when available;
- formatted total;
- invoice type;
- issue date;
- due date;
- invoice number;
- invoice status;
- payment status.

This allows encrypted invoices to remain identifiable and manageable without requiring their private payload to be opened.

### Cryptographic state is explicit

`MajikInvoice` distinguishes between:

- unsigned documents;
- partially signed documents;
- fully signed documents;
- sealed documents;
- invalid states.

Signing, verification, encryption, decryption, and sealing are therefore explicit domain operations rather than implicit side effects.

---

# Features

## General Invoice Domain

- Structured invoice parties with legal names, TINs, email, and address data.
- Currency-aware monetary calculations through `@thezelijah/majik-money`.
- Line-item validation and calculation.
- Invoice-level and line-level taxes.
- Additive and withholding tax support.
- Inclusive and exclusive tax handling.
- Discounts.
- Derived invoice totals.
- Payment and proof-of-payment tracking.
- Invoice lifecycle enforcement.
- Accounting projections.
- Serialization and canonical representations.
- Single-invoice CSV export.

## Cryptographic Invoice Envelope

- `signed-only` mode.
- `encrypted-and-signed` mode.
- Content hashing.
- Digital signature collection.
- Signature verification.
- Expected signer allowlists.
- Multi-signature workflows.
- Sealing after required signatures are present.
- Recipient-based encrypted payloads.
- Runtime decryption cache.
- Public invoice summaries.
- Cryptographic validation.
- Reissue workflows after document changes.

## Batch Workflows

`MajikInvoice` also provides batch-oriented operations for workflows involving multiple invoices, including:

- batch signing;
- batch verification;
- batch CSV export;
- batch-oriented status/statistics processing;
- synchronization and conflict analysis.

## CSV Export

CSV functionality is implemented around reusable column descriptors.

The export system supports:

- standard default columns;
- complete static column catalogs;
- custom column selection;
- grouped columns for UI selection;
- dynamic tax-type columns;
- full invoice data when available;
- public-summary fallback for encrypted invoices;
- per-invoice partial-export reporting;
- row-level error isolation;
- duplicate-column removal;
- CSV-safe escaping;
- optional newline preservation.

Example:

```ts
const csv = invoice.toCSV();
```

Or with custom columns:

```ts
const csv = invoice.toCSV([
  ...DEFAULT_CSV_COLUMNS,
  ...myCustomColumns,
]);
```

Batch export:

```ts
const result = await MajikInvoice.batchExportToCSV(invoices);

console.log(result.csv);
console.log(result.count);
console.log(result.success);
console.log(result.partialExports);
console.log(result.errors);
```

Dynamic tax columns can be generated when the tax types in an invoice population are known:

```ts
const taxColumns = buildTaxBreakdownColumns(["VAT", "EWT"]);

const columns = [
  ...DEFAULT_CSV_COLUMNS,
  ...taxColumns,
];
```

---

# Installation

Install the package:

```bash
npm install @majikah/majik-invoice
```

`GeneralInvoice` uses the Majik Money package for currency-aware monetary operations:

```bash
npm install @thezelijah/majik-money
```

For cryptographic `MajikInvoice` workflows, install the relevant Majikah packages:

```bash
npm install @majikah/majik-key @majikah/majik-signature @majikah/majik-envelope
```

The cryptographic dependencies are used for different responsibilities:

* `@majikah/majik-key` — key management and account/key material.
* `@majikah/majik-signature` — signing and signature verification.
* `@majikah/majik-envelope` — encrypted envelope creation and decryption.

Applications that only use `GeneralInvoice` do not need to create or manage cryptographic keys.

---

# GeneralInvoice

## Creating an Invoice

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

  recipient: {
    legalName: "Beta Inc",
    tin: "987-654-321-000",
  },

  currency: "PHP",

  defaultTaxes: [
    {
      taxType: "VAT",
      rate: 0.12,
    },
  ],

  lineItems: [
    {
      description: "Web Development",
      quantity: 1,
      unitPrice: 50000,
    },
    {
      description: "UI Design",
      quantity: 3,
      unitPrice: 8000,
    },
  ],
});
```

The resulting invoice calculates its derived monetary values from the configured line items, discounts, and taxes.

---

## Reading Totals

```ts
console.log(invoice.totals);
console.log(invoice.totals.grandTotal.format());
console.log(invoice.totals.hasTax);
```

`InvoiceTotals` provides the derived financial view of the invoice, including values such as:

* subtotal;
* discount total;
* tax total;
* withholding total;
* grand total;
* net payable;
* effective tax rate;
* tax-state flags.

The same underlying calculations are also exposed through `GeneralInvoice` getters.

---

## Immutable Mutations

Invoice mutations return a new `GeneralInvoice`.

```ts
const updated = invoice
  .withLineItem({
    description: "Hosting",
    quantity: 1,
    unitPrice: 5000,
  })
  .withInvoiceNumber("INV-2026-001")
  .withStatus("issued");

console.log(invoice.lineItems.length);
console.log(updated.lineItems.length);
```

The original invoice remains unchanged.

---

## Updating a Line Item

```ts
const lineItemId = invoice.lineItems[0].id;

const corrected = invoice.withUpdatedLineItem(lineItemId, {
  quantity: 2,
  unitPrice: 45000,
});
```

Line-item mutations validate the resulting item and rebuild invoice-level derived values.

---

# Taxes

`GeneralInvoice` supports both invoice-level and line-level tax behavior.

Typical operations include:

* adding taxes;
* replacing taxes;
* removing taxes;
* changing tax inclusivity;
* applying taxes to line items;
* inspecting tax types;
* calculating totals by tax type;
* calculating withholding by tax type.

For example:

```ts
const vatTotal = invoice.taxTotalByType("VAT");

const ewtTotal = invoice.withholdingTotalByType("EWT");
```

Tax calculations distinguish additive taxes from withholding taxes, allowing the invoice to represent both tax charged on the document and amounts withheld from settlement.

---

# Accounting Projections

Invoices can be projected into accounting-oriented structures.

### Journal entry

```ts
const journalEntry = invoice.toJournalEntry();
```

The journal projection validates that the resulting entry is balanced.

### Sub-ledger entry

```ts
const subLedgerEntry = invoice.toSubLedgerEntry();
```

These projections can work with an accounting context or chart-of-accounts configuration where supported by the invoice API.

Accounting metadata such as account codes and cost centers can also be retained on the invoice.

---

# Invoice Types

`InvoiceType` acts as the document/accounting branch discriminator.

The current supported values include:

```text
commercial
proforma
credit
debit
tax
government
intercompany
project
recurring
forensic
environmental
```

The selected invoice type can affect accounting and document behavior where a specific branch is implemented.

---

# Lifecycle

`GeneralInvoice` enforces invoice lifecycle transitions rather than allowing arbitrary status changes.

Use:

```ts
const issued = invoice.withStatus("issued");
```

Attempting an invalid transition produces an `InvoiceLifecycleError`.

This allows higher-level applications to rely on the invoice object to enforce its documented lifecycle rules instead of duplicating those checks externally.

---

# MajikInvoice

`MajikInvoice` is the security and transport layer surrounding a `GeneralInvoice`.

It supports two primary modes.

## `signed-only`

```ts
const signed = await MajikInvoice.create({
  mode: "signed-only",
  signerKey: aliceKey,

  issuer: {
    legalName: "Alice Corporation",
  },

  recipient: {
    legalName: "Bob Inc",
  },

  currency: "PHP",

  lineItems: [
    {
      description: "Design Services",
      quantity: 1,
      unitPrice: 50000,
    },
  ],
});
```

A signed-only invoice keeps the underlying `GeneralInvoice` accessible while adding cryptographic integrity and signatures.

---

## `encrypted-and-signed`

```ts
const encrypted = await MajikInvoice.create({
  mode: "encrypted-and-signed",
  signerKey: aliceKey,
  recipients: [bobRecipient],

  issuer: {
    legalName: "Alice Corporation",
  },

  recipient: {
    legalName: "Bob Inc",
  },

  currency: "PHP",

  lineItems: [
    {
      description: "Confidential Services",
      quantity: 1,
      unitPrice: 100000,
    },
  ],
});
```

In this mode, the invoice payload is encrypted for the configured recipients and cryptographically signed.

The public summary remains available even while the underlying invoice contents are encrypted.

---

# MajikInvoice Status

`MajikInvoice` maintains a security-oriented status separate from the normal business invoice status.

The supported envelope states are:

```text
invalid
unsigned
partially-signed
fully-signed
sealed
```

This distinction is important because a business invoice can be `issued`, `paid`, `void`, or another `InvoiceStatus` while the cryptographic envelope independently tracks its signing/sealing state.

---

# Signing

Signatures are stored in the invoice integrity block.

The signing system is provided by `@majikah/majik-signature`, which uses the Majikah hybrid signature model based on:

* Ed25519
* ML-DSA-87 (FIPS 204)

A document can therefore carry the signature metadata required for verification while keeping the business invoice model separate from the signing implementation.

---

# Multi-Signature Workflows

`MajikInvoice` supports expected-signer allowlists.

For example:

```ts
const invoice = await MajikInvoice.create({
  mode: "signed-only",
  signerKey: aliceKey,

  expectedSigners: [
    {
      signerId: aliceKey.fingerprint,
      label: "Issuer",
    },
    {
      signerId: bobKey.fingerprint,
      label: "Approver",
    },
  ],

  issuer: {
    legalName: "Alice Corporation",
  },

  recipient: {
    legalName: "Bob Inc",
  },

  currency: "PHP",

  lineItems: [
    {
      description: "Services",
      quantity: 1,
      unitPrice: 50000,
    },
  ],
});
```

Another expected signer can then sign:

```ts
const cosigned = await invoice.sign(bobKey);
```

The signatures are accumulated in the invoice integrity block.

---

# Sealing

Once the required signing conditions are satisfied, an invoice can be sealed.

```ts
const sealed = await cosigned.seal(aliceKey);
```

A sealed invoice represents a finalized cryptographic state and prevents ordinary further signing activity.

The integrity block records sealing information in addition to the collected signatures.

---

# Verification

Verification operates against the cryptographic integrity information stored by `MajikInvoice`.

Typical workflows include:

```ts
const verified = await invoice.verify();
```

and batch verification for collections of invoices.

The package also exposes validation and capability checks so applications can determine whether an invoice can currently be decrypted, signed, sealed, or otherwise operated on before attempting the operation.

---

# Decryption

Encrypted invoices can be decrypted with an appropriate recipient key.

```ts
if (invoice.canDecrypt(bobKey)) {
  const decrypted = await invoice.decrypt(bobKey);

  console.log(decrypted.totalAmount);
}
```

The decrypted `GeneralInvoice` is treated as runtime state associated with the envelope.

The package distinguishes between:

* the encrypted persisted payload;
* the public summary;
* the temporarily available decrypted invoice.

The runtime decrypted cache is not part of the persisted `MajikInvoiceJSON` representation.

---

# Public Invoice Summary

Encrypted invoices expose a `PublicInvoiceSummary` containing selected non-secret metadata.

It includes fields such as:

```ts
{
  issuerName,
  recipientName,
  currency,
  totalAmount,
  formattedTotal,
  invoiceType,
  issuedAt,
  dueDate,
  invoiceNumber,
  status,
  paymentStatus,
}
```

This enables applications to display, identify, sort, and report on encrypted invoices without necessarily decrypting their complete business payload.

---

# Reissuing

A cryptographically signed invoice must not simply reuse its old signatures after the underlying business document changes.

Instead, create the modified `GeneralInvoice` and reissue the envelope:

```ts
const updatedInvoice = invoice.invoice.withLineItem({
  description: "Additional Work",
  quantity: 2,
  unitPrice: 5000,
});

const reissued = await invoice.reissue(updatedInvoice, {
  signerKey: aliceKey,
  recipients: [bobRecipient],
});
```

Reissuing creates a new cryptographic state appropriate to the changed invoice contents.

Existing signatures are not treated as valid proof for the modified document.

---

# Serialization

## GeneralInvoice JSON

```ts
const json = invoice.toJSON();

const restored = GeneralInvoice.fromJSON(json);
```

`GeneralInvoice` serialization preserves the document's structured business data and monetary values.

---

## Canonical Representation

Canonical representations are available for cryptographic and deterministic workflows.

```ts
const canonicalBytes = invoice.toCanonicalBytes();
```

The canonical representation is intended to provide stable byte-level input for signing and integrity operations.

---

## MajikInvoice JSON

`MajikInvoice` has its own persisted representation:

```ts
const json = majikInvoice.toJSON();
```

The persisted envelope contains concepts such as:

* schema/version information;
* invoice ID;
* security mode;
* public summary;
* encrypted or signed payload;
* content hash;
* signatures;
* expected signers;
* sealing information;
* creation/update timestamps;
* recipients.

The runtime decrypted cache is intentionally separate from this persisted representation.

---

# Cloud Envelope

`MajikInvoice` also supports a cloud-facing envelope representation through `MajikahInvoiceJSON`.

In addition to the local invoice representation, this structure can carry cloud/account routing information such as:

* `user_id`;
* `account_id`;
* `public_key`;
* remote status;
* `sent_at`.

This allows the local cryptographic invoice model to be represented in a cloud synchronization/storage context without changing the underlying invoice domain model.

---

# Synchronization and Conflicts

The package contains synchronization primitives for comparing local and remote invoice states.

Supported synchronization states include:

```text
synced
conflict
local-only
remote-only
```

Conflict resolution strategies include:

```text
latest-wins
local-wins
remote-wins
```

`InvoiceDiff` can be used to inspect whether important parts of two invoice states differ, including:

* content;
* invoice number;
* security mode;
* invoice status;
* update timestamp;
* content hash.

These primitives are intended to support application-level synchronization workflows rather than acting as a remote database themselves.

---

# Batch Operations

`MajikInvoice` provides batch-oriented APIs for working with multiple envelopes.

These include workflows for operations such as:

* signing;
* verification;
* export;
* statistics and dashboard processing.

Batch operations return structured results so callers can distinguish successful work, partial results, and errors instead of treating a whole batch as a single opaque success/failure state.

---

# Dashboard Statistics

Invoice collections can also be analyzed into aggregate statistics through `DashboardStats`.

The statistics model covers multiple dimensions of an invoice population, including:

### Counts

* total invoices;
* paid;
* partial;
* overdue;
* draft;
* void;
* encrypted;
* unsigned.

### Monetary totals

* total amount;
* paid amount;
* partial amount;
* unpaid amount;
* overdue amount;
* total collected;
* total outstanding;
* average invoice value;
* largest invoice;
* smallest invoice;
* median invoice value.

### Taxes and settlement

* tax collected;
* withholding total;
* net payable;
* discounts given;
* effective tax rate;
* tax breakdown by type.

### Relationships

* top recipients;
* recipient totals and counts;
* unique recipients;
* unique issuers.

### Temporal information

* oldest invoice date;
* newest invoice date;
* due-soon count;
* average days to payment.

---

# CSV Column System

The CSV API is intentionally extensible.

A custom column can be defined using `CSVColumn`:

```ts
const invoiceNumberColumn = {
  key: "invoiceNumber",
  label: "Invoice Number",
  group: "identity",

  resolve: ({ invoice, public: pub }) =>
    invoice?.invoiceNumber ??
    pub?.invoiceNumber ??
    "",
};
```

Built-in columns are grouped into:

```text
identity
parties
dates
totals
tax
line_items
payment
accounting
meta
```

The complete static catalog is available through:

```ts
ALL_CSV_COLUMNS
```

The standard export set is:

```ts
DEFAULT_CSV_COLUMNS
```

Dynamic tax columns can be generated through:

```ts
buildTaxBreakdownColumns(...)
```

Columns can also be deduplicated using:

```ts
dedupeColumns(...)
```

---

# CSV Export Result

Batch CSV export returns a structured `CSVExportResult`:

```ts
{
  csv,
  count,
  success,
  partialExports,
  errors,
}
```

This is particularly useful for encrypted invoice populations.

An encrypted invoice with no decrypted runtime cache can still be exported using the information available through its public summary. Such rows are reported as partial exports rather than being silently treated as fully populated invoices.

---

# Error Handling

The package exposes dedicated error classes for different failure domains.

Common errors include:

| Error                            | Purpose                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `InvoiceValidationError`         | Invalid `GeneralInvoice` input or state                     |
| `InvoiceLifecycleError`          | Invalid invoice lifecycle transition                        |
| `InvoiceMutationError`           | Mutation attempted when the invoice is not editable         |
| `InvoiceProjectionError`         | Accounting projection failure                               |
| `LineItemValidationError`        | Invalid line-item data                                      |
| `MajikInvoiceError`              | Base class for MajikInvoice-specific failures               |
| `MajikInvoiceKeyError`           | Missing, invalid, or unavailable cryptographic key material |
| `MajikInvoiceEncryptionError`    | Encryption or decryption failure                            |
| `MajikInvoiceSignatureError`     | Signing or signature-verification failure                   |
| `MajikInvoiceSealError`          | Invalid sealing or signer/allowlist operation               |
| `MajikInvoiceSerializationError` | Invalid or malformed persisted envelope data                |

Keeping these error domains separate allows applications to respond differently to accounting, lifecycle, serialization, and cryptographic failures.

---

# Security Architecture

`MajikInvoice` delegates cryptographic primitives to dedicated Majikah packages rather than implementing an independent cryptographic stack inside the invoice domain model.

## Signing

Signing and verification are provided through:

```text
@majikah/majik-signature
```

The Majikah signature layer uses a hybrid signature design combining:

```text
Ed25519
+
ML-DSA-87 (FIPS 204)
```

## Encryption

Encrypted invoice payloads use:

```text
@majikah/majik-envelope
```

The envelope layer uses a post-quantum key encapsulation and authenticated encryption construction based on:

```text
ML-KEM-768
+
AES-256-GCM
```

The invoice package itself is responsible for applying these cryptographic building blocks to invoice-specific content and maintaining the invoice envelope state.

---

# Canonical Signing Context

MajikInvoice signing binds the invoice content to the invoice identity.

The signing preimage is constructed using a versioned domain-separation prefix:

```text
majik-invoice-v1
```

together with the canonical content hash and invoice ID.

This prevents the signature from being interpreted as a generic signature over unrelated content and binds the cryptographic proof to the specific invoice envelope.

---

# API Surface

The package is centered around the following core types and utilities.

## Domain classes

```text
GeneralInvoice
InvoiceTotals
LineItem
TaxManager
MajikInvoice
```

## MajikInvoice types

```text
MajikInvoiceMode
MajikInvoiceStatus
PublicInvoiceSummary
SignedOnlyPayload
EncryptedPayload
MajikInvoicePayload
IntegrityBlock
DecryptedCache
MajikInvoiceInput
MajikInvoiceJSON
MajikahInvoiceJSON
MajikInvoiceValidationResult
DashboardStats
InvoiceSignature
SyncStatus
ConflictResolutionStrategy
InvoiceDiff
```

## CSV primitives

```text
CSVColumn
CSVColumnGroup
CSVResolveContext
CSVExportResult
CSVEscapeOptions
ALL_CSV_COLUMNS
DEFAULT_CSV_COLUMNS
buildTaxBreakdownColumns()
buildCSVHeader()
buildCSVRow()
dedupeColumns()
```

## Cryptographic utilities

```text
sha256Hex()
canonicalBytesForSigning()
toUtf8Bytes()
fromUtf8Bytes()
```

---

# Example Workflow

A typical secure invoice workflow can be modeled as:

```text
GeneralInvoice.create()
        │
        ▼
Business validation
        │
        ▼
MajikInvoice.create()
        │
        ├── signed-only
        │
        └── encrypted-and-signed
                │
                ▼
        recipient encryption
                │
                ▼
        signature(s)
                │
                ▼
        verification
                │
                ▼
            seal()
                │
                ▼
       persist / transmit
                │
                ▼
       decrypt when authorized
                │
                ▼
       use GeneralInvoice
```

When the underlying invoice must change, the workflow becomes:

```text
Existing MajikInvoice
        │
        ▼
Create modified GeneralInvoice
        │
        ▼
reissue()
        │
        ▼
New cryptographic state
        │
        ▼
Re-sign / re-encrypt as required
```

---

# Intended Use

`@majikah/majik-invoice` is suitable for applications that need a structured invoice domain model and may also require cryptographic document workflows.

Examples include:

* invoicing systems;
* accounting applications;
* AR/AP workflows;
* B2B document exchange;
* document approval pipelines;
* signed business records;
* encrypted financial documents;
* multi-party approval processes;
* invoice synchronization systems;
* reporting and CSV export pipelines.

The package provides the domain primitives; storage, transport, UI, cloud synchronization, user identity, and application-specific policy remain the responsibility of the consuming application.

---

# Related Majikah Projects

## [Majik Key](https://www.npmjs.com/package/@majikah/majik-key)
[![ZENODO](https://img.shields.io/badge/Read_the_Technical_Whitepaper_Here-1682D4?style=for-the-badge&logo=zenodo&logoColor=white)](https://doi.org/10.5281/zenodo.21339132)

Cryptographic key and account-management library used throughout the Majikah ecosystem.

MajikInvoice uses Majik Key material for signing and recipient-based cryptographic workflows.

[Read more about Majik Key here](https://majikah.solutions/articles/majik-key-whitepaper)

## [Majik Signature](https://www.npmjs.com/package/@majikah/majik-signature)

[![Majik Signature Hero](https://github.com/user-attachments/assets/e2843b67-a04c-4119-9ec2-196d746524b8)](https://signature.majikah.solutions)

Hybrid digital signature library providing signing and verification using Ed25519 and ML-DSA-87.

MajikInvoice uses this package for document signatures and signature verification.

## [Majik Envelope](https://www.npmjs.com/package/@majikah/majik-envelope)

Cryptographic envelope library providing encrypted payload handling, recipient key encapsulation, and authenticated encryption.

MajikInvoice uses this package for `encrypted-and-signed` invoice payloads.

## [Majik Money](https://www.npmjs.com/package/@thezelijah/majik-money)

Currency-aware monetary primitives used by the invoice accounting layer.

---

# Repository

GitHub:

https://github.com/Majikah/majik-invoice

npm:

https://www.npmjs.com/package/@majikah/majik-invoice

---

# Contributing

Contributions, bug reports, documentation improvements, and feature discussions are welcome.

For application-level bugs, API issues, accounting behavior, or developer experience problems, open a GitHub issue with enough information to reproduce the behavior.

For security-sensitive vulnerabilities, use the project's private vulnerability-reporting channel or contact:

**[business@majikah.solutions](mailto:business@majikah.solutions)**

When reporting a bug, include the package version, runtime/environment, relevant input, expected behavior, actual behavior, and a stack trace when one is available.

---

# Security

Please do not disclose potentially exploitable vulnerabilities in public issues.

Security-related reports should be submitted privately through GitHub's private vulnerability reporting mechanism or by email:

**[business@majikah.solutions](mailto:business@majikah.solutions)**

Public GitHub issues are appropriate for normal application bugs, API issues, UX concerns, documentation problems, and non-sensitive implementation defects.

---

# License

Licensed under the [Apache License 2.0](LICENSE).

Copyright © Majikah Solutions OPC.

---

# Author

Developed by **Josef Elijah Fabian (Zelijah)**.

Founder and lead developer of **Majikah Solutions OPC**.

* Website: https://majikah.solutions
* GitHub: https://github.com/jedlsf
* Project: https://github.com/Majikah/majik-invoice
* Business: [business@majikah.solutions](mailto:business@majikah.solutions)

**Your vision, my magic.**

```

