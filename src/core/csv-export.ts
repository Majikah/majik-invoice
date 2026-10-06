/**
 * @file csv-export.ts
 * @description Shared CSV-export primitives used by both `GeneralInvoice` and
 * `MajikInvoice`.
 *
 * This module defines the complete column-driven CSV export system:
 *
 * 1. `CSVColumn` — a typed column descriptor containing the machine key,
 *    display label, logical UI group, and value resolver.
 * 2. `DEFAULT_CSV_COLUMNS` — the curated set of commonly useful columns used
 *    by standard exports.
 * 3. `ALL_CSV_COLUMNS` — the complete catalog of static columns available to
 *    the export-column selection UI.
 * 4. `buildTaxBreakdownColumns()` — dynamically creates columns for specific
 *    tax types discovered in an invoice population.
 * 5. CSV helpers — shared utilities for header construction, row generation,
 *    deduplication, escaping, and date normalization.
 *
 * The column architecture allows the same export engine to work with:
 *
 * - a fully accessible `GeneralInvoice`;
 * - a `MajikInvoice` whose encrypted invoice has already been decrypted;
 * - a locked encrypted `MajikInvoice`, where only its public summary is
 *   available.
 *
 * Column resolvers are intentionally designed to degrade gracefully. Missing
 * information should produce an empty CSV cell rather than causing the entire
 * export to fail.
 *
 * Usage:
 *   // GeneralInvoice — single export
 *   const csv = invoice.toCSV();
 *   const custom = invoice.toCSV([...DEFAULT_CSV_COLUMNS, ...myExtraColumns]);
 *
 *   // MajikInvoice — batch export
 *   const result = await MajikInvoice.batchExportToCSV(invoices);
 *   const custom = await MajikInvoice.batchExportToCSV(invoices, {
 *     columns: myColumns,
 *   });
 */

import type { GeneralInvoice } from "./general-invoice/general-invoice.js";

import type { PublicInvoiceSummary } from "./types.js"; // MajikInvoice public summary

// ---------------------------------------------------------------------------
// Return type — add near the other Batch types (BatchDecryptResult, etc.)
// ---------------------------------------------------------------------------

/**
 * Result returned by `MajikInvoice.batchExportToCSV()`.
 *
 * The result contains the generated CSV together with aggregate export
 * information describing whether every invoice was exported with complete
 * data, whether some invoices had to fall back to public-only information,
 * and whether any rows could not be generated.
 */
export interface CSVExportResult {
  /**
   * The complete CSV document as a string.
   *
   * Includes the header row followed by one data row for each invoice that
   * was processed.
   */
  csv: string;

  /**
   * Total number of invoices processed by the export operation.
   */
  count: number;

  /**
   * Indicates whether every invoice was exported with full available data.
   *
   * `false` indicates that at least one invoice:
   *
   * - was encrypted but had no decrypted cache, causing a public-only
   *   fallback; or
   * - encountered an error while generating its row.
   */
  success: boolean;

  /**
   * Invoices that were successfully included in the CSV but only with
   * limited/publicly available data.
   *
   * This occurs when the full `GeneralInvoice` is unavailable, such as for
   * an encrypted invoice that has not been decrypted during the current
   * session.
   */
  partialExports: Array<{
    /**
     * Identifier of the invoice that was exported partially.
     */
    invoiceId: string;

    /**
     * Why the invoice could only be exported with limited data.
     *
     * - `encrypted-no-cache` — the invoice is encrypted and no decrypted
     *   runtime cache is available.
     * - `invoice-unavailable` — the underlying invoice data could not be
     *   accessed for another reason.
     */
    reason: "encrypted-no-cache" | "invoice-unavailable";

    /**
     * Column keys whose values could not be resolved because the required
     * invoice data was unavailable.
     *
     * These columns are represented by blank cells in the generated CSV.
     */
    unavailableColumns: string[];
  }>;

  /**
   * Invoices that could not be exported at all because row generation
   * encountered an error.
   */
  errors: Array<{
    /**
     * Identifier of the invoice whose row could not be generated.
     */
    invoiceId: string;

    /**
     * Description of the error encountered while exporting the invoice.
     */
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Column group discriminant — used for the checkbox-grid UI
// ---------------------------------------------------------------------------

/**
 * Logical category assigned to a CSV column.
 *
 * These groups provide a stable vocabulary for organizing exportable fields
 * in the column-selection/checkbox UI.
 */
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
 * Describes one exportable CSV column.
 *
 * A `CSVColumn` contains both the presentation metadata required to build the
 * CSV header and the resolver responsible for extracting the corresponding
 * cell value from an invoice context.
 *
 * The same column descriptor can therefore be reused across:
 *
 * - `GeneralInvoice.toCSV()`;
 * - `MajikInvoice.batchExportToCSV()`;
 * - custom export configurations;
 * - column-selection UIs.
 *
 * `resolve` receives whichever invoice information is currently available:
 *
 * - `invoice` — the full `GeneralInvoice`, available for signed-only invoices
 *   and for encrypted invoices that have already been decrypted during the
 *   current session.
 * - `public` — the `MajikInvoice` public summary, available even when the full
 *   invoice remains inaccessible.
 *
 * Columns should be resilient to partial access. A resolver should return an
 * empty string when the requested field is unavailable instead of throwing.
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
  /**
   * Unique machine-readable identifier for the column.
   *
   * The key is used for column deduplication, selection, and dynamic
   * column composition. It should remain stable for a given logical field.
   */
  key: string;

  /**
   * Human-readable column heading written into the CSV header row.
   */
  label: string;

  /**
   * Logical UI category used to group the column in the export-selection
   * interface.
   */
  group: CSVColumnGroup;

  /**
   * Resolves the value to place in this column's CSV cell.
   *
   * The resolver receives a `CSVResolveContext` containing the invoice data
   * currently available to the exporter.
   *
   * Resolvers must not throw for expected missing-data scenarios. Return
   * `""` when the requested information is unavailable.
   */
  resolve: (ctx: CSVResolveContext) => string;
}

/**
 * Data context supplied to a `CSVColumn.resolve()` function.
 *
 * This context deliberately separates the full invoice from the public
 * summary so the CSV system can export encrypted invoices without requiring
 * access to their decrypted contents.
 *
 * `invoice` is undefined when the full `GeneralInvoice` is unavailable, such
 * as when an encrypted `MajikInvoice` has not been decrypted during the
 * current session.
 */
export interface CSVResolveContext {
  /**
   * Full business invoice data.
   *
   * Undefined for locked encrypted invoices where the `GeneralInvoice` is not
   * currently available.
   */
  invoice?: GeneralInvoice;

  /**
   * Public `MajikInvoice` summary.
   *
   * This remains available even when the full encrypted invoice cannot be
   * accessed.
   */
  public?: PublicInvoiceSummary;

  /**
   * Raw `MajikInvoice` identifier.
   *
   * This value is always available and provides a stable fallback for the
   * invoice ID column.
   */
  invoiceId: string;
}

// ---------------------------------------------------------------------------
// CSV escape helper
// ---------------------------------------------------------------------------

/**
 * Options controlling CSV value escaping.
 */
export interface CSVEscapeOptions {
  /**
   * Preserve newline characters in values instead of flattening multiline
   * content into a single line.
   */
  preserveNewlines?: boolean;
}

/**
 * Escape a value for CSV output using RFC-style quoting rules.
 *
 * The helper:
 *
 * - converts nullish values to an empty string;
 * - normalizes line endings to `\n`;
 * - removes null bytes;
 * - optionally flattens multiline content;
 * - prefixes potentially executable spreadsheet formulas to reduce
 *   Excel-style CSV injection risk;
 * - wraps values containing commas, quotes, or newlines in double quotes;
 * - doubles internal double quotes according to CSV escaping rules.
 *
 * @param value Value to convert into a CSV-safe cell.
 * @param options Optional escaping behavior.
 * @returns A CSV-safe string representation of the value.
 */
function esc(value: unknown, options?: CSVEscapeOptions): string {
  if (value == null) return "";
  let str = String(value);

  // normalize line endings
  str = str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // remove null bytes
  str = str.replace(/\0/g, "");

  // flatten multiline content for CSV compatibility
  if (!options?.preserveNewlines) {
    str = str.replace(/\n{2,}/g, " || ");
    str = str.replace(/\n/g, " ");
  }

  // prevent excel injection
  if (/^\s*[=+\-@]/.test(str)) {
    str = `'${str}`;
  }

  const needsQuotes =
    str.includes(",") || str.includes('"') || str.includes("\n");

  if (needsQuotes) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

// ── Identity ──────────────────────────────────────────────────────────────

/**
 * Exports the invoice's stable identifier.
 *
 * Uses the `GeneralInvoice` ID when available and falls back to the raw
 * `MajikInvoice` ID otherwise.
 */
const COL_ID: CSVColumn = {
  key: "id",
  label: "Invoice ID",
  group: "identity",
  resolve: ({ invoice, invoiceId }) => invoice?.id ?? invoiceId,
};

/**
 * Exports the human-facing invoice number.
 *
 * Falls back to the public summary when the full invoice is unavailable.
 */
const COL_INVOICE_NUMBER: CSVColumn = {
  key: "invoiceNumber",
  label: "Invoice Number",
  group: "identity",
  resolve: ({ invoice, public: pub }) =>
    invoice?.invoiceNumber ?? pub?.invoiceNumber ?? "",
};

/**
 * Exports the invoice document type.
 *
 * Uses the full invoice when available and otherwise falls back to the public
 * summary.
 */
const COL_TYPE: CSVColumn = {
  key: "type",
  label: "Invoice Type",
  group: "identity",
  resolve: ({ invoice, public: pub }) =>
    invoice?.type ?? pub?.invoiceType ?? "",
};

/**
 * Exports the current invoice lifecycle status.
 *
 * Uses the full invoice status when available and otherwise falls back to the
 * public summary status.
 */
const COL_STATUS: CSVColumn = {
  key: "status",
  label: "Invoice Status",
  group: "identity",
  resolve: ({ invoice, public: pub }) => invoice?.status ?? pub?.status ?? "",
};

/**
 * Exports the invoice payment status.
 *
 * This identity-level payment field is available from either the full invoice
 * or the public summary.
 */
const COL_PAYMENT_STATUS_IDENTITY: CSVColumn = {
  key: "paymentStatus",
  label: "Payment Status",
  group: "identity",
  resolve: ({ invoice, public: pub }) =>
    invoice?.paymentStatus ?? pub?.paymentStatus ?? "",
};

// ── Parties ───────────────────────────────────────────────────────────────

/**
 * Exports the issuer's legal name.
 *
 * Falls back to the public summary when full invoice data is unavailable.
 */
const COL_ISSUER_NAME: CSVColumn = {
  key: "issuerName",
  label: "Issuer Name",
  group: "parties",
  resolve: ({ invoice, public: pub }) =>
    invoice?.issuer.legalName ?? pub?.issuerName ?? "",
};

/**
 * Exports the issuer's taxpayer identification number.
 *
 * Requires access to the full `GeneralInvoice`.
 */
const COL_ISSUER_TIN: CSVColumn = {
  key: "issuerTin",
  label: "Issuer TIN",
  group: "parties",
  resolve: ({ invoice }) => invoice?.issuer.tin ?? "",
};

/**
 * Exports the issuer's email address.
 *
 * Requires access to the full `GeneralInvoice`.
 */
const COL_ISSUER_EMAIL: CSVColumn = {
  key: "issuerEmail",
  label: "Issuer Email",
  group: "parties",
  resolve: ({ invoice }) => invoice?.issuer.email ?? "",
};

/**
 * Exports the issuer's address as a single comma-separated field.
 *
 * Empty address components are omitted before the remaining components are
 * joined.
 */
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

/**
 * Exports the recipient's legal name.
 *
 * Falls back to the public summary when full invoice data is unavailable.
 */
const COL_RECIPIENT_NAME: CSVColumn = {
  key: "recipientName",
  label: "Recipient Name",
  group: "parties",
  resolve: ({ invoice, public: pub }) =>
    invoice?.recipient.legalName ?? pub?.recipientName ?? "",
};

/**
 * Exports the recipient's taxpayer identification number.
 *
 * Requires access to the full `GeneralInvoice`.
 */
const COL_RECIPIENT_TIN: CSVColumn = {
  key: "recipientTin",
  label: "Recipient TIN",
  group: "parties",
  resolve: ({ invoice }) => invoice?.recipient.tin ?? "",
};

/**
 * Exports the recipient's email address.
 *
 * Requires access to the full `GeneralInvoice`.
 */
const COL_RECIPIENT_EMAIL: CSVColumn = {
  key: "recipientEmail",
  label: "Recipient Email",
  group: "parties",
  resolve: ({ invoice }) => invoice?.recipient.email ?? "",
};

/**
 * Exports the recipient's address as a single comma-separated field.
 *
 * Empty address components are omitted before the remaining components are
 * joined.
 */
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

/**
 * Exports the invoice issue date in normalized `YYYY-MM-DD` form.
 *
 * Falls back to the public summary's `issuedAt` value when the full invoice
 * is unavailable.
 */
const COL_ISSUE_DATE: CSVColumn = {
  key: "issueDate",
  label: "Issue Date",
  group: "dates",
  resolve: ({ invoice, public: pub }) =>
    normalizeDate(invoice?.issueDate ?? pub?.issuedAt),
};

/**
 * Exports the invoice due date in normalized `YYYY-MM-DD` form.
 *
 * Falls back to the public summary's due date when the full invoice is
 * unavailable.
 */
const COL_DUE_DATE: CSVColumn = {
  key: "dueDate",
  label: "Due Date",
  group: "dates",
  resolve: ({ invoice, public: pub }) =>
    normalizeDate(invoice?.dueDate ?? pub?.dueDate),
};

/**
 * Exports the beginning of the invoice's service or billing period.
 */
const COL_PERIOD_START: CSVColumn = {
  key: "periodStart",
  label: "Period Start",
  group: "dates",
  resolve: ({ invoice }) => invoice?.period?.start ?? "",
};

/**
 * Exports the end of the invoice's service or billing period.
 */
const COL_PERIOD_END: CSVColumn = {
  key: "periodEnd",
  label: "Period End",
  group: "dates",
  resolve: ({ invoice }) => invoice?.period?.end ?? "",
};

/**
 * Exports the invoice's payment terms.
 */
const COL_PAYMENT_TERMS: CSVColumn = {
  key: "paymentTerms",
  label: "Payment Terms",
  group: "dates",
  resolve: ({ invoice }) => invoice?.paymentTerms ?? "",
};

// ── Totals ────────────────────────────────────────────────────────────────

/**
 * Exports the invoice currency code.
 *
 * Falls back to the public summary when the full invoice is unavailable.
 */
const COL_CURRENCY: CSVColumn = {
  key: "currency",
  label: "Currency",
  group: "totals",
  resolve: ({ invoice, public: pub }) =>
    invoice?.currency ?? pub?.currency ?? "",
};

/**
 * Exports the invoice subtotal before discounts and taxes.
 *
 * Requires access to the full invoice.
 */
const COL_SUBTOTAL: CSVColumn = {
  key: "subtotal",
  label: "Subtotal",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.subtotalAmount.toFixed(2)) : "",
};

/**
 * Exports the total discount amount applied to the invoice.
 */
const COL_DISCOUNT_TOTAL: CSVColumn = {
  key: "discountTotal",
  label: "Total Discount",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.discountAmount.toFixed(2)) : "",
};

/**
 * Exports the aggregate tax amount.
 */
const COL_TAX_TOTAL: CSVColumn = {
  key: "taxTotal",
  label: "Total Tax",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.taxAmount.toFixed(2)) : "",
};

/**
 * Exports the aggregate withholding amount.
 */
const COL_WITHHOLDING_TOTAL: CSVColumn = {
  key: "withholdingTotal",
  label: "Total Withholding",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.withholdingAmount.toFixed(2)) : "",
};

/**
 * Exports the invoice grand total.
 *
 * When the full invoice is available, the canonical invoice total is used.
 * Otherwise, the public summary total is used when present.
 */
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

/**
 * Exports the amount remaining after withholding adjustments.
 */
const COL_NET_PAYABLE: CSVColumn = {
  key: "netPayable",
  label: "Net Payable",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.netPayableAmount.toFixed(2)) : "",
};

/**
 * Exports the invoice's effective tax rate as a percentage string.
 *
 * Example: `0.125` becomes `12.50%`.
 */
const COL_EFFECTIVE_TAX_RATE: CSVColumn = {
  key: "effectiveTaxRate",
  label: "Effective Tax Rate",
  group: "totals",
  resolve: ({ invoice }) =>
    invoice != null ? `${(invoice.effectiveTaxRate * 100).toFixed(2)}%` : "",
};

/**
 * Exports the invoice's already-formatted total representation.
 *
 * Falls back to the public summary when the full invoice is unavailable.
 */
const COL_FORMATTED_TOTAL: CSVColumn = {
  key: "formattedTotal",
  label: "Formatted Total",
  group: "totals",
  resolve: ({ invoice, public: pub }) =>
    invoice?.formattedTotal ?? pub?.formattedTotal ?? "",
};

// ── Payment ───────────────────────────────────────────────────────────────

/**
 * Exports the cumulative amount already paid against the invoice.
 */
const COL_TOTAL_PAID: CSVColumn = {
  key: "totalPaid",
  label: "Total Paid",
  group: "payment",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.totalPaid.toMajor().toFixed(2)) : "",
};

/**
 * Exports the remaining amount currently due.
 */
const COL_AMOUNT_DUE: CSVColumn = {
  key: "amountDue",
  label: "Amount Due",
  group: "payment",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.amountDue.toMajor().toFixed(2)) : "",
};

/**
 * Exports whether the invoice is fully paid.
 */
const COL_IS_FULLY_PAID: CSVColumn = {
  key: "isFullyPaid",
  label: "Fully Paid",
  group: "payment",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.isFullyPaid) : "",
};

/**
 * Exports the number of recorded proof-of-payment entries.
 */
const COL_PAYMENT_COUNT: CSVColumn = {
  key: "paymentCount",
  label: "Payment Count",
  group: "payment",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.proofOfPayments.length) : "",
};

// ── Line Items (summary — not per-row expansion) ──────────────────────────

/**
 * Exports the number of line items on the invoice.
 *
 * Line items remain summarized into a single invoice row rather than being
 * expanded into separate CSV records.
 */
const COL_LINE_ITEM_COUNT: CSVColumn = {
  key: "lineItemCount",
  label: "Line Item Count",
  group: "line_items",
  resolve: ({ invoice }) =>
    invoice != null ? String(invoice.lineItemCount) : "",
};

/**
 * Exports all line-item descriptions into a single cell.
 *
 * Individual descriptions are separated by ` | `.
 */
const COL_LINE_ITEM_DESCRIPTIONS: CSVColumn = {
  key: "lineItemDescriptions",
  label: "Line Item Descriptions",
  group: "line_items",
  resolve: ({ invoice }) =>
    invoice != null
      ? invoice.lineItems.map((li) => li.description).join(" | ")
      : "",
};

/**
 * Exports all line-item quantities into a single cell.
 *
 * Individual quantities are separated by ` | ` and remain aligned with the
 * order of the invoice's line items.
 */
const COL_LINE_ITEM_QUANTITIES: CSVColumn = {
  key: "lineItemQuantities",
  label: "Line Item Quantities",
  group: "line_items",
  resolve: ({ invoice }) =>
    invoice != null
      ? invoice.lineItems.map((li) => String(li.quantity)).join(" | ")
      : "",
};

/**
 * Exports all line-item unit prices into a single cell.
 *
 * Monetary values are rendered to two decimal places and separated by
 * ` | `.
 */
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

/**
 * Exports all line-item net totals into a single cell.
 *
 * Values are rendered to two decimal places and separated by ` | `.
 */
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

/**
 * Exports the invoice's associated cost centers as a single cell.
 *
 * Multiple cost centers are separated by ` | `.
 */
const COL_COST_CENTERS: CSVColumn = {
  key: "costCenters",
  label: "Cost Centers",
  group: "accounting",
  resolve: ({ invoice }) => invoice?.costCenters.join(" | ") ?? "",
};

/**
 * Exports the invoice's account codes as a single cell.
 *
 * Multiple account codes are separated by ` | `.
 */
const COL_ACCOUNT_CODES: CSVColumn = {
  key: "accountCodes",
  label: "Account Codes",
  group: "accounting",
  resolve: ({ invoice }) => invoice?.accountCodes.join(" | ") ?? "",
};

/**
 * Exports the tax types associated with the invoice as a single cell.
 *
 * Multiple tax types are separated by ` | `.
 */
const COL_TAX_TYPES: CSVColumn = {
  key: "taxTypes",
  label: "Tax Types",
  group: "accounting",
  resolve: ({ invoice }) => invoice?.taxTypes.join(" | ") ?? "",
};

// ── Meta ──────────────────────────────────────────────────────────────────

/**
 * Exports the invoice's free-form notes.
 */
const COL_NOTES: CSVColumn = {
  key: "notes",
  label: "Notes",
  group: "meta",
  resolve: ({ invoice }) => invoice?.notes ?? "",
};

/**
 * Exports the invoice's tags as a comma-separated list within a single CSV
 * field.
 */
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
 * Complete catalog of every available static CSV column.
 *
 * This collection contains all built-in, non-dynamic column definitions and
 * is intended primarily for column-selection UIs such as a checkbox grid.
 *
 * Dynamic per-tax-type columns are not included here because their keys and
 * labels depend on the tax types present in the invoice population. Generate
 * those separately with `buildTaxBreakdownColumns()`.
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
 * Curated default set of CSV columns used by standard exports.
 *
 * This is the column set used by `toCSV()` and
 * `batchExportToCSV()` when the caller does not provide an explicit
 * selection.
 *
 * The default intentionally focuses on the most broadly useful invoice
 * identity, party, date, monetary, and payment fields without including every
 * available metadata or accounting field.
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
 * Build additive-tax and withholding columns for a set of tax types.
 *
 * Each supplied tax type produces two CSV columns:
 *
 * - `<TAX_TYPE> Amount` — additive tax total for that tax type.
 * - `<TAX_TYPE> Withholding` — withholding total for that tax type.
 *
 * Tax types are normalized to uppercase for both generated keys and labels.
 *
 * This builder is useful when the tax types present across an invoice
 * population are known ahead of export, such as `["VAT", "EWT"]`.
 *
 * The generated columns complement `ALL_CSV_COLUMNS`; they are not included
 * in the static catalog because their exact set is population-dependent.
 *
 * @param taxTypes Tax type identifiers for which dynamic columns should be
 * generated.
 * @returns A new array containing two columns for each supplied tax type.
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

/**
 * Build the CSV header row for a given column set.
 *
 * Each column's human-readable `label` becomes one CSV header cell, escaped
 * using the module's standard CSV escaping rules.
 *
 * @param columns Columns to include in the header, in output order.
 * @returns A single CSV header row.
 */
export function buildCSVHeader(columns: CSVColumn[]): string {
  return columns.map((c) => esc(c.label)).join(",");
}

/**
 * Build one CSV data row from a resolver context and column list.
 *
 * Each column resolver is executed independently. A resolver that throws
 * does not abort the entire row; the affected cell is replaced with an empty
 * string and the error is logged for debugging.
 *
 * @param ctx Data available to column resolvers.
 * @param columns Columns to resolve, in output order.
 * @returns A single CSV data row.
 */
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

/**
 * Remove duplicate columns while preserving their first occurrence.
 *
 * Deduplication is based on the column's machine `key`. When multiple column
 * descriptors share the same key, only the first one is retained.
 *
 * @param columns Column descriptors to deduplicate.
 * @returns A new array containing only the first occurrence of each column
 * key.
 */
export function dedupeColumns(columns: CSVColumn[]): CSVColumn[] {
  const seen = new Set<string>();

  return columns.filter((c) => {
    if (seen.has(c.key)) return false;

    seen.add(c.key);
    return true;
  });
}

/**
 * Normalize a date-like value into `YYYY-MM-DD`.
 *
 * Supports:
 *
 * - `Date` instances;
 * - date strings;
 * - numeric date values accepted by the JavaScript `Date` constructor.
 *
 * Invalid or unsupported values return an empty string.
 *
 * The resulting date uses the ISO representation and is truncated to the
 * calendar-date portion, keeping CSV output stable and Excel-friendly.
 *
 * @param value Date-like value to normalize.
 * @returns A normalized `YYYY-MM-DD` string, or `""` when the value cannot
 * be interpreted as a valid date.
 */
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
