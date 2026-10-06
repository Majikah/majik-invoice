/**
 * @majikah/majik-invoice
 *
 * Public API surface for the GeneralInvoice domain.
 * MajikInvoice (crypto layer) will be exported from a separate entry point.
 */

// Types & interfaces
export type * from "./types.js";
export * from "./errors.js";
export * from "./constants.js";

export * from "./tax-manager.js";
export * from "./utils.js";

// Classes
export * from "./line-item.js";
export * from "./invoice-totals.js";
export * from "./general-invoice.js";

