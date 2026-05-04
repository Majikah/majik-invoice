/**
 * @file line-item.ts
 */

import {
  MajikMoney,
  serializeMoney,
  deserializeMoney,
} from "@thezelijah/majik-money";
import type { LineItemInput, LineItemJSON, TaxDetail, Discount } from "./types";
import { TaxManager } from "./tax-manager";
import { resolveTaxes } from "./utils";

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

export class LineItem {
  // ── Identity ──────────────────────────────────────────────────────────────
  readonly id: string;
  readonly skuId?: string;
  readonly description: string;
  readonly quantity: number;
  readonly unit?: string;

  // ── Money ─────────────────────────────────────────────────────────────────
  readonly unitPrice: MajikMoney;
  readonly taxes: TaxManager;
  readonly discount?: Discount;

  // ── Computed — additive taxes (VAT, GST, excise) ──────────────────────────
  readonly lineTotal: MajikMoney;
  readonly discountAmount: MajikMoney;
  /**
   * Sum of all ADDITIVE tax amounts only.
   * This is what increases (or is extracted from) the grand total.
   */
  readonly additiveTaxAmount: MajikMoney;
  /**
   * Sum of all WITHHOLDING tax amounts.
   * Does NOT affect grandTotal — tracked separately for netPayable.
   */
  readonly withholdingTaxAmount: MajikMoney;
  /**
   * Alias kept for backward compatibility — equals additiveTaxAmount.
   * Callers relying on taxAmount will continue to work correctly.
   */
  readonly taxAmount: MajikMoney;
  /**
   * postDiscount + additiveTaxAmount  (exclusive)
   * postDiscount                      (fully inclusive)
   * The invoice grand total is Σ netTotal.
   */
  readonly netTotal: MajikMoney;
  /**
   * netTotal − withholdingTaxAmount
   * The actual cash the buyer remits after withholding.
   */
  readonly netPayable: MajikMoney;

  /** Per-taxType additive amount, keyed by taxType string */
  readonly additiveTaxBreakdown: ReadonlyMap<string, MajikMoney>;
  /** Per-taxType withholding amount, keyed by taxType string */
  readonly withholdingTaxBreakdown: ReadonlyMap<string, MajikMoney>;

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
    defaultTaxes?: TaxManager,
  ) {
    this.id = input.id ?? crypto.randomUUID();
    this.skuId = input?.skuId;
    this.description = input.description.trim();
    this.quantity = input.quantity;
    this.unit = input.unit;
    this.unitPrice = unitPriceMoney;
    const own = resolveTaxes(input);
    this.taxes = TaxManager.resolve(own, defaultTaxes ?? TaxManager.none());
    this.discount = input.discount;
    this.accountCode = input.accountCode;
    this.costCenter = input.costCenter;
    this.tags = input.tags;
    this.metadata = input.metadata;

    // ── Step 1: lineTotal ──────────────────────────────────────────────────
    this.lineTotal = unitPriceMoney.multiply(input.quantity);

    // ── Step 2: discountAmount ─────────────────────────────────────────────
    if (input.discount) {
      this.discountAmount =
        input.discount.type === "percentage"
          ? this.lineTotal.applyPercentage(input.discount.value)
          : MajikMoney.fromMajor(input.discount.value, currencyCode);
    } else {
      this.discountAmount = MajikMoney.zero(currencyCode);
    }

    if (this.discountAmount.greaterThan(this.lineTotal)) {
      throw new LineItemValidationError(
        "Discount cannot exceed line total",
        "discount.value",
      );
    }

    // ── Step 3: postDiscount ───────────────────────────────────────────────
    // This contains the base price minus discounts.
    // IMPORTANT: If inclusive taxes exist, this value STILL CONTAINS them.
    const postDiscount = this.lineTotal.subtract(this.discountAmount);

    // ── Step 4: additive taxes (VAT / GST / excise) ────────────────────────
    let inclusiveTaxTotal = MajikMoney.zero(currencyCode);
    let exclusiveTaxTotal = MajikMoney.zero(currencyCode);

    const additiveTaxes = this.taxes.additive;
    const additiveMap = new Map<string, MajikMoney>();

    for (const tax of additiveTaxes) {
      if (tax.inclusive) {
        // Extract embedded tax from the postDiscount amount
        const amount = postDiscount.subtract(postDiscount.divide(1 + tax.rate));
        inclusiveTaxTotal = inclusiveTaxTotal.add(amount);
        additiveMap.set(tax.taxType, amount);
      } else {
        // Add tax on top of the postDiscount amount
        const amount = postDiscount.applyPercentage(tax.rate);
        exclusiveTaxTotal = exclusiveTaxTotal.add(amount);
        additiveMap.set(tax.taxType, amount);
      }
    }

    this.additiveTaxBreakdown = additiveMap;
    this.additiveTaxAmount = inclusiveTaxTotal.add(exclusiveTaxTotal);
    this.taxAmount = this.additiveTaxAmount; // backward-compat alias

    // ── Step 5: netTotal (grand total contribution) ────────────────────────
    // Since inclusive taxes are ALREADY embedded inside `postDiscount`,
    // we only add the `exclusiveTaxTotal` on top to prevent double-counting.
    this.netTotal = postDiscount.add(exclusiveTaxTotal);

    // ── Step 6: withholding taxes (EWT / WHT) ─────────────────────────────
    // Base = pre-VAT income payment per BIR RR 2-98.
    // We MUST strip out the inclusive VAT from postDiscount before applying EWT.
    // Does NOT change netTotal or grandTotal.
    const withholdingTaxes = this.taxes.withholding;
    const withholdingBase = postDiscount.subtract(inclusiveTaxTotal);

    let withholdingTotal = MajikMoney.zero(currencyCode);
    const withholdingMap = new Map<string, MajikMoney>();

    for (const tax of withholdingTaxes) {
      const amount = withholdingBase.applyPercentage(tax.rate);
      withholdingTotal = withholdingTotal.add(amount);
      withholdingMap.set(tax.taxType, amount);
    }

    this.withholdingTaxBreakdown = withholdingMap;
    this.withholdingTaxAmount = withholdingTotal;

    // ── Step 7: netPayable (what buyer actually remits) ───────────────────
    this.netPayable = this.netTotal.subtract(withholdingTotal);
  }
  // ── Factory ───────────────────────────────────────────────────────────────

  static create(
    input: LineItemInput,
    currencyCode: string,
    defaultTaxes?: TaxManager,
  ): LineItem {
    LineItem.validate(input);
    const unitPriceMoney = MajikMoney.fromMajor(input.unitPrice, currencyCode);

    return new LineItem(input, unitPriceMoney, currencyCode, defaultTaxes);
  }

  // ── Validation ────────────────────────────────────────────────────────────

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

    resolveTaxes(input);

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
          "Percentage discount must be between 0 and 1",
          "discount.value",
        );
      }
    }
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get lineTotalAmount(): number {
    return this.lineTotal.toMajor();
  }
  get taxAmountValue(): number {
    return this.additiveTaxAmount.toMajor();
  }
  get additiveTaxAmountValue(): number {
    return this.additiveTaxAmount.toMajor();
  }
  get withholdingTaxAmountValue(): number {
    return this.withholdingTaxAmount.toMajor();
  }
  get discountAmountValue(): number {
    return this.discountAmount.toMajor();
  }
  get netTotalAmount(): number {
    return this.netTotal.toMajor();
  }
  get netPayableAmount(): number {
    return this.netPayable.toMajor();
  }

  get nominalTaxRate(): number {
    const additive = this.taxes.additive;
    return additive.reduce((s, t) => s + t.rate, 0);
  }

  get effectiveTaxRate(): number {
    const postDiscount = this.lineTotal.subtract(this.discountAmount);
    return this.additiveTaxAmount.ratio(postDiscount);
  }

  get isTaxable(): boolean {
    return this.taxes
      .toArray()
      .some((t) => (t.behaviour ?? "additive") === "additive" && t.rate > 0);
  }

  get hasDiscount(): boolean {
    return !!this.discount;
  }

  taxAmountByType(taxType: string): number {
    return this.additiveTaxBreakdown.get(taxType)?.toMajor() ?? 0;
  }

  withholdingAmountByType(taxType: string): number {
    return this.withholdingTaxBreakdown.get(taxType)?.toMajor() ?? 0;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON(): LineItemJSON {
    return {
      id: this.id,
      skuId: this.skuId,
      description: this.description,
      quantity: this.quantity,
      unitPrice: serializeMoney(this.unitPrice),
      unit: this.unit,
      taxes: this.taxes.toArray(),
      discount: this.discount,
      lineTotal: serializeMoney(this.lineTotal),
      additiveTaxAmount: serializeMoney(this.additiveTaxAmount),
      withholdingTaxAmount: serializeMoney(this.withholdingTaxAmount),
      taxAmount: serializeMoney(this.additiveTaxAmount), // back-compat
      discountAmount: serializeMoney(this.discountAmount),
      netTotal: serializeMoney(this.netTotal),
      netPayable: serializeMoney(this.netPayable),
      accountCode: this.accountCode,
      costCenter: this.costCenter,
      tags: this.tags,
      metadata: this.metadata,
    };
  }

  static fromJSON(json: LineItemJSON, currencyCode: string): LineItem {
    const unitPriceMoney = deserializeMoney(json.unitPrice) as MajikMoney;
    const input: LineItemInput = {
      id: json.id,
      skuId: json.skuId,
      description: json.description,
      quantity: json.quantity,
      unitPrice: unitPriceMoney.toMajor(),
      unit: json.unit,
      taxes: json.taxes,
      discount: json.discount,
      accountCode: json.accountCode,
      costCenter: json.costCenter,
      tags: json.tags,
      metadata: json.metadata,
    };
    return new LineItem(input, unitPriceMoney, currencyCode);
  }
}
