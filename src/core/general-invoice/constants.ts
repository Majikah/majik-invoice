/**

* @file constants.ts
*
* @description
* Shared compile-time and runtime constants for the `@majikah/majik-invoice`
* domain.
*
* This module centralizes:
* * serialized schema versioning
* * default accounting account codes
* * invoice lifecycle transition rules
* * supported tax-type identifiers
*
* These constants are consumed by domain classes such as `GeneralInvoice`,
* `TaxManager`, and accounting projection utilities.
  */

import { InvoiceStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**

* Current serialized invoice schema version.
*
* Bump this value whenever the persisted/serialized invoice shape changes in
* a way that requires consumers, migration logic, or deserializers to
* distinguish the new representation from an older one.
*
* This version describes the **data schema**, not the invoice lifecycle or
* application release version.
*
* @example
* ```ts
  ```
* invoice.version === SCHEMA_VERSION;
* ```
  ```

*/
export const SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Default Chart of Accounts
// ---------------------------------------------------------------------------

/**

* Default Chart of Accounts codes used by invoice accounting projections.
*
* These codes provide sensible defaults for journal-entry and sub-ledger
* projections when an {@link AccountingContext} does not provide explicit
* account overrides.
*
* The values are immutable at runtime and preserve literal types through
* `as const`.
*
* @example
* ```ts
  ```
* DEFAULT_ACCOUNTS.receivable; // "1200"
* DEFAULT_ACCOUNTS.revenue;    // "4000"
* ```
  ```

*/
export const DEFAULT_ACCOUNTS = {
  /**

* Accounts Receivable account.
*
* Used when the invoice creates or updates a receivable balance.
  */
  receivable: "1200",

  /**

* Accounts Payable account.
*
* Available for accounting contexts that represent payable-side documents.
  */
  payable: "2000",

  /**

* Default revenue account.
*
* Used for line items that do not specify their own `accountCode`.
  */
  revenue: "4000",

  /**

* Default expense account.
*
* Available for expense-oriented accounting contexts.
  */
  expense: "5000",

  /**

* Default tax payable account.
*
* Used for additive tax amounts in journal-entry projections.
  */
  tax: "2100",

  /**

* Default cash account.
*
* Available to settlement/payment accounting integrations.
  */
  cash: "1000",

  /**

* Default discount account.
*
* Available to accounting integrations that separately post discounts.
  */
  discount: "4900",
} as const;

// ---------------------------------------------------------------------------
// Valid lifecycle transitions
// ---------------------------------------------------------------------------

/**

* Invoice lifecycle transition table.
*
* Each property represents a possible current (`FROM`) status and its value
* lists the statuses that may be transitioned to directly.
*
* `GeneralInvoice.withStatus()` uses this table to enforce lifecycle
* transitions unless a forced transition is explicitly requested.
*
* ### Transition semantics
*
* * `draft` can be issued or voided.
* * `issued` can move into delivery, settlement, dispute, or void states.
* * `sent` and `viewed` can continue through settlement/dispute/void flows.
* * `partial` can become fully paid, disputed, or void.
* * `paid` can only transition to void.
* * `overdue` can return to payment-related states, become disputed, or void.
* * `disputed` can be reissued or voided.
* * `void` has no outgoing transitions and is therefore terminal.
*
* The arrays intentionally include each status's direct allowed destinations,
* rather than attempting to encode business rules such as whether an invoice
* is actually overdue or sufficiently paid. Those conditions are enforced by
* higher-level domain methods where necessary.
*
* @example
* ```ts
  ```
* ALLOWED_TRANSITIONS.draft;
* // ["draft", "issued", "void"]
* ```
  ```

*/
export const ALLOWED_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  /**

* Draft invoices may remain draft, be issued, or be voided.
  */
  draft: ["draft", "issued", "void"],

  /**

* Issued invoices may proceed into delivery, settlement, dispute, or void.
  */
  issued: ["sent", "viewed", "partial", "paid", "disputed", "void", "overdue"],

  /**

* Sent invoices may proceed into viewing, settlement, dispute, or void.
  */
  sent: ["viewed", "partial", "paid", "disputed", "void"],

  /**

* Viewed invoices may proceed into settlement, dispute, or void.
  */
  viewed: ["partial", "paid", "disputed", "void"],

  /**

* Partially paid invoices may become fully paid, disputed, or void.
  */
  partial: ["paid", "disputed", "void"],

  /**

* Paid invoices may transition only to void.
  */
  paid: ["void"],

  /**

* Overdue invoices may receive payment, be disputed, or be voided.
  */
  overdue: ["paid", "partial", "disputed", "void"],

  /**

* Disputed invoices may be reissued or voided.
  */
  disputed: ["issued", "void"],

  /**

* Voided invoices are terminal and cannot transition to another status.
  */
  void: [],
};

// ---------------------------------------------------------------------------
// Tax Types Registry
// ---------------------------------------------------------------------------

/**

* Canonical tax-type identifiers recognized by the invoice domain.
*
* `TAX_TYPES` provides a centralized registry for common Philippine/BIR and
* international tax categories so applications can avoid scattering literal
* strings such as `"VAT"` or `"EWT"` throughout their code.
*
* The registry is intentionally divided conceptually into:
*
* * Philippine/BIR tax categories
* * international/common consumption taxes
* * withholding categories
* * industry/regulatory taxes
* * informational/classification identifiers
*
* The registry values are immutable string literals through `as const`.
*
* @example
* ```ts
  ```
* const taxType = TAX_TYPES.VAT;
*
* TaxManager.fromOne({
* taxType,
* rate: 0.12,
* });
* ```
  ```
*
* @see TaxType
  */
export const TAX_TYPES = {
  // ────────────────────────────────────────────────────────────────────────
  // 🇵🇭 PHILIPPINES — BIR (Core)
  // ────────────────────────────────────────────────────────────────────────

  /**

* Philippine Value-Added Tax.
*
* Intended for standard VAT classification.
  */
  VAT: "VAT",

  /**

* Zero-rated Philippine VAT classification.
*
* Represents a VAT treatment with a zero rate rather than an absence of
* tax classification.
  */
  ZERO_RATED_VAT: "ZERO_RATED_VAT",

  /**

* VAT-exempt transaction classification.
*
* Used to distinguish exempt transactions from zero-rated transactions.
  */
  VAT_EXEMPT: "VAT_EXEMPT",

  // ── Withholding Taxes ───────────────────────────────────────────────────

  /**

* Expanded Withholding Tax classification.
  */
  EWT: "EWT",

  /**

* Creditable Withholding Tax classification.
*
* Provided as a separate canonical identifier for integrations that use
* `CWT` terminology.
  */
  CWT: "CWT",

  // ── Specific EWT categories ─────────────────────────────────────────────

  /**

* Expanded withholding tax on professional fees.
  */
  EWT_PROFESSIONAL_FEES: "EWT_PROFESSIONAL_FEES",

  /**

* Expanded withholding tax associated with rentals.
  */
  EWT_RENTALS: "EWT_RENTALS",

  /**

* Expanded withholding tax associated with contractors.
  */
  EWT_CONTRACTORS: "EWT_CONTRACTORS",

  /**

* Expanded withholding tax associated with suppliers.
  */
  EWT_SUPPLIERS: "EWT_SUPPLIERS",

  // ── Final Withholding Taxes ─────────────────────────────────────────────

  /**

* Final Withholding Tax classification.
  */
  FWT: "FWT",

  // ── Percentage Tax ──────────────────────────────────────────────────────

  /**

* Philippine percentage tax classification for applicable non-VAT
* transactions.
  */
  PERCENTAGE_TAX: "PERCENTAGE_TAX",

  // ── Excise Tax ───────────────────────────────────────────────────────────

  /**

* Philippine-specific excise tax classification.
  */
  EXCISE_TAX_PH: "EXCISE_TAX_PH",

  // ── Documentary Stamp Tax ───────────────────────────────────────────────

  /**

* Documentary Stamp Tax classification.
  */
  DST: "DST",

  // ── Local Government Taxes ───────────────────────────────────────────────

  /**

* Local business tax classification.
  */
  LOCAL_BUSINESS_TAX: "LOCAL_BUSINESS_TAX",

  /**

* Real property tax classification.
  */
  REAL_PROPERTY_TAX: "REAL_PROPERTY_TAX",

  // ────────────────────────────────────────────────────────────────────────
  // 🌍 GLOBAL — Common Tax Types
  // ────────────────────────────────────────────────────────────────────────

  /**

* Goods and Services Tax classification.
  */
  GST: "GST",

  /**

* Harmonized Sales Tax classification.
*
* Commonly associated with Canadian tax systems.
  */
  HST: "HST",

  /**

* General sales-tax classification, such as US-style sales taxes.
  */
  SALES_TAX: "SALES_TAX",

  /**

* Generic consumption-tax classification.
  */
  CONSUMPTION_TAX: "CONSUMPTION_TAX",

  // ── EU / International VAT variants ────────────────────────────────────

  /**

* Standard-rate international VAT classification.
  */
  VAT_STANDARD: "VAT_STANDARD",

  /**

* Reduced-rate international VAT classification.
  */
  VAT_REDUCED: "VAT_REDUCED",

  /**

* VAT classification for digital services.
  */
  VAT_DIGITAL_SERVICES: "VAT_DIGITAL_SERVICES",

  // ── Global Withholding ─────────────────────────────────────────────────

  /**

* Generic withholding-tax classification.
  */
  WITHHOLDING_TAX: "WITHHOLDING_TAX",

  /**

* Withholding tax associated with dividend payments.
  */
  DIVIDEND_WITHHOLDING_TAX: "DIVIDEND_WITHHOLDING_TAX",

  /**

* Withholding tax associated with royalty payments.
  */
  ROYALTY_WITHHOLDING_TAX: "ROYALTY_WITHHOLDING_TAX",

  // ── Industry / Regulatory ───────────────────────────────────────────────

  /**

* Generic excise-tax classification.
  */
  EXCISE_TAX: "EXCISE_TAX",

  /**

* Import duty classification.
  */
  IMPORT_DUTY: "IMPORT_DUTY",

  /**

* Customs duty classification.
  */
  CUSTOMS_DUTY: "CUSTOMS_DUTY",

  /**

* Environmental tax classification.
  */
  ENVIRONMENTAL_TAX: "ENVIRONMENTAL_TAX",

  /**

* Carbon-tax classification.
  */
  CARBON_TAX: "CARBON_TAX",

  /**

* Luxury-tax classification.
  */
  LUXURY_TAX: "LUXURY_TAX",

  // ── Informational / Classification ──────────────────────────────────────

  /**

* Generic tax-exempt classification.
*
* Intended for tax classification/disclosure rather than necessarily
* implying a particular jurisdiction-specific exemption regime.
  */
  TAX_EXEMPT: "TAX_EXEMPT",

  /**

* Generic zero-rated classification.
*
* Used when a transaction is classified as zero-rated without selecting
* a jurisdiction-specific zero-rated tax identifier.
  */
  ZERO_RATED: "ZERO_RATED",
} as const;

/**

* Union of every canonical tax-type value registered in {@link TAX_TYPES}.
*
* This allows APIs to use the registry for autocomplete and type safety while
* still keeping the runtime values as simple strings.
*
* @example
* ```ts
  ```
* const taxType: TaxType = TAX_TYPES.VAT;
*
* // Type-safe access to a registered tax identifier.
* ```
  ```
*
* @remarks
* `TaxDetail.taxType` remains a plain `string` so integrations can represent
* jurisdiction-specific or application-defined tax identifiers outside the
* built-in registry.
  */
export type TaxType = (typeof TAX_TYPES)[keyof typeof TAX_TYPES];
