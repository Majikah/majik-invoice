/**
 * @file csv-export.ts
 * @description CSV export primitives for GeneralInvoice and MajikInvoice.
 *
 * Three moving parts:
 *
 *   1. CSVColumn<T>         — a typed column descriptor with a resolve function
 *   2. DEFAULT_CSV_COLUMNS  — curated default set, grouped by category
 *   3. ALL_CSV_COLUMNS      — every available column; use for the checkbox UI
 *
 * Usage:
 *   // GeneralInvoice — single export
 *   const csv = invoice.toCSV();
 *   const custom = invoice.toCSV([...DEFAULT_CSV_COLUMNS, ...myExtraColumns]);
 *
 *   // MajikInvoice — batch export
 *   const result = await MajikInvoice.batchExportToCSV(invoices);
 *   const custom  = await MajikInvoice.batchExportToCSV(invoices, { columns: myColumns });
 */

import type { GeneralInvoice } from "./general-invoice";
import type { PublicInvoiceSummary } from "./types"; // MajikInvoice public summary

// ---------------------------------------------------------------------------
// Return type — add near the other Batch types (BatchDecryptResult, etc.)
// ---------------------------------------------------------------------------

/**
 * Result returned by MajikInvoice.batchExportToCSV().
 */
export interface CSVExportResult {
  /** The full CSV string — header row + one data row per invoice */
  csv: string;
  /** Total number of invoices processed */
  count: number;
  /**
   * true if every invoice was exported with full data.
   * false if any invoice was encrypted and fell back to public-only fields,
   * or if any invoice errored during row generation.
   */
  success: boolean;
  /** Invoices that were exported but with limited (public-only) data */
  partialExports: Array<{
    invoiceId: string;
    reason: "encrypted-no-cache" | "invoice-unavailable";
    /** Column keys that could not be resolved and were left blank */
    unavailableColumns: string[];
  }>;
  /** Invoices that could not be exported at all (row generation threw) */
  errors: Array<{
    invoiceId: string;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Column group discriminant — used for the checkbox-grid UI
// ---------------------------------------------------------------------------

export type CSVColumnGroup =
  | "identity" // id, invoiceNumber, type, status
  | "parties" // issuer, recipient
  | "dates" // issueDate, dueDate, period
  | "totals" // subtotal, tax, grandTotal, etc.
  | "tax" // per-taxType breakdown columns (dynamic)
  | "line_items" // line item summary fields
  | "payment" // paymentStatus, totalPaid, amountDue
  | "accounting" // costCenters, accountCodes
  | "meta"; // notes, tags, metadata keys

// ---------------------------------------------------------------------------
// CSVColumn — the column descriptor
// ---------------------------------------------------------------------------

/**
 * A single column definition for CSV export.
 *
 * `resolve` receives whichever data is available:
 *   - `invoice`  — the full GeneralInvoice (always present for signed-only,
 *                  present for encrypted if already decrypted this session)
 *   - `public`   — MajikInvoice public summary (always available, even when
 *                  the GeneralInvoice cannot be accessed)
 *
 * Columns SHOULD degrade gracefully — return an empty string if neither
 * source has the data, rather than throwing.
 *
 * @example
 * const invoiceNumberCol: CSVColumn = {
 *   key: "invoiceNumber",
 *   label: "Invoice Number",
 *   group: "identity",
 *   resolve: ({ invoice, public: pub }) =>
 *     invoice?.invoiceNumber ?? pub?.invoiceNumber ?? "",
 * };
 */
export interface CSVColumn {
  /** Unique machine key — used for deduplication and column selection */
  key: string;
  /** Human-readable header label printed in the CSV */
  label: string;
  /** Logical grouping for the checkbox UI */
  group: CSVColumnGroup;
  /**
   * Extract the cell value.
   * Must NOT throw — return "" for missing data.
   */
  resolve: (ctx: CSVResolveContext) => string;
}

/**
 * Context passed to each column's `resolve` function.
 *
 * `invoice` is undefined when the MajikInvoice is encrypted and has not
 * been decrypted this session. Columns that only live on GeneralInvoice
 * should handle this gracefully.
 */
export interface CSVResolveContext {
  /** Full GeneralInvoice — undefined for locked encrypted invoices */
  invoice?: GeneralInvoice;
  /** Always-available public summary from MajikInvoice */
  public?: PublicInvoiceSummary;
  /** The raw MajikInvoice id (always present) */
  invoiceId: string;
}

// ---------------------------------------------------------------------------
// CSV escape helper
// ---------------------------------------------------------------------------

/** RFC 4180 — wrap in quotes and escape internal quotes by doubling them */
function esc(value: string): string {
  if (value == null) return "";

  let str = String(value);

  // Prevent CSV injection (Excel)
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }

  const needsQuotes =
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r");

  if (needsQuotes) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

// ── Identity ──────────────────────────────────────────────────────────────

const COL_ID: CSVColumn = {
  key: "id",
  label: "Invoice ID",
  group: "identity",
  resolve: ({ invoice, invoiceId }) => invoice?.id ?? invoiceId,
};

const COL_INVOICE_NUMBER: CSVColumn = {
  key: "invoiceNumber",
  label: "Invoice Number",
  group: "identity",
  resolve: ({ invoice, public: pub }) =>
    invoice?.invoiceNumber ?? pub?.invoiceNumber ?? "",
};

const COL_TYPE: CSVColumn = {
  key: "type",
  label: "Invoice Type",
  group: "identity",
  resolve: ({ invoice, public: pub }) =>
    invoice?.type ?? pub?.invoiceType ?? "",
};

const COL_STATUS: CSVColumn = {
  key: "status",
  label: "Invoice Status",
  group: "identity",
  resolve: ({ invoice, public: pub }) => invoice?.status ?? pub?.status ?? "",
};

const COL_PAYMENT_STATUS_IDENTITY: CSVColumn = {
  key: "paymentStatus",
  label: "Payment Status",
  group: "identity",
  resolve: ({ invoice, public: pub }) =>
    invoice?.paymentStatus ?? pub?.paymentStatus ?? "",
};

// ── Parties ───────────────────────────────────────────────────────────────

const COL_ISSUER_NAME: CSVColumn = {
  key: "issuerName",
  label: "Issuer Name",
  group: "parties",
  resolve: ({ invoice, public: pub }) =>
    invoice?.issuer.legalName ?? pub?.issuerName ?? "",
};

const COL_ISSUER_TIN: CSVColumn = {
  key: "issuerTin",
  label: "Issuer TIN",
  group: "parties",
  resolve: ({ invoice }) => invoice?.issuer.tin ?? "",
};

const COL_ISSUER_EMAIL: CSVColumn = {
  key: "issuerEmail",
  label: "Issuer Email",
  group: "parties",
  resolve: ({ invoice }) => invoice?.issuer.email ?? "",
};

const COL_ISSUER_ADDRESS: CSVColumn = {
  key: "issuerAddress",
  label: "Issuer Address",
  group: "parties",
  resolve: ({ invoice }) => {
    const a = invoice?.issuer.address;
    if (!a) return "";
    return [
      a.line1,
      a.line2,
      a.city,
      a.stateOrProvince,
      a.postalCode,
      a.country,
    ]
      .filter(Boolean)
      .join(", ");
  },
};

const COL_RECIPIENT_NAME: CSVColumn = {
  key: "recipientName",
  label: "Recipient Name",
  group: "parties",
  resolve: ({ invoice, public: pub }) =>
    invoice?.recipient.legalName ?? pub?.recipientName ?? "",
};

const COL_RECIPIENT_TIN: CSVColumn = {
  key: "recipientTin",
  label: "Recipient TIN",
  group: "parties",
  resolve: ({ invoice }) => invoice?.recipient.tin ?? "",
};

const COL_RECIPIENT_EMAIL: CSVColumn = {
  key: "recipientEmail",
  label: "Recipient Email",
  group: "parties",
  resolve: ({ invoice }) => invoice?.recipient.email ?? "",
};

const COL_RECIPIENT_ADDRESS: CSVColumn = {
  key: "recipientAddress",
  label: "Recipient Address",
  group: "parties",
  resolve: ({ invoice }) => {
    const a = invoice?.recipient.address;
    if (!a) return "";
    return [
      a.line1,
      a.line2,
      a.city,
      a.stateOrProvince,
      a.postalCode,
      a.country,
    ]
      .filter(Boolean)
      .join(", ");
  },
};

// ── Dates ─────────────────────────────────────────────────────────────────

const COL_ISSUE_DATE: CSVColumn = {
  key: "issueDate",
  label: "Issue Date",
  group: "dates",
  resolve: ({ invoice, public: pub }) =>
    normalizeDate(invoice?.issueDate ?? pub?.issuedAt),
};

const COL_DUE_DATE: CSVColumn = {
  key: "dueDate",
  label: "Due Date",
  group: "dates",
  resolve: ({ invoice, public: pub }) =>
    normalizeDate(invoice?.dueDate ?? pub?.dueDate),
};

const COL_PERIOD_START: CSVColumn = {
  key: "periodStart",
  label: "Period Start",
  group: "dates",
  resolve: ({ invoice }) => invoice?.period?.start ?? "",
};

const COL_PERIOD_END: CSVColumn = {
  key: "periodEnd",
  label: "Period End",
  group: "dates",
  resolve: ({ invoice }) => invoice?.period?.end ?? "",
};

const COL_PAYMENT_TERMS: CSVColumn = {
  key: "paymentTerms",
  label: "Payment Terms",
  group: "dates",
  resolve: ({ invoice }) => invoice?.paymentTerms ?? "",
};

// ── Totals ────────────────────────────────────────────────────────────────

const COL_CURRENCY: CSVColumn = {
  key: "currency",
  label: "Currency",
  group: "totals",
  resolve: ({ invoice, public: pub }) =>
    invoice?.currency ?? pub?.currency ?? "",
};

const COL_SUBTOTAL: CSVColumn = {
  key: "subtotal",
  label: "Subtotal",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.subtotalAmount.toFixed(2)) : "",
};

const COL_DISCOUNT_TOTAL: CSVColumn = {
  key: "discountTotal",
  label: "Total Discount",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.discountAmount.toFixed(2)) : "",
};

const COL_TAX_TOTAL: CSVColumn = {
  key: "taxTotal",
  label: "Total Tax",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.taxAmount.toFixed(2)) : "",
};

const COL_WITHHOLDING_TOTAL: CSVColumn = {
  key: "withholdingTotal",
  label: "Total Withholding",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.withholdingAmount.toFixed(2)) : "",
};

const COL_GRAND_TOTAL: CSVColumn = {
  key: "grandTotal",
  label: "Grand Total",
  group: "totals",
  resolve: ({ invoice, public: pub }) => {
    if (invoice != null) return String(invoice.totalAmount.toFixed(2));
    if (pub?.totalAmount != null) return String(pub.totalAmount.toFixed(2));
    return "";
  },
};

const COL_NET_PAYABLE: CSVColumn = {
  key: "netPayable",
  label: "Net Payable",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.netPayableAmount.toFixed(2)) : "",
};

const COL_EFFECTIVE_TAX_RATE: CSVColumn = {
  key: "effectiveTaxRate",
  label: "Effective Tax Rate",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? `${(invoice.effectiveTaxRate * 100).toFixed(2)}%` : "",
};

const COL_FORMATTED_TOTAL: CSVColumn = {
  key: "formattedTotal",
  label: "Formatted Total",
  group: "totals",
  resolve: ({ invoice, public: pub }) =>
    invoice?.formattedTotal ?? pub?.formattedTotal ?? "",
};

// ── Payment ───────────────────────────────────────────────────────────────

const COL_TOTAL_PAID: CSVColumn = {
  key: "totalPaid",
  label: "Total Paid",
  group: "payment",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.totalPaid.toMajor().toFixed(2)) : "",
};

const COL_AMOUNT_DUE: CSVColumn = {
  key: "amountDue",
  label: "Amount Due",
  group: "payment",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.amountDue.toMajor().toFixed(2)) : "",
};

const COL_IS_FULLY_PAID: CSVColumn = {
  key: "isFullyPaid",
  label: "Fully Paid",
  group: "payment",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.isFullyPaid) : "",
};

const COL_PAYMENT_COUNT: CSVColumn = {
  key: "paymentCount",
  label: "Payment Count",
  group: "payment",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.proofOfPayments.length) : "",
};

// ── Line Items (summary — not per-row expansion) ──────────────────────────

const COL_LINE_ITEM_COUNT: CSVColumn = {
  key: "lineItemCount",
  label: "Line Item Count",
  group: "line_items",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.lineItemCount) : "",
};

const COL_LINE_ITEM_DESCRIPTIONS: CSVColumn = {
  key: "lineItemDescriptions",
  label: "Line Item Descriptions",
  group: "line_items",
  resolve: ({ invoice }) =>
    invoice != null
      ? invoice.lineItems.map((li) => li.description).join(" | ")
      : "",
};

const COL_LINE_ITEM_QUANTITIES: CSVColumn = {
  key: "lineItemQuantities",
  label: "Line Item Quantities",
  group: "line_items",
  resolve: ({ invoice }) =>
    invoice != null
      ? invoice.lineItems.map((li) => String(li.quantity)).join(" | ")
      : "",
};

const COL_LINE_ITEM_UNIT_PRICES: CSVColumn = {
  key: "lineItemUnitPrices",
  label: "Line Item Unit Prices",
  group: "line_items",
  resolve: ({ invoice }) =>
    invoice != null
      ? invoice.lineItems
          .map((li) => li.unitPrice.toMajor().toFixed(2))
          .join(" | ")
      : "",
};

const COL_LINE_ITEM_NET_TOTALS: CSVColumn = {
  key: "lineItemNetTotals",
  label: "Line Item Net Totals",
  group: "line_items",
  resolve: ({ invoice }) =>
    invoice != null
      ? invoice.lineItems.map((li) => li.netTotalAmount.toFixed(2)).join(" | ")
      : "",
};

// ── Accounting ────────────────────────────────────────────────────────────

const COL_COST_CENTERS: CSVColumn = {
  key: "costCenters",
  label: "Cost Centers",
  group: "accounting",
  resolve: ({ invoice }) => invoice?.costCenters.join(" | ") ?? "",
};

const COL_ACCOUNT_CODES: CSVColumn = {
  key: "accountCodes",
  label: "Account Codes",
  group: "accounting",
  resolve: ({ invoice }) => invoice?.accountCodes.join(" | ") ?? "",
};

const COL_TAX_TYPES: CSVColumn = {
  key: "taxTypes",
  label: "Tax Types",
  group: "accounting",
  resolve: ({ invoice }) => invoice?.taxTypes.join(" | ") ?? "",
};

// ── Meta ──────────────────────────────────────────────────────────────────

const COL_NOTES: CSVColumn = {
  key: "notes",
  label: "Notes",
  group: "meta",
  resolve: ({ invoice }) => invoice?.notes ?? "",
};

const COL_TAGS: CSVColumn = {
  key: "tags",
  label: "Tags",
  group: "meta",
  resolve: ({ invoice }) => invoice?.tags?.join(", ") ?? "",
};

// ---------------------------------------------------------------------------
// Column catalogs
// ---------------------------------------------------------------------------

/**
 * Every available static column (non-dynamic tax breakdown columns).
 * Use this to populate the checkbox-grid UI.
 *
 * Dynamic per-taxType columns are generated at export time via
 * `buildTaxBreakdownColumns()` below.
 */
export const ALL_CSV_COLUMNS: CSVColumn[] = [
  // identity
  COL_ID,
  COL_INVOICE_NUMBER,
  COL_TYPE,
  COL_STATUS,
  COL_PAYMENT_STATUS_IDENTITY,
  // parties
  COL_ISSUER_NAME,
  COL_ISSUER_TIN,
  COL_ISSUER_EMAIL,
  COL_ISSUER_ADDRESS,
  COL_RECIPIENT_NAME,
  COL_RECIPIENT_TIN,
  COL_RECIPIENT_EMAIL,
  COL_RECIPIENT_ADDRESS,
  // dates
  COL_ISSUE_DATE,
  COL_DUE_DATE,
  COL_PERIOD_START,
  COL_PERIOD_END,
  COL_PAYMENT_TERMS,
  // totals
  COL_CURRENCY,
  COL_SUBTOTAL,
  COL_DISCOUNT_TOTAL,
  COL_TAX_TOTAL,
  COL_WITHHOLDING_TOTAL,
  COL_GRAND_TOTAL,
  COL_NET_PAYABLE,
  COL_EFFECTIVE_TAX_RATE,
  COL_FORMATTED_TOTAL,
  // payment
  COL_TOTAL_PAID,
  COL_AMOUNT_DUE,
  COL_IS_FULLY_PAID,
  COL_PAYMENT_COUNT,
  // line items
  COL_LINE_ITEM_COUNT,
  COL_LINE_ITEM_DESCRIPTIONS,
  COL_LINE_ITEM_QUANTITIES,
  COL_LINE_ITEM_UNIT_PRICES,
  COL_LINE_ITEM_NET_TOTALS,
  // accounting
  COL_COST_CENTERS,
  COL_ACCOUNT_CODES,
  COL_TAX_TYPES,
  // meta
  COL_NOTES,
  COL_TAGS,
];

/**
 * Default column set — the essentials shown in a standard export.
 * This is what `toCSV()` and `batchExportToCSV()` use when no columns are provided.
 */
export const DEFAULT_CSV_COLUMNS: CSVColumn[] = [
  COL_ID,
  COL_INVOICE_NUMBER,
  COL_TYPE,
  COL_STATUS,
  COL_ISSUER_NAME,
  COL_RECIPIENT_NAME,
  COL_ISSUE_DATE,
  COL_DUE_DATE,
  COL_CURRENCY,
  COL_SUBTOTAL,
  COL_TAX_TOTAL,
  COL_GRAND_TOTAL,
  COL_NET_PAYABLE,
  COL_PAYMENT_STATUS_IDENTITY,
  COL_TOTAL_PAID,
  COL_AMOUNT_DUE,
];

// ---------------------------------------------------------------------------
// Dynamic tax breakdown column builder
// ---------------------------------------------------------------------------

/**
 * Build per-taxType additive tax columns dynamically from a known set of
 * tax types. Useful when you know the tax types present in your invoice
 * population up front (e.g. ["VAT", "EXCISE"]).
 *
 * These complement ALL_CSV_COLUMNS for the checkbox UI — call this after
 * scanning your invoices and merge into your column list.
 *
 * @example
 * const taxCols = buildTaxBreakdownColumns(["VAT", "EWT"]);
 * const columns = [...DEFAULT_CSV_COLUMNS, ...taxCols];
 */
export function buildTaxBreakdownColumns(taxTypes: string[]): CSVColumn[] {
  const cols: CSVColumn[] = [];
  for (const taxType of taxTypes) {
    const upper = taxType.toUpperCase();

    cols.push({
      key: `tax_${upper}_additive`,
      label: `${upper} Amount`,
      group: "tax",
      resolve: ({ invoice }) => {
        if (!invoice) return "";
        return String(invoice.taxTotalByType(upper).toFixed(2));
      },
    });

    cols.push({
      key: `tax_${upper}_withholding`,
      label: `${upper} Withholding`,
      group: "tax",
      resolve: ({ invoice }) => {
        if (!invoice) return "";
        return String(invoice.withholdingTotalByType(upper).toFixed(2));
      },
    });
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Helpers used by GeneralInvoice.toCSV() and MajikInvoice.batchExportToCSV()
// ---------------------------------------------------------------------------

/** Build a single CSV header row from a column list */
export function buildCSVHeader(columns: CSVColumn[]): string {
  return columns.map((c) => esc(c.label)).join(",");
}

/** Build a single CSV data row given a context and column list */
export function buildCSVRow(
  ctx: CSVResolveContext,
  columns: CSVColumn[],
): string {
  return columns
    .map((c) => {
      try {
        return esc(c.resolve(ctx));
      } catch (e) {
        console.debug("Problem building row: ", e);
        return "";
      }
    })
    .join(",");
}

export function dedupeColumns(columns: CSVColumn[]): CSVColumn[] {
  const seen = new Set<string>();
  return columns.filter((c) => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
}

function normalizeDate(value: unknown): string {
  if (!value) return "";

  let date: Date;

  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) return "";
    date = parsed;
  } else {
    return "";
  }

  // Always output YYYY-MM-DD (CSV-safe, Excel-friendly)
  return date.toISOString().slice(0, 10);
}
