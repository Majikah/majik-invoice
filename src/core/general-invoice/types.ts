/**

* @file types.ts
* @description Shared domain vocabulary for the `@majikah/majik-invoice` package.
*
* This module contains the primitive types, input shapes, serialized shapes,
* accounting structures, tax definitions, and derived result types used by the
* invoice domain.
*
* This file intentionally contains:
* * no cryptographic dependencies
* * no invoice calculation logic
* * no persistence logic
* * no Majik-specific runtime behaviour
*
* The types defined here form the contract shared by `GeneralInvoice`,
* `LineItem`, `InvoiceTotals`, and higher-level invoice APIs.
  */

import { LineItem } from "./line-item.js";

// ---------------------------------------------------------------------------
// ISO Primitives
// ---------------------------------------------------------------------------

/**

* Calendar date represented as an ISO 8601 `YYYY-MM-DD` string.
*
* This type intentionally remains a string alias so it can be passed directly
* across JSON boundaries and external APIs.
*
* @example
* ```ts
  ```
* const issueDate: ISODateString = "2026-10-01";
* ```
  ```

*/
export type ISODateString = string;

/**

* Timestamp represented as an ISO 8601 datetime string.
*
* The canonical form used by the invoice domain is UTC with a `Z` suffix.
*
* @example
* ```ts
  ```
* const createdAt: ISODateTimeString = "2026-10-01T08:00:00Z";
* ```
  ```

*/
export type ISODateTimeString = string;

/**

* ISO 4217 three-letter currency code.
*
* The type is intentionally represented as a string so additional ISO 4217
* currencies can be supported without changing the TypeScript union.
*
* @example
* ```ts
  ```
* const currency: CurrencyCode = "PHP";
* ```
  ```

*/
export type CurrencyCode = string;

/**

* ISO 3166-1 alpha-2 country code.
*
* @example
* ```ts
  ```
* const country: CountryCode = "PH";
* ```
  ```

*/
export type CountryCode = string;

// ---------------------------------------------------------------------------
// Invoice Type — accounting branch discriminant
// ---------------------------------------------------------------------------

/**

* Identifies the business/accounting branch represented by an invoice.
*
* `InvoiceType` acts as the primary document-type discriminant used by
* higher-level invoice workflows.
*
* | Value | Typical meaning |
* | --- | --- |
* | `commercial` | Standard commercial or B2B invoice |
* | `proforma` | Preliminary invoice or quotation-like document |
* | `credit` | Credit note or reversal document |
* | `debit` | Debit note or additional-charge document |
* | `tax` | Tax-focused invoice such as a VAT/GST invoice |
* | `government` | Government or public-procurement invoice |
* | `intercompany` | Internal transaction between related entities |
* | `project` | Project or milestone-based billing |
* | `recurring` | Subscription or periodic billing |
* | `forensic` | Invoice/document requiring forensic or audit treatment |
* | `environmental` | Social or environmental accounting context |
*
* @example
* ```ts
  ```
* const type: InvoiceType = "commercial";
* ```
  ```

*/
export type InvoiceType =
  | "commercial"
  | "proforma"
  | "credit"
  | "debit"
  | "tax"
  | "government"
  | "intercompany"
  | "project"
  | "recurring"
  | "forensic"
  | "environmental";

// ---------------------------------------------------------------------------
// Invoice Status
// ---------------------------------------------------------------------------

/**

* Lifecycle state of an invoice.
*
* `InvoiceStatus` represents the persisted/document status of the invoice.
* The runtime-facing `GeneralInvoice.effectiveStatus` getter may additionally
* derive `overdue` from due-date and payment state.
*
* Typical progression is governed by the invoice lifecycle transition table,
* rather than by this type alone.
  */
export type InvoiceStatus =
  | "draft"
  | "issued"
  | "sent"
  | "viewed"
  | "partial"
  | "paid"
  | "overdue"
  | "void"
  | "disputed";

// ---------------------------------------------------------------------------
// Payment Terms
// ---------------------------------------------------------------------------

/**

* Standard payment term presets supported by the invoice domain.
*
* The `custom` value indicates that payment conditions are defined elsewhere
* in the invoice's payment-term data rather than by one of these presets.
  */
export type PaymentTerms =
  | "immediate"
  | "net7"
  | "net15"
  | "net30"
  | "net60"
  | "net90"
  | "eom"
  | "cod"
  | "prepaid"
  | "custom";

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/**

* Structured postal address associated with a {@link Party}.
*
* The structure is intentionally international while supporting fields useful
* for Philippine/BIR-oriented invoice workflows such as `branchCode` and
* `district`.
  */
export interface PartyAddress {
  /**

  * Primary address line.
  *
  * Typically contains the building number, street, unit, or equivalent.
    */
  line1: string;

  /** Optional secondary address line such as unit, floor, or building. */
  line2?: string;

  /** City or municipality. */
  city: string;

  /** Optional state, province, region, or equivalent subdivision. */
  stateOrProvince?: string;

  /** Optional postal or ZIP code. */
  postalCode?: string;

  /** ISO 3166-1 alpha-2 country code. */
  country: CountryCode;

  /**

* Optional branch identifier.
*
* Useful for entities with multiple registered or operating branches.
  */
  branchCode?: string;

  /** Optional district, barangay, or other local administrative area. */
  district?: string;
}

// ---------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------

/**

* Legal or commercial party participating in an invoice.
*
* A `Party` can represent either the invoice issuer or recipient and may
* contain tax, contact, address, and application-specific metadata.
  */
export interface Party {
  /**

  * Registered legal name of the party.
  *
  * This is the primary legal identity used on the invoice.
    */
  legalName: string;

  /** Optional public-facing trade or brand name. */
  tradeName?: string;

  /** Optional description of the party's nature of business. */
  natureOfBusiness?: string;

  /** Optional tax identification number. */
  tin?: string;

  /** Optional identifier describing the tax-ID system or type. */
  taxIdType?: string;

  /**

* Whether the party is tax-exempt.
*
* When true, `taxExemptRef` may be used to identify the applicable
* exemption basis or supporting reference.
  */
  taxExempt?: boolean;

  /** Optional reference supporting the party's tax exemption. */
  taxExemptRef?: string;

  /** Optional structured postal address. */
  address?: PartyAddress;

  /** Optional email address used for invoice-related communication. */
  email?: string;

  /** Optional telephone or mobile number. */
  phone?: string;

  /** Optional website associated with the party. */
  website?: string;

  /**

* Application-defined metadata associated with the party.
*
* The invoice domain stores this data but does not interpret its contents.
  */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Discount
// ---------------------------------------------------------------------------

/**

* Supported discount calculation modes.
*
* `percentage` interprets `value` as a decimal fraction:
*
* `0.10 = 10%`
*
* `fixed` interprets `value` as a monetary amount in the invoice currency.
  */
export type DiscountType = "percentage" | "fixed";

/**

* Discount definition applied to a line item.
  */
export interface Discount {
  /**

  * How the discount value should be interpreted.
    */
  type: DiscountType;

  /**

* Discount magnitude.
*
* For `percentage`, this is a decimal fraction between `0` and `1`.
* For `fixed`, this is an amount in major currency units.
  */
  value: number;

  /** Optional human-readable label for the discount. */
  label?: string;
}

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

/**

* Start and end dates describing the service, billing, or accounting period
* covered by a document.
*
* Both dates use `YYYY-MM-DD` format.
  */
export interface Period {
  /** Inclusive period start date. */
  start: ISODateString;

  /** Inclusive period end date. */
  end: ISODateString;
}

// ---------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------

/**

* Reference to another business or accounting document.
*
* Examples include purchase orders, delivery receipts, contracts, credit notes,
* or other related invoice documents.
  */
export interface DocumentReference {
  /** Human-readable reference/document type. */
  type: string;

  /** Identifier or number of the referenced document. */
  number: string;

  /** Optional date associated with the referenced document. */
  date?: ISODateString;

  /** Optional explanatory note about the relationship. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Accounting Context
// ---------------------------------------------------------------------------

/**

* Optional accounting configuration used when projecting an invoice into
* accounting structures.
*
* The account codes supplied here override package defaults for the
* corresponding accounting role.
  */
export interface AccountingContext {
  /**

  * Account-code overrides used by accounting projections.
    */
  accounts?: {
    /** Accounts Receivable account code. */
    receivable?: string;

    /** Accounts Payable account code. */
    payable?: string;

    /** Revenue account code. */
    revenue?: string;

    /** Expense account code. */
    expense?: string;

    /** Tax payable/account code. */
    tax?: string;

    /** Cash account code. */
    cash?: string;

    /** Discount account code. */
    discount?: string;
  };

  /**

* Organization context associated with the accounting operation.
  */
  organization?: Party;

  /**

* Optional fiscal period used for accounting classification.
  */
  fiscalPeriod?: Period;

  /**

* Optional invoice/accounting branch used to classify the operation.
  */
  branchType?: InvoiceType;
}

// ---------------------------------------------------------------------------
// Journal Entry
// ---------------------------------------------------------------------------

/**

* One debit or credit posting within a {@link JournalEntry}.
  */
export interface JournalLine {
  /** Ledger account code receiving the posting. */
  accountCode: string;

  /** Human-readable ledger account name. */
  accountName: string;

  /**

* Debit amount in major currency units.
*
* Only one of `debit` or `credit` is normally populated for a line.
  */
  debit?: number;

  /**

* Credit amount in major currency units.
*
* Only one of `debit` or `credit` is normally populated for a line.
  */
  credit?: number;

  /** Optional memo describing the posting. */
  memo?: string;

  /** Optional source line-item ID when the posting maps to a specific line. */
  lineItemId?: string;
}

/**

* Draft general-ledger journal entry projected from an invoice.
*
* The source document is explicitly tied to an invoice so the accounting
* projection can be traced back to its originating document.
  */
export interface JournalEntry {
  /** Unique journal-entry identifier. */
  id: string;

  /** Accounting date of the journal entry. */
  date: ISODateString;

  /** Human-readable journal-entry description. */
  description: string;

  /**

* Individual debit and credit postings.
*
* The projected entry is expected to balance.
  */
  lines: JournalLine[];

  /**

* Invoice document that produced the journal entry.
  */
  sourceDocument: {
    /** Source type. Currently always an invoice. */
    type: "invoice";

    /** Source invoice ID. */

    id: string;

    /** Optional source invoice number. */
    invoiceNumber?: string;
  };

  /**

* Journal-entry lifecycle state.
*
* Invoice projections are created as draft entries.
  */
  status: "draft";

  /** Optional accounting period associated with the entry. */
  period?: Period;

  /** Optional application-defined journal metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sub-Ledger Entry
// ---------------------------------------------------------------------------

/**

* Supported sub-ledger directions.
*
* `AR` represents Accounts Receivable and `AP` represents Accounts Payable.
  */
export type SubLedgerType = "AR" | "AP";

/**

* Open, partially settled, or fully settled sub-ledger state.
  */
export type SubLedgerEntryStatus = "open" | "partial" | "closed";

/**

* Invoice-derived sub-ledger balance record.
*
* This structure is intentionally lighter than a full journal entry and is
* designed for party-level balance tracking such as Accounts Receivable.
  */
export interface SubLedgerEntry {
  /** Unique sub-ledger record identifier. */
  id: string;

  /** Whether the entry belongs to AR or AP. */
  type: SubLedgerType;

  /** Stable identifier used to associate the entry with a party. */
  partyId: string;

  /** Human-readable party name. */
  partyName: string;

  /** Source invoice ID. */
  invoiceId: string;

  /** Optional customer-facing invoice number. */
  invoiceNumber?: string;

  /** Accounting/document date. */
  date: ISODateString;

  /** Optional contractual due date. */
  dueDate?: ISODateString;

  /**

* Outstanding balance represented by the entry.
*
* Expressed in major units of `currency`.
  */
  balance: number;

  /** Currency in which the balance is denominated. */
  currency: CurrencyCode;

  /** Current settlement state of the sub-ledger balance. */
  status: "open" | "partial" | "closed";
}

// ---------------------------------------------------------------------------
// Proof of Payment
// ---------------------------------------------------------------------------

/**

* Payment mechanism used to settle an invoice.
*
* The union includes common settlement channels while retaining a string
* fallback so integrations can represent additional provider-specific methods.
  */
export type PaymentMethod =
  | "bank_transfer"
  | "ewallet"
  | "cash"
  | "check"
  | "credit_card"
  | "crypto"
  | "wire"
  | string;

/**

* Evidence that a payment was made toward an invoice.
*
* Multiple payment records may be attached to the same invoice to support
* partial payments, staged settlements, or multiple transactions.
*
* Payment records are settlement data; they are not part of the invoice's
* original signable financial commitment.
  */
export interface ProofOfPayment {
  /**

  * Unique identifier for this payment record.
    */
  id: string;

  /**

* Payment mechanism used for settlement.
  */
  method: PaymentMethod;

  /**

* External transaction or settlement reference.
*
* Examples include a bank reference number, e-wallet reference,
* check number, blockchain transaction hash, or provider transaction ID.
*
* @example
* ```ts
  ```
* reference: "GCASH-2026-001928"
* ```
  ```

*/
  reference: string;

  /**

* Date and time at which the payment was settled.
  */
  settledAt: ISODateTimeString;

  /**

* Amount paid in major units of the invoice currency.
  */
  amount: number;

  /**

* Currency in which the payment was made.
*
* The current invoice settlement logic requires this to match the invoice
* currency.
  */
  currency: CurrencyCode;

  /**

* Optional URL pointing to supporting payment evidence.
*
* Examples include receipt images, bank confirmations, or payment provider
* documents.
  */
  proofUrl?: string;

  /**

* Optional provider- or application-specific payment metadata.
  */
  metadata?: Record<string, unknown>;
}

/**

* Derived settlement state based on recorded payment proofs.
*
* `pending`
* No positive payment has been recorded.
*
* `partially_paid`
* One or more positive payments have been recorded, but the total does not
* fully cover the invoice's current `netPayable`.
*
* `settled`
* Recorded payments fully cover the invoice's current `netPayable`.
  */
export type PaymentStatus = "pending" | "partially_paid" | "settled";

// ---------------------------------------------------------------------------
// Serialized shapes (JSON)
// ---------------------------------------------------------------------------

/**

* JSON-safe representation of a {@link GeneralInvoice}.
*
* Monetary values are serialized representations rather than live
* `MajikMoney` instances, allowing the object to cross storage and transport
* boundaries safely.
*
* This is a persistence/transport shape and should not be confused with the
* mutable input used to create a new invoice.
  */
export interface GeneralInvoiceJSON {
  /** Invoice schema version. */
  version: string;

  /** Stable invoice identifier. */
  id: string;

  /** Optional human-facing invoice number. */
  invoiceNumber?: string;

  /** Invoice document type. */
  type: InvoiceType;

  /** Persisted invoice lifecycle status. */
  status: InvoiceStatus;

  /** Issuing party. */
  issuer: Party;

  /** Receiving/billed party. */
  recipient: Party;

  /** Invoice currency. */
  currency: CurrencyCode;

  /** Invoice issue date. */
  issueDate: ISODateString;

  /** Optional payment due date. */
  dueDate?: ISODateString;

  /** Optional billing/service period. */
  period?: Period;

  /** Optional payment terms. */
  paymentTerms?: PaymentTerms;

  /** Serialized line items. */
  lineItems: LineItemJSON[];

  /** Serialized aggregate invoice totals. */
  totals: InvoiceTotalsJSON;

  /** Recorded proof-of-payment records. */
  proofOfPayments: ProofOfPayment[];

  /** Invoice-level default tax configuration. */
  defaultTaxes?: TaxDetail[];

  /** Related document references. */
  references?: DocumentReference[];

  /** Optional free-form notes. */
  notes?: string;

  /** Optional organizational tags. */
  tags?: string[];

  /** Optional application metadata. */
  metadata?: Record<string, unknown>;

  /** Original invoice creation timestamp. */
  createdAt: ISODateTimeString;

  /** Most recent invoice update timestamp. */
  updatedAt: ISODateTimeString;
}

// ---------------------------------------------------------------------------
// Validation Result
// ---------------------------------------------------------------------------

/**

* Result returned by non-throwing validation routines.
*
* `valid` indicates whether any validation errors were found.
* `errors` contains one entry for each discovered field-level problem.
  */
export interface ValidationResult {
  /** `true` when the input passed all performed validation checks. */
  valid: boolean;

  /**

* Field-level validation failures.
*
* An empty array indicates successful validation.
  */
  errors: Array<{
    /** Field or property path associated with the error. */
    field: string;

    /** Human-readable description of the validation failure. */

    message: string;
  }>;
}

// ---------------------------------------------------------------------------
// Derived / analysis output types
// ---------------------------------------------------------------------------

/**

* Invoice-wide discount analysis.
*
* Provides both aggregate discount metrics and the individual line items
* contributing to the discount total.
  */
export interface DiscountSummary {
  /** Total discount across all line items in major currency units. */
  totalDiscount: number;

  /** Human-readable formatted representation of the total discount. */
  formattedDiscount: string;

  /** Effective aggregate discount rate as a decimal fraction. */
  effectiveRate: number;

  /**

* Line-by-line discount details.
  */
  lines: Array<{
    /** Source line-item identifier. */
    lineItemId: string;

    /** Human-readable line-item description. */

    description: string;

    /** Calculated discount amount in major currency units. */
    discountAmount: number;

    /** Discount calculation mode. */
    discountType: "percentage" | "fixed";

    /** Original configured discount value. */
    discountValue: number;
  }>;
}

/**

* Invoice monetary totals projected into a different currency.
*
* The FX calculation is an analysis/projection only; it does not modify the
* invoice's stored currency or monetary values.
  */
export interface FxTotals {
  /** Currency into which the invoice was projected. */
  targetCurrency: CurrencyCode;

  /**

* FX conversion rate used for the projection.
  */
  rate: number;

  /** Converted gross subtotal in major currency units. */
  subtotal: number;

  /** Converted aggregate discount in major currency units. */
  discountTotal: number;

  /** Converted additive tax total in major currency units. */
  taxTotal: number;

  /** Converted invoice grand total in major currency units. */
  grandTotal: number;

  /**

* Human-readable formatted versions of the converted totals.
  */
  formatted: {
    /** Formatted converted subtotal. */
    subtotal: string;

    /** Formatted converted discount total. */

    discountTotal: string;

    /** Formatted converted tax total. */
    taxTotal: string;

    /** Formatted converted grand total. */
    grandTotal: string;
  };
}

/**

* Group of line items associated with the same accounting code.
*
* Used by invoice analysis and accounting projection workflows.
  */
export interface LineItemsByAccount {
  /** Accounting account code shared by the grouped line items. */
  accountCode: string;

  /** Line items mapped to the account code. */
  lineItems: LineItem[];

  /**

* Gross subtotal of the grouped lines before discounts and taxes.
  */
  subtotal: number;
}

// ---------------------------------------------------------------------------
// Internal rebuild helper type
// ---------------------------------------------------------------------------

/**

* Internal normalized invoice state used when rebuilding a
* {@link GeneralInvoice}.
*
* This type contains the required fields that are guaranteed to exist once
* an invoice has passed construction/defaulting.
*
* It intentionally omits `lineItems` because line items are supplied
* separately to the internal rebuild mechanism.
*
* @internal
  */
export type InvoiceInternalState = Omit<GeneralInvoiceInput, "lineItems"> & {
  /** Guaranteed invoice identifier. */
  id: string;

  /** Normalized invoice type. */
  type: InvoiceType;

  /** Normalized invoice lifecycle status. */
  status: InvoiceStatus;

  /** Guaranteed issue date. */
  issueDate: ISODateString;

  /** Invoice creation timestamp. */
  createdAt: ISODateTimeString;

  /** Most recent invoice rebuild/update timestamp. */
  updatedAt: ISODateTimeString;
};

// ---------------------------------------------------------------------------
// Tax Behaviour
// ---------------------------------------------------------------------------

/**

* Defines how a tax participates in invoice calculations.
*
* ### `additive`
*
* A normal tax that is either:
*
* * added on top of the taxable amount when exclusive, or
* * extracted from the taxable amount when inclusive.
*
* Typical examples include VAT, GST, and excise taxes.
*
* ### `withholding`
*
* A tax withheld by the buyer at settlement.
*
* Withholding:
*
* * does not increase `grandTotal`
* * reduces `netPayable`
* * is calculated from the applicable withholding base
* * does not use tax inclusivity semantics
*
* Typical examples include EWT/CWT or other withholding taxes.
*
* ### `informational`
*
* A tax-related disclosure that does not affect monetary totals.
*
* This can be used for tax-exempt indicators, zero-rate disclosures, or other
* transparency-only tax information.
  */
export type TaxBehaviour = "additive" | "withholding" | "informational";

/**

* Definition of a single tax applied to a line item or invoice-level defaults.
*
* A tax is identified primarily by `taxType`, while `jurisdiction` can
* distinguish otherwise similar taxes that belong to different jurisdictions.
  */
export interface TaxDetail {
  /**

  * Tax type identifier.
  *
  * Common examples include `VAT`, `GST`, `EWT`, and `WHT`.
  *
  * The invoice domain normalizes tax types to uppercase when they are
  * validated by {@link TaxManager}.
  *
  * @example
  * ```ts
    ```
  * taxType: "VAT"
  * ```
    ```

  */
  taxType: string;

  /**

* Tax rate expressed as a decimal fraction.
*
* Examples:
*
* * `0.12` = 12%
* * `0.05` = 5%
* * `0` = 0%
*
* Valid rates are between `0` and `1`.
  */
  rate: number;

  /**

* Determines how the tax participates in invoice calculations.
*
* Defaults to `additive` when omitted.
  */
  behaviour?: TaxBehaviour;

  /**

* Optional tax jurisdiction.
*
* Useful when the same tax type can exist under different taxing
* authorities or jurisdictions.
  */
  jurisdiction?: string;

  /** Optional human-readable tax label. */
  label?: string;

  /**

* Whether an additive tax is embedded in the price.
*
* * `true` — tax is inclusive and is extracted from the applicable amount
* * `false`/omitted — tax is exclusive and is added on top
*
* This property is meaningful only for `additive` taxes.
* Withholding taxes do not use inclusivity semantics.
  */
  inclusive?: boolean;
}

// ---------------------------------------------------------------------------
// LineItemInput — tax → taxes (backward-compatible)
// ---------------------------------------------------------------------------

/**

* Raw input used to create or update a {@link LineItem}.
*
* Unlike the calculated `LineItem` class, this structure contains only source
* values. Derived monetary values such as `lineTotal`, tax amounts, and
* `netPayable` are calculated by `LineItem`.
  */
export interface LineItemInput {
  /**

  * Optional stock/product identifier associated with the line.
    */
  skuId?: string;

  /**

* Optional stable line-item identifier.
*
* A UUID is generated when omitted.
  */
  id?: string;

  /**

* Human-readable product or service description.
  */
  description: string;

  /**

* Number of units being billed.
*
* Must be finite and greater than zero.
  */
  quantity: number;

  /**

* Unit price expressed in major currency units.
*
* For example, `1500` represents 1,500 units of the invoice currency.
  */
  unitPrice: number;

  /** Optional unit of measure such as `hour`, `kg`, `piece`, or `month`. */
  unit?: string;

  /**

* Taxes explicitly assigned to this line item.
*
* When omitted, `GeneralInvoice` may resolve the line against the invoice's
* `defaultTaxes`.
*
* Multiple tax behaviours can be represented in the same collection.
  */
  taxes?: TaxDetail[];

  /** Optional percentage or fixed discount. */
  discount?: Discount;

  /**

* Optional ledger/accounting code used for revenue or account grouping.
  */
  accountCode?: string;

  /** Optional cost-center identifier used for accounting allocation. */
  costCenter?: string;

  /** Optional organizational tags attached to the line item. */
  tags?: string[];

  /** Optional application-defined metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LineItemJSON
// ---------------------------------------------------------------------------

/**

* JSON-safe representation of a calculated {@link LineItem}.
*
* Monetary values are persisted using serialized money objects rather than
* live `MajikMoney` instances.
  */
export interface LineItemJSON {
  /** Stable line-item identifier. */
  id: string;

  /** Optional SKU/product identifier. */
  skuId?: string;

  /** Line-item description. */
  description: string;

  /** Quantity billed. */
  quantity: number;

  /** Serialized unit price. */
  unitPrice: Record<string, unknown>;

  /** Optional unit of measure. */
  unit?: string;

  /** Fully resolved taxes applied to this line. */
  taxes: TaxDetail[];

  /** Optional source discount definition. */
  discount?: Discount;

  /** Serialized gross line total before discount and tax. */
  lineTotal: Record<string, unknown>;

  /**

* Serialized aggregate additive tax amount.
*
* Retained as the primary calculated additive tax field.
  */
  additiveTaxAmount: Record<string, unknown>;

  /**

* Serialized aggregate withholding tax amount.
  */
  withholdingTaxAmount: Record<string, unknown>;

  /**

* Backward-compatible alias for `additiveTaxAmount`.
*
* This field is retained for consumers using the historical `taxAmount`
* property.
  */
  taxAmount: Record<string, unknown>;

  /** Serialized calculated discount amount. */
  discountAmount: Record<string, unknown>;

  /**

* Serialized invoice-total contribution of the line.
*
* Corresponds to the line item's `netTotal`.
  */
  netTotal: Record<string, unknown>;

  /**

* Serialized amount actually payable after withholding.
*
* Corresponds to the line item's `netPayable`.
  */
  netPayable: Record<string, unknown>;

  /** Optional accounting code. */
  accountCode?: string;

  /** Optional cost center. */
  costCenter?: string;

  /** Optional organizational tags. */
  tags?: string[];

  /** Optional application metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// InvoiceTotalsJSON
// ---------------------------------------------------------------------------

/**

* JSON-safe representation of {@link InvoiceTotals}.
*
* Each monetary property contains a serialized money representation suitable
* for storage or transport.
  */
export interface InvoiceTotalsJSON {
  /** Serialized gross invoice subtotal. */
  subtotal: Record<string, unknown>;

  /** Serialized aggregate invoice discount. */
  discountTotal: Record<string, unknown>;

  /** Serialized aggregate additive tax total. */
  taxTotal: Record<string, unknown>;

  /** Serialized aggregate withholding tax total. */
  withholdingTotal: Record<string, unknown>;

  /** Serialized invoice-declared grand total before withholding. */
  grandTotal: Record<string, unknown>;

  /** Serialized amount actually payable after withholding. */
  netPayable: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GeneralInvoiceInput
// ---------------------------------------------------------------------------

/**

* Raw input used to construct a {@link GeneralInvoice}.
*
* This is the creation/input form of an invoice and therefore allows several
* values to be omitted so the invoice factory can supply defaults such as ID,
* type, status, and issue date.
  */
export interface GeneralInvoiceInput {
  /** Optional invoice ID. Generated automatically when omitted. */
  id?: string;

  /** Optional customer-facing invoice number. */
  invoiceNumber?: string;

  /**

* Document type.
*
* Defaults to `commercial` when omitted during invoice creation.
  */
  type?: InvoiceType;

  /**

* Initial lifecycle status.
*
* Defaults to `draft` when omitted during invoice creation.
  */
  status?: InvoiceStatus;

  /** Legal/business party issuing the invoice. */
  issuer: Party;

  /** Legal/business party receiving the invoice. */
  recipient: Party;

  /** Invoice currency. */
  currency: CurrencyCode;

  /**

* Optional issue date.
*
* Defaults to the current date when omitted during creation.
  */
  issueDate?: ISODateString;

  /** Optional due date. */
  dueDate?: ISODateString;

  /** Optional service, billing, or accounting period. */
  period?: Period;

  /** Optional payment terms. */
  paymentTerms?: PaymentTerms;

  /**

* Invoice line items.
*
* At least one line item is required by invoice validation.
  */
  lineItems: LineItemInput[];

  /**

* Optional initial payment records.
  */
  proofOfPayments?: ProofOfPayment[];

  /**

* Invoice-level default taxes.
*
* These are inherited by line items that do not specify their own taxes.
  */
  defaultTaxes?: TaxDetail[];

  /** Optional related document references. */
  references?: DocumentReference[];

  /** Optional free-form invoice notes. */
  notes?: string;

  /** Optional organizational tags. */
  tags?: string[];

  /** Optional application-defined metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TaxBreakdownEntry
// ---------------------------------------------------------------------------

/**

* Aggregated tax analysis entry produced by `GeneralInvoice.taxBreakdown()`.
*
* The grouping key combines tax identity, jurisdiction, behaviour, and
* inclusivity so materially different tax treatments remain distinct.
  */
export interface TaxBreakdownEntry {
  /**

  * Tax type represented by the entry.
    */
  taxType: string;

  /** Optional tax jurisdiction. */
  jurisdiction?: string;

  /** Optional human-readable tax label. */
  label?: string;

  /** Configured tax rate as a decimal fraction. */
  rate: number;

  /** How the tax participates in invoice calculations. */
  behaviour: TaxBehaviour;

  /**

* Aggregate taxable base across all matching line items.
*
* The base is adjusted according to the tax's treatment of inclusive taxes
* and withholding.
  */
  taxableBase: number;

  /**

* Aggregate calculated tax amount in major currency units.
  */
  taxAmount: number;

  /**

* Whether the grouped tax is inclusive.
*
* Withholding entries are always represented as non-inclusive.
  */
  inclusive: boolean;

  /**

* Number of line items contributing to this tax group.
  */
  lineCount: number;
}
