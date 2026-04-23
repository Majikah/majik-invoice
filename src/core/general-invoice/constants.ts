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
