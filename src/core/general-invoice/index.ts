/**
 * @majikah/majik-invoice
 *
 * Public API surface for the GeneralInvoice domain.
 * MajikInvoice (crypto layer) will be exported from a separate entry point.
 */

// Types & interfaces
export type * from "./types";
export * from "./errors";
export * from "./constants";

// Classes
export { LineItem, LineItemValidationError } from "./line-item";
export { InvoiceTotals } from "./invoice-totals";
export {
  GeneralInvoice,
} from "./general-invoice";
