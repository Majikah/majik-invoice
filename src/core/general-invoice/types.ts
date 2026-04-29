/**
 * @file types.ts
 * @description Shared primitive types for the @majikah/majik-invoice domain.
 * No crypto dependencies. No Majik-specific logic.
 * These are the vocabulary that GeneralInvoice and MajikInvoice are built from.
 */

import { LineItem } from "./line-item";

// ---------------------------------------------------------------------------
// ISO Primitives
// ---------------------------------------------------------------------------

/**
 * ISO 8601 date string — YYYY-MM-DD
 * @example "2025-04-22"
 */
export type ISODateString = string;

/**
 * ISO 8601 datetime string — YYYY-MM-DDTHH:mm:ssZ
 * @example "2025-04-22T08:00:00Z"
 */
export type ISODateTimeString = string;

/**
 * ISO 4217 currency code
 * @example "PHP" | "USD" | "EUR"
 */
export type CurrencyCode = string;

/**
 * ISO 3166-1 alpha-2 country code
 * @example "PH" | "US" | "GB"
 */
export type CountryCode = string;

// ---------------------------------------------------------------------------
// Invoice Type — accounting branch discriminant
// ---------------------------------------------------------------------------

/**
 * Discriminant type covering all major accounting branches.
 *
 * | Value           | Accounting Branch                   |
 * |-----------------|-------------------------------------|
 * | commercial      | Financial Accounting — standard B2B |
 * | proforma        | Pre-invoice, not a legal document   |
 * | credit          | Credit note / reversal              |
 * | debit           | Debit note                          |
 * | tax             | Tax Accounting — VAT / GST invoice  |
 * | government      | Government / Public procurement     |
 * | intercompany    | Managerial — internal transfer      |
 * | project         | Project Accounting — milestone bill |
 * | recurring       | Subscription / periodic billing     |
 * | forensic        | Forensic / Audit — flagged          |
 * | environmental   | Social & Environmental Accounting   |
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
 * Structured postal address — globally compatible, BIR-aware.
 */
export interface PartyAddress {
  line1: string;
  line2?: string;
  city: string;
  stateOrProvince?: string;
  postalCode?: string;
  country: CountryCode;
  branchCode?: string;
  district?: string;
}

// ---------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------

export interface Party {
  legalName: string;
  tradeName?: string;
  natureOfBusiness?: string;
  tin?: string;
  taxIdType?: string;
  taxExempt?: boolean;
  taxExemptRef?: string;
  address?: PartyAddress;
  email?: string;
  phone?: string;
  website?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Discount
// ---------------------------------------------------------------------------

export type DiscountType = "percentage" | "fixed";

export interface Discount {
  type: DiscountType;
  value: number;
  label?: string;
}

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

export interface Period {
  start: ISODateString;
  end: ISODateString;
}

// ---------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------

export interface DocumentReference {
  type: string;
  number: string;
  date?: ISODateString;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Accounting Context
// ---------------------------------------------------------------------------

export interface AccountingContext {
  accounts?: {
    receivable?: string;
    payable?: string;
    revenue?: string;
    expense?: string;
    tax?: string;
    cash?: string;
    discount?: string;
  };
  organization?: Party;
  fiscalPeriod?: Period;
  branchType?: InvoiceType;
}

// ---------------------------------------------------------------------------
// Journal Entry
// ---------------------------------------------------------------------------

export interface JournalLine {
  accountCode: string;
  accountName: string;
  debit?: number;
  credit?: number;
  memo?: string;
  lineItemId?: string;
}

export interface JournalEntry {
  id: string;
  date: ISODateString;
  description: string;
  lines: JournalLine[];
  sourceDocument: {
    type: "invoice";
    id: string;
    invoiceNumber?: string;
  };
  status: "draft";
  period?: Period;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sub-Ledger Entry
// ---------------------------------------------------------------------------

export type SubLedgerType = "AR" | "AP";

export interface SubLedgerEntry {
  id: string;
  type: SubLedgerType;
  partyId: string;
  partyName: string;
  invoiceId: string;
  invoiceNumber?: string;
  date: ISODateString;
  dueDate?: ISODateString;
  balance: number;
  currency: CurrencyCode;
  status: "open" | "partial" | "closed";
}

// ---------------------------------------------------------------------------
// Proof of Payment
// ---------------------------------------------------------------------------

/**
 * Method of payment settlement.
 */
export type PaymentMethod =
  | "bank_transfer"
  | "gcash"
  | "maya"
  | "cash"
  | "check"
  | "credit_card"
  | "crypto"
  | "wire"
  | string;

/**
 * A single proof-of-payment record.
 * Multiple entries are supported to accommodate partial payments.
 *
 * `isSettled` on MajikInvoice returns true when the sum of all
 * `amount` values across all entries ≥ invoice grand total.
 */
export interface ProofOfPayment {
  /** Unique identifier for this payment record */
  id: string;
  /** How the payment was made */
  method: PaymentMethod;
  /**
   * External transaction reference number.
   * @example Bank ref, GCash ref, check number, txHash
   */
  reference: string;
  /** When the payment was settled — ISO 8601 datetime */
  settledAt: ISODateTimeString;
  /** Amount paid in major units of the invoice currency */
  amount: number;
  /** Currency of the payment — must match invoice currency */
  currency: CurrencyCode;
  /** URL to proof document — receipt image, bank confirmation, etc. */
  proofUrl?: string;
  /** Any additional payment metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Derived payment posture based on attached proofs of payment.
 *
 * "pending"        — no proof of payment attached
 * "partially_paid" — one or more payments but total < grand total
 * "settled"        — total payments ≥ grand total
 */
export type PaymentStatus = "pending" | "partially_paid" | "settled";

// ---------------------------------------------------------------------------
// Serialized shapes (JSON)
// ---------------------------------------------------------------------------

export interface GeneralInvoiceJSON {
  version: string;
  id: string;
  invoiceNumber?: string;
  type: InvoiceType;
  status: InvoiceStatus;
  issuer: Party;
  recipient: Party;
  currency: CurrencyCode;
  issueDate: ISODateString;
  dueDate?: ISODateString;
  period?: Period;
  paymentTerms?: PaymentTerms;
  lineItems: LineItemJSON[];
  totals: InvoiceTotalsJSON;
  defaultTaxes?: TaxDetail[];
  references?: DocumentReference[];
  notes?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

// ---------------------------------------------------------------------------
// Validation Result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Derived / analysis output types
// ---------------------------------------------------------------------------

export interface DiscountSummary {
  totalDiscount: number;
  formattedDiscount: string;
  effectiveRate: number;
  lines: Array<{
    lineItemId: string;
    description: string;
    discountAmount: number;
    discountType: "percentage" | "fixed";
    discountValue: number;
  }>;
}

export interface FxTotals {
  targetCurrency: CurrencyCode;
  rate: number;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  formatted: {
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    grandTotal: string;
  };
}

export interface LineItemsByAccount {
  accountCode: string;
  lineItems: LineItem[];
  subtotal: number;
}

// ---------------------------------------------------------------------------
// Internal rebuild helper type
// ---------------------------------------------------------------------------

export type InvoiceInternalState = Omit<GeneralInvoiceInput, "lineItems"> & {
  id: string;
  type: InvoiceType;
  status: InvoiceStatus;
  issueDate: ISODateString;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
};

// ---------------------------------------------------------------------------
// Tax Behaviour — NEW
// ---------------------------------------------------------------------------

/**
 * How a tax affects totals and cash settlement.
 *
 * "additive"
 *   Tax is added on top of (or embedded in) the price.
 *   Increases grandTotal (exclusive) or is extracted from it (inclusive).
 *   Example: VAT, GST, excise duty
 *
 * "withholding"
 *   Tax is withheld by the buyer at payment time.
 *   grandTotal is UNCHANGED — the withheld amount reduces the cash remitted.
 *   Base is always postDiscount (pre-VAT income payment) per BIR RR 2-98.
 *   inclusive flag has NO effect on withholding taxes.
 *   Example: EWT (CWT), WHT
 *
 * "informational"
 *   Disclosed on the invoice for transparency only.
 *   No effect on any computed total.
 *   Example: zero-rated VAT notation, tax-exempt marker
 */
export type TaxBehaviour = "additive" | "withholding" | "informational";

export interface TaxDetail {
  taxType: string;
  rate: number;
  /** Defaults to "additive" when omitted */
  behaviour?: TaxBehaviour;
  jurisdiction?: string;
  label?: string;
  /** Only meaningful for "additive" taxes. Ignored on "withholding". */
  inclusive?: boolean;
}

// ---------------------------------------------------------------------------
// LineItemInput — tax → taxes (backward-compatible)
// ---------------------------------------------------------------------------

export interface LineItemInput {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  unit?: string;
  /**
   * Multiple taxes layered on this line item.
   * Replaces the old singular `tax` field.
   * Use the `tax` alias for single-tax convenience — it is coerced internally.
   */
  taxes?: TaxDetail[];

  discount?: Discount;
  accountCode?: string;
  costCenter?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LineItemJSON — updated
// ---------------------------------------------------------------------------

export interface LineItemJSON {
  id: string;
  description: string;
  quantity: number;
  unitPrice: Record<string, unknown>;
  unit?: string;
  taxes: TaxDetail[]; // was: tax?: TaxDetail
  discount?: Discount;
  lineTotal: Record<string, unknown>;
  additiveTaxAmount: Record<string, unknown>; // was: taxAmount
  withholdingTaxAmount: Record<string, unknown>; // NEW
  taxAmount: Record<string, unknown>; // kept for back-compat — equals additiveTaxAmount
  discountAmount: Record<string, unknown>;
  netTotal: Record<string, unknown>;
  netPayable: Record<string, unknown>; // NEW: netTotal − withholdingTaxAmount
  accountCode?: string;
  costCenter?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// InvoiceTotalsJSON — updated
// ---------------------------------------------------------------------------

export interface InvoiceTotalsJSON {
  subtotal: Record<string, unknown>;
  discountTotal: Record<string, unknown>;
  taxTotal: Record<string, unknown>;
  withholdingTotal: Record<string, unknown>; // NEW
  grandTotal: Record<string, unknown>;
  netPayable: Record<string, unknown>; // NEW
}

// ---------------------------------------------------------------------------
// GeneralInvoiceInput — defaultTax → defaultTaxes
// ---------------------------------------------------------------------------

export interface GeneralInvoiceInput {
  id?: string;
  invoiceNumber?: string;
  type?: InvoiceType;
  status?: InvoiceStatus;
  issuer: Party;
  recipient: Party;
  currency: CurrencyCode;
  issueDate?: ISODateString;
  dueDate?: ISODateString;
  period?: Period;
  paymentTerms?: PaymentTerms;
  lineItems: LineItemInput[];
  defaultTaxes?: TaxDetail[];
  references?: DocumentReference[];
  notes?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TaxBreakdownEntry — updated
// ---------------------------------------------------------------------------

export interface TaxBreakdownEntry {
  taxType: string;
  jurisdiction?: string;
  label?: string;
  rate: number;
  behaviour: TaxBehaviour;
  taxableBase: number;
  taxAmount: number;
  inclusive: boolean; // always false for withholding
  lineCount: number;
}
