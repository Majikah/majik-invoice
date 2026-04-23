// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

import { InvoiceStatus } from "./types";

export class InvoiceValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly details?: string[],
  ) {
    super(message);
    this.name = "InvoiceValidationError";
  }
}

export class InvoiceProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceProjectionError";
  }
}

export class InvoiceLifecycleError extends Error {
  constructor(
    message: string,
    public readonly from: InvoiceStatus,
    public readonly to: InvoiceStatus,
  ) {
    super(message);
    this.name = "InvoiceLifecycleError";
  }
}

export class InvoiceMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceMutationError";
  }
}
