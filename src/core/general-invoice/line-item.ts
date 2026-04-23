/**
 * @file line-item.ts
 * @description Computed LineItem class — wraps LineItemInput and derives
 * lineTotal, taxAmount, discountAmount, and netTotal using MajikMoney.
 */

import {
  MajikMoney,
  serializeMoney,
  deserializeMoney,
} from "@thezelijah/majik-money";
import type { LineItemInput, LineItemJSON, TaxDetail, Discount } from "./types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LineItemValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = "LineItemValidationError";
  }
}

// ---------------------------------------------------------------------------
// LineItem
// ---------------------------------------------------------------------------

/**
 * Computed, immutable line item.
 *
 * All money values are MajikMoney instances — never raw numbers.
 * Computed fields (lineTotal, taxAmount, discountAmount, netTotal)
 * are derived on construction and cached.
 *
 * Construct via LineItem.create() — constructor is private.
 */
export class LineItem {
  // ── Identity ──────────────────────────────────────────────────────────────
  readonly id: string;
  readonly description: string;
  readonly quantity: number;
  readonly unit?: string;

  // ── Money ─────────────────────────────────────────────────────────────────
  readonly unitPrice: MajikMoney;
  readonly tax?: TaxDetail;
  readonly discount?: Discount;

  // ── Computed ──────────────────────────────────────────────────────────────
  /** quantity × unitPrice (before discount, before tax) */
  readonly lineTotal: MajikMoney;
  /** Tax amount derived from lineTotal (or post-discount total) */
  readonly taxAmount: MajikMoney;
  /** Discount amount in money */
  readonly discountAmount: MajikMoney;
  /** lineTotal − discountAmount + taxAmount (if tax is exclusive) */
  readonly netTotal: MajikMoney;

  // ── Accounting ────────────────────────────────────────────────────────────
  readonly accountCode?: string;
  readonly costCenter?: string;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;

  // ── Private constructor ───────────────────────────────────────────────────

  private constructor(
    input: LineItemInput,
    unitPriceMoney: MajikMoney,
    currencyCode: string,
  ) {
    this.id = input.id ?? crypto.randomUUID();
    this.description = input.description.trim();
    this.quantity = input.quantity;
    this.unit = input.unit;
    this.unitPrice = unitPriceMoney;
    this.tax = input.tax;
    this.discount = input.discount;
    this.accountCode = input.accountCode;
    this.costCenter = input.costCenter;
    this.tags = input.tags;
    this.metadata = input.metadata;

    // ── Compute lineTotal ──────────────────────────────────────────────────
    this.lineTotal = unitPriceMoney.multiply(input.quantity);

    // ── Compute discountAmount ─────────────────────────────────────────────
    if (input.discount) {
      if (input.discount.type === "percentage") {
        this.discountAmount = this.lineTotal.applyPercentage(
          input.discount.value,
        );
      } else {
        this.discountAmount = MajikMoney.fromMajor(
          input.discount.value,
          currencyCode,
        );
      }
    } else {
      this.discountAmount = MajikMoney.zero(currencyCode);
    }

    // ── Post-discount base ─────────────────────────────────────────────────
    const postDiscount = this.lineTotal.subtract(this.discountAmount);

    // ── Compute taxAmount ──────────────────────────────────────────────────
    if (input.tax) {
      if (input.tax.inclusive) {
        // Tax is already embedded in price — extract it
        // taxAmount = postDiscount - (postDiscount / (1 + rate))
        const excl = postDiscount.divide(1 + input.tax.rate);
        this.taxAmount = postDiscount.subtract(excl);
      } else {
        // Tax is exclusive — add on top
        this.taxAmount = postDiscount.applyPercentage(input.tax.rate);
      }
    } else {
      this.taxAmount = MajikMoney.zero(currencyCode);
    }

    // ── Compute netTotal ───────────────────────────────────────────────────
    if (input.tax?.inclusive) {
      // Tax already in price — netTotal = postDiscount (tax is embedded)
      this.netTotal = postDiscount;
    } else {
      // Tax is exclusive — add it
      this.netTotal = postDiscount.add(this.taxAmount);
    }
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Create a validated, computed LineItem.
   *
   * @param input - Raw line item input
   * @param currencyCode - ISO 4217 currency code (from parent invoice)
   * @throws {LineItemValidationError} on invalid input
   */
  static create(input: LineItemInput, currencyCode: string): LineItem {
    LineItem.validate(input);

    const unitPriceMoney = MajikMoney.fromMajor(input.unitPrice, currencyCode);
    return new LineItem(input, unitPriceMoney, currencyCode);
  }

  // ── Validation ────────────────────────────────────────────────────────────

  /**
   * Validate raw line item input.
   * @throws {LineItemValidationError}
   */
  static validate(input: LineItemInput): void {
    if (!input.description || input.description.trim().length === 0) {
      throw new LineItemValidationError(
        "Line item description is required",
        "description",
      );
    }

    if (typeof input.quantity !== "number" || !isFinite(input.quantity)) {
      throw new LineItemValidationError(
        "Line item quantity must be a finite number",
        "quantity",
      );
    }

    if (input.quantity <= 0) {
      throw new LineItemValidationError(
        "Line item quantity must be greater than zero",
        "quantity",
      );
    }

    if (typeof input.unitPrice !== "number" || !isFinite(input.unitPrice)) {
      throw new LineItemValidationError(
        "Line item unitPrice must be a finite number",
        "unitPrice",
      );
    }

    if (input.unitPrice < 0) {
      throw new LineItemValidationError(
        "Line item unitPrice cannot be negative",
        "unitPrice",
      );
    }

    if (input.tax) {
      if (typeof input.tax.rate !== "number" || !isFinite(input.tax.rate)) {
        throw new LineItemValidationError(
          "Tax rate must be a finite number",
          "tax.rate",
        );
      }
      if (input.tax.rate < 0 || input.tax.rate > 1) {
        throw new LineItemValidationError(
          "Tax rate must be between 0 and 1 (e.g. 0.12 for 12%)",
          "tax.rate",
        );
      }
      if (!input.tax.taxType || input.tax.taxType.trim().length === 0) {
        throw new LineItemValidationError(
          "Tax type is required when tax is specified",
          "tax.taxType",
        );
      }
    }

    if (input.discount) {
      if (
        typeof input.discount.value !== "number" ||
        !isFinite(input.discount.value)
      ) {
        throw new LineItemValidationError(
          "Discount value must be a finite number",
          "discount.value",
        );
      }
      if (input.discount.value < 0) {
        throw new LineItemValidationError(
          "Discount value cannot be negative",
          "discount.value",
        );
      }
      if (input.discount.type === "percentage" && input.discount.value > 1) {
        throw new LineItemValidationError(
          "Percentage discount must be between 0 and 1 (e.g. 0.10 for 10%)",
          "discount.value",
        );
      }
    }
  }

  // ── Getters — convenience accessors ──────────────────────────────────────

  /** lineTotal in major units (number) */
  get lineTotalAmount(): number {
    return this.lineTotal.toMajor();
  }

  /** taxAmount in major units (number) */
  get taxAmountValue(): number {
    return this.taxAmount.toMajor();
  }

  /** discountAmount in major units (number) */
  get discountAmountValue(): number {
    return this.discountAmount.toMajor();
  }

  /** netTotal in major units (number) */
  get netTotalAmount(): number {
    return this.netTotal.toMajor();
  }

  /** Effective tax rate (0–1) — 0 if no tax */
  get effectiveTaxRate(): number {
    return this.tax?.rate ?? 0;
  }

  /** Whether this line has any tax applied */
  get isTaxable(): boolean {
    return !!this.tax && this.tax.rate > 0;
  }

  /** Whether this line has a discount */
  get hasDiscount(): boolean {
    return !!this.discount;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /**
   * Serialize to plain JSON.
   * All MajikMoney instances are serialized via serializeMoney().
   */
  toJSON(): LineItemJSON {
    return {
      id: this.id,
      description: this.description,
      quantity: this.quantity,
      unitPrice: serializeMoney(this.unitPrice),
      unit: this.unit,
      tax: this.tax,
      discount: this.discount,
      lineTotal: serializeMoney(this.lineTotal),
      taxAmount: serializeMoney(this.taxAmount),
      discountAmount: serializeMoney(this.discountAmount),
      netTotal: serializeMoney(this.netTotal),
      accountCode: this.accountCode,
      costCenter: this.costCenter,
      tags: this.tags,
      metadata: this.metadata,
    };
  }

  /**
   * Rehydrate a LineItem from its JSON representation.
   * All MajikMoneyJSON fields are deserialized back to MajikMoney instances.
   *
   * @param json - Serialized LineItemJSON
   * @param currencyCode - Currency code (from parent invoice)
   */
  static fromJSON(json: LineItemJSON, currencyCode: string): LineItem {
    const unitPriceMoney = deserializeMoney(json.unitPrice) as MajikMoney;

    const input: LineItemInput = {
      id: json.id,
      description: json.description,
      quantity: json.quantity,
      unitPrice: unitPriceMoney.toMajor(),
      unit: json.unit,
      tax: json.tax,
      discount: json.discount,
      accountCode: json.accountCode,
      costCenter: json.costCenter,
      tags: json.tags,
      metadata: json.metadata,
    };

    return new LineItem(input, unitPriceMoney, currencyCode);
  }
}
