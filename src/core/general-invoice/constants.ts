// ---------------------------------------------------------------------------
// Schema version — bump when serialized shape changes

import { InvoiceStatus } from "./types";

// ---------------------------------------------------------------------------
export const SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Default Chart of Accounts codes (GAAP-aligned)
// ---------------------------------------------------------------------------
export const DEFAULT_ACCOUNTS = {
  receivable: "1200",
  payable: "2000",
  revenue: "4000",
  expense: "5000",
  tax: "2100",
  cash: "1000",
  discount: "4900",
} as const;

// ---------------------------------------------------------------------------
// Valid lifecycle transitions
// ---------------------------------------------------------------------------
/**
 * Defines which status transitions are permitted.
 * Keys are the FROM status; values are the allowed TO statuses.
 * "void" is terminal — no transitions out.
 */
export const ALLOWED_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ["draft", "issued", "void"],
  issued: ["sent", "viewed", "partial", "paid", "disputed", "void"],
  sent: ["viewed", "partial", "paid", "disputed", "void"],
  viewed: ["partial", "paid", "disputed", "void"],
  partial: ["paid", "disputed", "void"],
  paid: ["void"],
  overdue: ["paid", "partial", "disputed", "void"],
  disputed: ["issued", "void"],
  void: [], // terminal
};

// ---------------------------------------------------------------------------
// Tax Types Registry (BIR + Global)
// ---------------------------------------------------------------------------

export const TAX_TYPES = {
  // ────────────────────────────────────────────────────────────────────────
  // 🇵🇭 PHILIPPINES — BIR (Core)
  // ────────────────────────────────────────────────────────────────────────

  VAT: "VAT", // 12% standard VAT
  ZERO_RATED_VAT: "ZERO_RATED_VAT", // 0% VAT (export, PEZA, etc.)
  VAT_EXEMPT: "VAT_EXEMPT", // Non-VAT / exempt transactions

  // Withholding Taxes (Expanded / Creditable)
  EWT: "EWT", // Expanded Withholding Tax (generic)
  CWT: "CWT", // Creditable Withholding Tax (alias of EWT)

  // Common specific EWT categories (optional granularity)
  EWT_PROFESSIONAL_FEES: "EWT_PROFESSIONAL_FEES",
  EWT_RENTALS: "EWT_RENTALS",
  EWT_CONTRACTORS: "EWT_CONTRACTORS",
  EWT_SUPPLIERS: "EWT_SUPPLIERS",

  // Final Withholding Taxes
  FWT: "FWT",

  // Percentage Tax (Non-VAT businesses)
  PERCENTAGE_TAX: "PERCENTAGE_TAX",

  // Excise Tax (PH-specific regulated goods)
  EXCISE_TAX_PH: "EXCISE_TAX_PH",

  // Documentary Stamp Tax
  DST: "DST",

  // Local Government Taxes
  LOCAL_BUSINESS_TAX: "LOCAL_BUSINESS_TAX",
  REAL_PROPERTY_TAX: "REAL_PROPERTY_TAX",

  // ────────────────────────────────────────────────────────────────────────
  // 🌍 GLOBAL — Common Tax Types
  // ────────────────────────────────────────────────────────────────────────

  GST: "GST", // Goods & Services Tax
  HST: "HST", // Harmonized Sales Tax (Canada)
  SALES_TAX: "SALES_TAX", // US-style sales tax
  CONSUMPTION_TAX: "CONSUMPTION_TAX",

  // EU / International VAT variants
  VAT_STANDARD: "VAT_STANDARD",
  VAT_REDUCED: "VAT_REDUCED",
  VAT_DIGITAL_SERVICES: "VAT_DIGITAL_SERVICES",

  // Withholding (global)
  WITHHOLDING_TAX: "WITHHOLDING_TAX",
  DIVIDEND_WITHHOLDING_TAX: "DIVIDEND_WITHHOLDING_TAX",
  ROYALTY_WITHHOLDING_TAX: "ROYALTY_WITHHOLDING_TAX",

  // Industry-specific
  EXCISE_TAX: "EXCISE_TAX",
  IMPORT_DUTY: "IMPORT_DUTY",
  CUSTOMS_DUTY: "CUSTOMS_DUTY",
  ENVIRONMENTAL_TAX: "ENVIRONMENTAL_TAX",
  CARBON_TAX: "CARBON_TAX",
  LUXURY_TAX: "LUXURY_TAX",

  // Informational / classification
  TAX_EXEMPT: "TAX_EXEMPT",
  ZERO_RATED: "ZERO_RATED",
} as const;

export type TaxType = (typeof TAX_TYPES)[keyof typeof TAX_TYPES];
