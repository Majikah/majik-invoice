/**
 * @file invoice-totals.ts
 */

import {
  MajikMoney,
  serializeMoney,
  deserializeMoney,
} from "@thezelijah/majik-money";
import type { InvoiceTotalsJSON, CurrencyCode } from "./types";
import type { LineItem } from "./line-item";

/**
 * Immutable aggregate of the monetary totals for an invoice.
 *
 * `InvoiceTotals` is calculated from a collection of {@link LineItem} instances
 * and represents the invoice-level financial summary.
 *
 * ### Calculation flow
 *
 * The totals are derived from the individual line items as follows:
 *
 * `subtotal`
 * → sum of all line totals before discounts and taxes
 *
 * `discountTotal`
 * → sum of all line-item discounts
 *
 * `taxTotal`
 * → sum of all additive taxes
 *
 * `withholdingTotal`
 * → sum of all withholding taxes
 *
 * `grandTotal`
 * → sum of each line item's `netTotal`
 *
 * `netPayable`
 * → sum of each line item's `netPayable`
 *
 * ### Important tax distinction
 *
 * Additive taxes contribute to `grandTotal`.
 *
 * Withholding taxes are tracked separately and do not increase `grandTotal`.
 * Instead, they reduce the amount actually remitted by the buyer, which is
 * represented by `netPayable`.
 *
 * ### Monetary precision
 *
 * All monetary values are stored as {@link MajikMoney}. Numeric getter
 * properties are convenience projections into major currency units.
 *
 * ### Immutability
 *
 * Instances are fully initialized when created and expose their calculated
 * values as `readonly` properties. Use {@link InvoiceTotals.fromLineItems}
 * or {@link InvoiceTotals.fromJSON} to construct instances.
 *
 * @example
 * ```ts
 * const totals = InvoiceTotals.fromLineItems(lineItems, "PHP");
 *
 * console.log(totals.subtotalAmount);
 * console.log(totals.discountTotalAmount);
 * console.log(totals.taxTotalAmount);
 * console.log(totals.grandTotalAmount);
 * console.log(totals.netPayableAmount);
 * ```
 */
export class InvoiceTotals {
  /**
   * Sum of all line-item totals before discounts and taxes.
   *
   * Equivalent to the sum of each line item's `lineTotal`.
   */
  readonly subtotal: MajikMoney;

  /**
   * Sum of all discounts applied across the invoice line items.
   *
   * This amount is subtracted from `subtotal` to determine the
   * post-discount invoice base.
   */
  readonly discountTotal: MajikMoney;

  /**
   * Sum of all additive tax amounts across the invoice.
   *
   * This includes additive taxes such as VAT, GST, or excise taxes and
   * represents the tax amount that contributes to the invoice's declared
   * `grandTotal`.
   *
   * Withholding taxes are intentionally excluded.
   */
  readonly taxTotal: MajikMoney;

  /**
   * Sum of all withholding tax amounts across the invoice.
   *
   * Withholding is tracked separately because it does not increase the
   * invoice's `grandTotal`. Instead, it reduces the amount actually remitted
   * by the buyer.
   */
  readonly withholdingTotal: MajikMoney;

  /**
   * Total amount declared by the invoice after discounts and additive taxes.
   *
   * Conceptually:
   *
   * `subtotal − discountTotal + taxTotal`
   *
   * This is the invoice total before withholding deductions.
   */
  readonly grandTotal: MajikMoney;

  /**
   * Amount the buyer actually remits after withholding taxes are deducted.
   *
   * Conceptually:
   *
   * `grandTotal − withholdingTotal`
   *
   * This represents the cash payable to the seller after withholding
   * obligations are accounted for.
   */
  readonly netPayable: MajikMoney;

  /**
   * Construct an invoice-total aggregate from already calculated monetary
   * values.
   *
   * This constructor is intentionally private. Use
   * {@link InvoiceTotals.fromLineItems} when calculating totals from invoice
   * line items or {@link InvoiceTotals.fromJSON} when restoring persisted data.
   *
   * @param subtotal - Gross sum of all line-item totals.
   * @param discountTotal - Sum of all line-item discounts.
   * @param taxTotal - Sum of all additive tax amounts.
   * @param withholdingTotal - Sum of all withholding tax amounts.
   * @param grandTotal - Invoice-declared total after discounts and additive taxes.
   * @param netPayable - Amount payable after withholding deductions.
   */
  private constructor(
    subtotal: MajikMoney,
    discountTotal: MajikMoney,
    taxTotal: MajikMoney,
    withholdingTotal: MajikMoney,
    grandTotal: MajikMoney,
    netPayable: MajikMoney,
  ) {
    this.subtotal = subtotal;
    this.discountTotal = discountTotal;
    this.taxTotal = taxTotal;
    this.withholdingTotal = withholdingTotal;
    this.grandTotal = grandTotal;
    this.netPayable = netPayable;

    Object.freeze(this);
  }

  /**
   * Calculate invoice totals from a collection of line items.
   *
   * Each aggregate value is derived directly from the corresponding monetary
   * values on the supplied {@link LineItem} instances.
   *
   * When no line items are supplied, every total is initialized to zero in the
   * requested currency.
   *
   * @param lineItems - Line items whose calculated values should be aggregated.
   * @param currencyCode - Currency used for the zero-valued empty-invoice case.
   * @returns A fully calculated `InvoiceTotals` instance.
   *
   * @example
   * ```ts
   * const totals = InvoiceTotals.fromLineItems(
   *   invoice.lineItems,
   *   "PHP",
   * );
   * ```
   */
  static fromLineItems(
    lineItems: LineItem[],
    currencyCode: CurrencyCode,
  ): InvoiceTotals {
    const zero = MajikMoney.zero(currencyCode);
    if (lineItems.length === 0) {
      return new InvoiceTotals(zero, zero, zero, zero, zero, zero);
    }

    const subtotal = MajikMoney.sum(lineItems.map((li) => li.lineTotal));
    const discountTotal = MajikMoney.sum(
      lineItems.map((li) => li.discountAmount),
    );
    const taxTotal = MajikMoney.sum(
      lineItems.map((li) => li.additiveTaxAmount),
    );
    const withholdingTotal = MajikMoney.sum(
      lineItems.map((li) => li.withholdingTaxAmount),
    );
    const grandTotal = MajikMoney.sum(lineItems.map((li) => li.netTotal));
    const netPayable = MajikMoney.sum(lineItems.map((li) => li.netPayable));

    return new InvoiceTotals(
      subtotal,
      discountTotal,
      taxTotal,
      withholdingTotal,
      grandTotal,
      netPayable,
    );
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  /**
   * Get the invoice subtotal as a JavaScript number.
   *
   * This is the numeric representation of {@link subtotal} in major currency
   * units.
   *
   * @returns Gross invoice subtotal in major currency units.
   */
  get subtotalAmount(): number {
    return this.subtotal.toMajor();
  }

  /**
   * Get the total discount as a JavaScript number.
   *
   * @returns Total discount in major currency units.
   */
  get discountTotalAmount(): number {
    return this.discountTotal.toMajor();
  }

  /**
   * Get the total additive tax as a JavaScript number.
   *
   * @returns Total additive tax in major currency units.
   */
  get taxTotalAmount(): number {
    return this.taxTotal.toMajor();
  }

  /**
   * Get the total withholding amount as a JavaScript number.
   *
   * @returns Total withholding tax in major currency units.
   */
  get withholdingTotalAmount(): number {
    return this.withholdingTotal.toMajor();
  }

  /**
   * Get the invoice grand total as a JavaScript number.
   *
   * This is the invoice-declared total after discounts and additive taxes,
   * before withholding is deducted.
   *
   * @returns Invoice grand total in major currency units.
   */
  get grandTotalAmount(): number {
    return this.grandTotal.toMajor();
  }

  /**
   * Get the amount actually payable by the buyer as a JavaScript number.
   *
   * This is the grand total after withholding deductions.
   *
   * @returns Net payable amount in major currency units.
   */
  get netPayableAmount(): number {
    return this.netPayable.toMajor();
  }

  /**
   * Get the effective discount rate relative to the invoice subtotal.
   *
   * Calculated as:
   *
   * `discountTotal ÷ subtotal`
   *
   * Returns `0` when the subtotal is zero.
   *
   * @returns Effective discount rate as a decimal fraction.
   *
   * @example
   * ```ts
   * // 10% discount
   * totals.effectiveDiscountRate; // 0.10
   * ```
   */
  get effectiveDiscountRate(): number {
    if (this.subtotal.isZero()) return 0;
    return this.discountTotal.ratio(this.subtotal);
  }

  /**
   * Get the effective additive tax rate relative to the post-discount base.
   *
   * Calculated as:
   *
   * `taxTotal ÷ (subtotal − discountTotal)`
   *
   * Returns `0` when the invoice grand total is zero.
   *
   * Unlike a simple sum of configured tax rates, this value is derived from
   * the actual aggregate monetary totals.
   *
   * @returns Effective additive tax rate as a decimal fraction.
   */
  get effectiveTaxRate(): number {
    if (this.grandTotal.isZero()) return 0;
    return this.taxTotal.ratio(this.subtotal.subtract(this.discountTotal));
  }

  /**
   * Determine whether the invoice contains any discount.
   *
   * @returns `true` when the aggregate discount is positive; otherwise `false`.
   */
  get hasDiscount(): boolean {
    return this.discountTotal.isPositive();
  }

  /**
   * Determine whether the invoice contains any positive additive tax.
   *
   * Withholding taxes are not included in this flag.
   *
   * @returns `true` when the aggregate additive tax is positive; otherwise `false`.
   */
  get hasTax(): boolean {
    return this.taxTotal.isPositive();
  }

  /**
   * Determine whether the invoice contains any withholding tax.
   *
   * @returns `true` when the aggregate withholding amount is positive;
   * otherwise `false`.
   */
  get hasWithholding(): boolean {
    return this.withholdingTotal.isPositive();
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  private static deserializeMoneyField(
    value: unknown,
    field: string,
  ): MajikMoney {
    if (value === undefined || value === null) {
      throw new TypeError(`InvoiceTotals JSON field "${field}" is required`);
    }

    try {
      const money = deserializeMoney(value as never);

      if (!(money instanceof MajikMoney)) {
        throw new TypeError(`InvoiceTotals JSON field "${field}" is invalid`);
      }

      return money;
    } catch {
      throw new TypeError(`InvoiceTotals JSON field "${field}" is invalid`);
    }
  }

  /**
   * Serialize the invoice totals into their JSON representation.
   *
   * All monetary values are serialized through {@link serializeMoney} so the
   * resulting object can be safely persisted or transported.
   *
   * @returns JSON-serializable invoice totals.
   *
   * @example
   * ```ts
   * const json = totals.toJSON();
   * JSON.stringify(json);
   * ```
   */
  toJSON(): InvoiceTotalsJSON {
    return {
      subtotal: serializeMoney(this.subtotal),
      discountTotal: serializeMoney(this.discountTotal),
      taxTotal: serializeMoney(this.taxTotal),
      withholdingTotal: serializeMoney(this.withholdingTotal),
      grandTotal: serializeMoney(this.grandTotal),
      netPayable: serializeMoney(this.netPayable),
    };
  }

  /**
   * Reconstruct invoice totals from their serialized JSON representation.
   *
   * Monetary fields are restored to {@link MajikMoney} instances using
   * {@link deserializeMoney}.
   *
   * @param json - Serialized invoice totals.
   * @returns A reconstructed `InvoiceTotals` instance.
   *
   * @example
   * ```ts
   * const totals = InvoiceTotals.fromJSON(savedTotals);
   * ```
   */
  static fromJSON(json: InvoiceTotalsJSON): InvoiceTotals {
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new TypeError("InvoiceTotals JSON must be an object");
    }

    const subtotal = InvoiceTotals.deserializeMoneyField(
      json.subtotal,
      "subtotal",
    );

    const discountTotal = InvoiceTotals.deserializeMoneyField(
      json.discountTotal,
      "discountTotal",
    );

    const taxTotal = InvoiceTotals.deserializeMoneyField(
      json.taxTotal,
      "taxTotal",
    );

    const withholdingTotal = InvoiceTotals.deserializeMoneyField(
      json.withholdingTotal,
      "withholdingTotal",
    );

    const grandTotal = InvoiceTotals.deserializeMoneyField(
      json.grandTotal,
      "grandTotal",
    );

    const netPayable = InvoiceTotals.deserializeMoneyField(
      json.netPayable,
      "netPayable",
    );

    return new InvoiceTotals(
      subtotal,
      discountTotal,
      taxTotal,
      withholdingTotal,
      grandTotal,
      netPayable,
    );
  }
}

// Freeze static methods
Object.freeze(InvoiceTotals);

// Freeze instance methods
Object.freeze(InvoiceTotals.prototype);
