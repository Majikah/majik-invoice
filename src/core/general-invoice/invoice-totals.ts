/**
 * @file invoice-totals.ts
 * @description Computed InvoiceTotals — derived from LineItem[]
 * using MajikMoney for all arithmetic. Immutable.
 */

import {
  MajikMoney,
  serializeMoney,
  deserializeMoney,
} from "@thezelijah/majik-money";
import type { InvoiceTotalsJSON, CurrencyCode } from "./types";
import type { LineItem } from "./line-item";

/**
 * Immutable invoice totals derived from line items.
 * Never constructed directly — use InvoiceTotals.fromLineItems().
 */
export class InvoiceTotals {
  /** Sum of all lineTotals (before discount, before tax) */
  readonly subtotal: MajikMoney;

  /** Sum of all discountAmounts across line items */
  readonly discountTotal: MajikMoney;

  /** Sum of all taxAmounts across line items */
  readonly taxTotal: MajikMoney;

  /**
   * Grand total = subtotal − discountTotal + taxTotal (exclusive)
   *             = subtotal − discountTotal (inclusive — tax already embedded)
   * In practice this equals sum of all netTotals.
   */
  readonly grandTotal: MajikMoney;

  private constructor(
    subtotal: MajikMoney,
    discountTotal: MajikMoney,
    taxTotal: MajikMoney,
    grandTotal: MajikMoney,
  ) {
    this.subtotal = subtotal;
    this.discountTotal = discountTotal;
    this.taxTotal = taxTotal;
    this.grandTotal = grandTotal;
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Compute totals from an array of LineItem instances.
   * @param lineItems - Computed line items
   * @param currencyCode - Invoice currency
   */
  static fromLineItems(
    lineItems: LineItem[],
    currencyCode: CurrencyCode,
  ): InvoiceTotals {
    if (lineItems.length === 0) {
      const zero = MajikMoney.zero(currencyCode);
      return new InvoiceTotals(zero, zero, zero, zero);
    }

    const subtotal = MajikMoney.sum(lineItems.map((li) => li.lineTotal));
    const discountTotal = MajikMoney.sum(
      lineItems.map((li) => li.discountAmount),
    );
    const taxTotal = MajikMoney.sum(lineItems.map((li) => li.taxAmount));
    const grandTotal = MajikMoney.sum(lineItems.map((li) => li.netTotal));

    return new InvoiceTotals(subtotal, discountTotal, taxTotal, grandTotal);
  }

  // ── Getters — convenience ─────────────────────────────────────────────────

  /** subtotal in major units */
  get subtotalAmount(): number {
    return this.subtotal.toMajor();
  }

  /** discountTotal in major units */
  get discountTotalAmount(): number {
    return this.discountTotal.toMajor();
  }

  /** taxTotal in major units */
  get taxTotalAmount(): number {
    return this.taxTotal.toMajor();
  }

  /** grandTotal in major units */
  get grandTotalAmount(): number {
    return this.grandTotal.toMajor();
  }

  /** Effective overall discount rate (0–1). 0 if subtotal is zero. */
  get effectiveDiscountRate(): number {
    if (this.subtotal.isZero()) return 0;
    return this.discountTotal.ratio(this.subtotal);
  }

  /** Effective overall tax rate relative to grand total. 0 if grand total is zero. */
  get effectiveTaxRate(): number {
    if (this.grandTotal.isZero()) return 0;
    return this.taxTotal.ratio(this.grandTotal);
  }

  /** Whether any discount is applied across the invoice */
  get hasDiscount(): boolean {
    return this.discountTotal.isPositive();
  }

  /** Whether any tax is applied across the invoice */
  get hasTax(): boolean {
    return this.taxTotal.isPositive();
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON(): InvoiceTotalsJSON {
    return {
      subtotal: serializeMoney(this.subtotal),
      discountTotal: serializeMoney(this.discountTotal),
      taxTotal: serializeMoney(this.taxTotal),
      grandTotal: serializeMoney(this.grandTotal),
    };
  }

  static fromJSON(json: InvoiceTotalsJSON): InvoiceTotals {
    return new InvoiceTotals(
      deserializeMoney(json.subtotal) as MajikMoney,
      deserializeMoney(json.discountTotal) as MajikMoney,
      deserializeMoney(json.taxTotal) as MajikMoney,
      deserializeMoney(json.grandTotal) as MajikMoney,
    );
  }
}
