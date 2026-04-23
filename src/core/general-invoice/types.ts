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
 * Use this to branch behaviour without a parallel class hierarchy.
 *
 * | Value           | Accounting Branch                  |
 * |-----------------|------------------------------------|
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
  | "immediate" // Cash on delivery / upon receipt
  | "net7"
  | "net15"
  | "net30"
  | "net60"
  | "net90"
  | "eom" // End of month
  | "cod" // Cash on delivery
  | "prepaid"
  | "custom";

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/**
 * Structured postal address — globally compatible, BIR-aware.
 *
 * BIR usage:
 *  - `branchCode`: "000" = head office, "001"+ = branch
 *  - `district`: BIR Revenue District Office (RDO)
 *
 * Global usage:
 *  - `branchCode` and `district` are simply omitted
 */
export interface PartyAddress {
  /** Street address, building name, house number */
  line1: string;
  /** Suite, floor, unit, room — optional */
  line2?: string;
  /** City or municipality */
  city: string;
  /** State, province, or region */
  stateOrProvince?: string;
  /** Postal / ZIP code */
  postalCode?: string;
  /**
   * ISO 3166-1 alpha-2 country code — required
   * @example "PH" | "US" | "GB"
   */
  country: CountryCode;
  /**
   * BIR branch code.
   * "000" = head office, "001"+ = branch offices.
   * Ignored for non-PH contexts.
   */
  branchCode?: string;
  /**
   * BIR Revenue District Office (RDO) district.
   * @example "RDO No. 44 - Taguig City"
   */
  district?: string;
}

// ---------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------

/**
 * Represents any named entity on an invoice — issuer or recipient.
 * BIR-compliant and globally compatible.
 */
export interface Party {
  // ── Identity ─────────────────────────────────────────────────────────────

  /**
   * Full legal registered name.
   * BIR: must match COR (Certificate of Registration).
   * @example "Juan dela Cruz Enterprises, Inc."
   */
  legalName: string;

  /**
   * Trade name / DBA / brand name / style name.
   * @example "JDC Supplies"
   */
  tradeName?: string;

  /**
   * Nature or line of business.
   * BIR: matches registered business activity.
   * @example "Retail Sale of Office Supplies"
   */
  natureOfBusiness?: string;

  // ── Tax ──────────────────────────────────────────────────────────────────

  /**
   * Tax identification number.
   * PH: TIN (9–12 digit), US: EIN/SSN, EU: VAT number, AU: ABN, etc.
   * @example "123-456-789-000"
   */
  tin?: string;

  /**
   * Type of tax ID — for international context.
   * @example "TIN" | "EIN" | "VAT" | "GST" | "ABN"
   */
  taxIdType?: string;

  /** Whether this party is tax-exempt */
  taxExempt?: boolean;

  /**
   * Tax exemption certificate or reference number.
   * @example "BIR Cert. No. 12345"
   */
  taxExemptRef?: string;

  // ── Address ───────────────────────────────────────────────────────────────

  address?: PartyAddress;

  // ── Contact ───────────────────────────────────────────────────────────────

  /**
   * Primary email address.
   * Appears on official receipts and commercial invoices.
   */
  email?: string;

  /**
   * Primary phone number — include country code.
   * @example "+63 2 1234 5678"
   */
  phone?: string;

  /** Website URL */
  website?: string;

  // ── Flexibility ───────────────────────────────────────────────────────────

  /** Any additional party-specific data */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tax Detail
// ---------------------------------------------------------------------------

/**
 * Tax applied to a line item or to the invoice as a whole.
 * Per-line is preferred; invoice-level acts as a fallback default.
 */
export interface TaxDetail {
  /**
   * Tax type identifier.
   * @example "VAT" | "GST" | "WHT" | "SALES_TAX" | "EXCISE"
   */
  taxType: string;

  /**
   * Rate as a decimal — NOT a percentage.
   * @example 0.12 for 12% VAT
   */
  rate: number;

  /**
   * Tax jurisdiction — country, state, or body.
   * @example "PH" | "CA-ON" | "EU-DE"
   */
  jurisdiction?: string;

  /**
   * Human-readable label for this tax.
   * @example "12% VAT" | "Withholding Tax (2%)"
   */
  label?: string;

  /**
   * Whether this tax is inclusive in the line item price.
   * If true, tax is already embedded in the unit price.
   */
  inclusive?: boolean;
}

// ---------------------------------------------------------------------------
// Discount
// ---------------------------------------------------------------------------

export type DiscountType = "percentage" | "fixed";

export interface Discount {
  type: DiscountType;
  /**
   * For "percentage": value as decimal (e.g. 0.10 = 10%).
   * For "fixed": value in major units of the invoice currency.
   */
  value: number;
  label?: string;
}

// ---------------------------------------------------------------------------
// Line Item
// ---------------------------------------------------------------------------

/**
 * A single billable line on an invoice.
 * Tax is per-line; if absent, falls back to invoice-level defaultTax.
 */
export interface LineItemInput {
  /** Line item identifier — auto-generated if omitted */
  id?: string;
  /** Description of the product or service */
  description: string;
  /** Quantity */
  quantity: number;
  /** Unit price in major units of the invoice currency */
  unitPrice: number;
  /** Unit of measure */
  unit?: string;
  /**
   * Tax applied to this line.
   * If omitted, inherits from invoice-level defaultTax.
   */
  tax?: TaxDetail;
  /** Discount applied to this line */
  discount?: Discount;
  /**
   * Account code this line maps to in the Chart of Accounts.
   * Used by toJournalEntry() when no AccountingContext is provided.
   * @example "4000" (Revenue)
   */
  accountCode?: string;
  /** Cost center or project code — for managerial / project accounting */
  costCenter?: string;
  /** Arbitrary tags — e.g. project phase, department */
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

/**
 * A billing or service period — start and end dates.
 * Used for project, recurring, and managerial accounting invoices.
 */
export interface Period {
  start: ISODateString;
  end: ISODateString;
}

// ---------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------

/**
 * Reference to an external document — PO, contract, audit trail, etc.
 */
export interface DocumentReference {
  /**
   * Reference type.
   * @example "PO" | "CONTRACT" | "DELIVERY_ORDER" | "WORK_ORDER"
   */
  type: string;
  /** Reference number */
  number: string;
  /** Date of the referenced document */
  date?: ISODateString;
  /** Free-form notes about this reference */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Accounting Context
// ---------------------------------------------------------------------------

/**
 * Chart of Accounts mapping and fiscal context passed into projection methods
 * such as toJournalEntry() and toSubLedgerEntry().
 *
 * Pass different contexts to support different accounting branches
 * without changing the invoice structure.
 */
export interface AccountingContext {
  accounts?: {
    /** Accounts Receivable — default "1200" */
    receivable?: string;
    /** Accounts Payable — default "2000" */
    payable?: string;
    /** Revenue / Sales — default "4000" */
    revenue?: string;
    /** Expense — default "5000" */
    expense?: string;
    /** Tax Payable — default "2100" */
    tax?: string;
    /** Cash — default "1000" */
    cash?: string;
    /** Discount / contra-revenue — default "4900" */
    discount?: string;
  };
  organization?: Party;
  fiscalPeriod?: Period;
  /**
   * Accounting branch hint — adjusts projection behaviour.
   */
  branchType?: InvoiceType;
}

// ---------------------------------------------------------------------------
// Journal Entry (output of toJournalEntry)
// ---------------------------------------------------------------------------

export interface JournalLine {
  accountCode: string;
  accountName: string;
  debit?: number; // in major units
  credit?: number; // in major units
  memo?: string;
  /** Source line item id — for traceability */
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
  /**
   * Always "draft" — posting to the ledger is a deliberate
   * accounting action outside the invoice domain.
   */
  status: "draft";
  period?: Period;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sub-Ledger Entry (output of toSubLedgerEntry)
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
  /** Outstanding balance in major units */
  balance: number;
  currency: CurrencyCode;
  status: "open" | "partial" | "closed";
}

// ---------------------------------------------------------------------------
// Serialized shapes (JSON)
// ---------------------------------------------------------------------------

/** Shape of a serialized LineItem — MajikMoney fields replaced with MajikMoneyJSON */
export interface LineItemJSON {
  id: string;
  description: string;
  quantity: number;
  unitPrice: Record<string, unknown>; // MajikMoneyJSON
  unit?: string;
  tax?: TaxDetail;
  discount?: Discount;
  lineTotal: Record<string, unknown>; // MajikMoneyJSON
  taxAmount: Record<string, unknown>; // MajikMoneyJSON
  discountAmount: Record<string, unknown>; // MajikMoneyJSON
  netTotal: Record<string, unknown>; // MajikMoneyJSON
  accountCode?: string;
  costCenter?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Shape of serialized InvoiceTotals */
export interface InvoiceTotalsJSON {
  subtotal: Record<string, unknown>;
  discountTotal: Record<string, unknown>;
  taxTotal: Record<string, unknown>;
  grandTotal: Record<string, unknown>;
}

/** Full serialized GeneralInvoice */
export interface GeneralInvoiceJSON {
  __type: "GeneralInvoice";
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
  defaultTax?: TaxDetail;
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

export interface TaxBreakdownEntry {
  taxType: string;
  jurisdiction?: string;
  label?: string;
  rate: number;
  /** Sum of taxable base (post-discount line totals) for this tax type */
  taxableBase: number;
  /** Computed tax amount for this group */
  taxAmount: number;
  /** Whether this tax is inclusive */
  inclusive: boolean;
  /** Number of line items carrying this tax type */
  lineCount: number;
}

export interface DiscountSummary {
  /** Total discount amount in major units */
  totalDiscount: number;
  /** Formatted total discount string */
  formattedDiscount: string;
  /** Effective discount rate against gross subtotal (0–1) */
  effectiveRate: number;
  /** Per-line breakdown */
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
// Create Input
// ---------------------------------------------------------------------------

export interface GeneralInvoiceInput {
  /** Override auto-generated UUID */
  id?: string;
  /** Human-readable invoice number — e.g. "INV-2025-001" */
  invoiceNumber?: string;
  /** Accounting branch / document type — defaults to "commercial" */
  type?: InvoiceType;
  /** Lifecycle status — defaults to "draft" */
  status?: InvoiceStatus;
  issuer: Party;
  recipient: Party;
  /** ISO 4217 currency code */
  currency: CurrencyCode;
  /** ISO 8601 date — defaults to today */
  issueDate?: ISODateString;
  dueDate?: ISODateString;
  /** Billing / service period — for project and recurring invoices */
  period?: Period;
  paymentTerms?: PaymentTerms;
  lineItems: LineItemInput[];
  /**
   * Invoice-level default tax — applied to any line item without its own tax.
   */
  defaultTax?: TaxDetail;
  references?: DocumentReference[];
  notes?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
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
