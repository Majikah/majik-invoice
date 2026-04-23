// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MajikInvoiceError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MajikInvoiceError";
  }
}

export class MajikInvoiceKeyError extends MajikInvoiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "MajikInvoiceKeyError";
  }
}

export class MajikInvoiceEncryptionError extends MajikInvoiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "MajikInvoiceEncryptionError";
  }
}

export class MajikInvoiceSignatureError extends MajikInvoiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "MajikInvoiceSignatureError";
  }
}

export class MajikInvoiceSealError extends MajikInvoiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "MajikInvoiceSealError";
  }
}

export class MajikInvoiceSerializationError extends MajikInvoiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "MajikInvoiceSerializationError";
  }
}
