/**
 * @file line-item.ts
 */

import {
  MajikMoney,
  serializeMoney,
  deserializeMoney,
} from "@thezelijah/majik-money";
import type { LineItemInput, LineItemJSON, Discount } from "./types";
import { TaxManager } from "./tax-manager";
import { resolveTaxes } from "./utils";

/**
 * Validation error thrown when a {@link LineItem} input or calculated value
 * violates a line-item-specific business rule.
 *
 * The optional `field` property identifies the input field associated with
 * the validation failure.
 *
 * @example
 * ```ts
 * try {
 *   LineItem.create(input, "PHP");
 * } catch (error) {
 *   if (error instanceof LineItemValidationError) {
 *     console.error(error.field, error.message);
 *   }
 * }
 * ```
 */
export class LineItemValidationError extends Error {
  /**
   * Create a line-item validation error.
   *
   * @param message - Human-readable explanation of the validation failure.
   * @param field - Optional field path associated with the failure.
   */
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
 * Represents a single invoice line item and its complete monetary calculation.
 *
 * A `LineItem` combines the source information for a product or service with
 * its resolved taxes, discount, calculated tax amounts, total contribution,
 * withholding amounts, and final payable amount.
 *
 * ### Calculation flow
 *
 * The line item calculates values in the following order:
 *
 * 1. `lineTotal` = `unitPrice × quantity`
 * 2. `discountAmount` = percentage or fixed discount
 * 3. `postDiscount` = `lineTotal − discountAmount`
 * 4. Additive taxes are calculated against `postDiscount`
 * 5. `netTotal` is calculated without double-counting inclusive taxes
 * 6. Withholding taxes are calculated against the applicable withholding base
 * 7. `netPayable` = `netTotal − withholdingTaxAmount`
 *
 * ### Tax inheritance
 *
 * Taxes explicitly assigned to the line item take precedence over invoice-level
 * default taxes. When the line item has no taxes of its own, the supplied
 * `defaultTaxes` are inherited through {@link TaxManager.resolve}.
 *
 * ### Immutability
 *
 * `LineItem` instances are fully initialized during construction and expose
 * their state as `readonly` properties. Use {@link LineItem.create} or
 * {@link LineItem.fromJSON} to construct instances rather than instantiating
 * them directly.
 *
 * ### Monetary precision
 *
 * All monetary calculations are performed using {@link MajikMoney}. Numeric
 * getters such as `lineTotalAmount` are convenience projections of the
 * underlying `MajikMoney` values.
 *
 * @example
 * ```ts
 * const item = LineItem.create(
 *   {
 *     description: "Software License",
 *     quantity: 2,
 *     unitPrice: 1500,
 *     taxes: [
 *       {
 *         taxType: "VAT",
 *         rate: 0.12,
 *       },
 *     ],
 *   },
 *   "PHP",
 * );
 *
 * console.log(item.lineTotalAmount);
 * console.log(item.netTotalAmount);
 * console.log(item.taxAmountValue);
 * ```
 */
export class LineItem {
  // ── Identity ──────────────────────────────────────────────────────────────

  /**
   * Stable identifier for this line item.
   *
   * When no ID is supplied during creation, a UUID is generated automatically.
   */
  readonly id: string;

  /**
   * Optional stock-keeping or product identifier associated with the line.
   */
  readonly skuId?: string;

  /**
   * Human-readable description of the product or service being billed.
   *
   * Leading and trailing whitespace is removed during construction.
   */
  readonly description: string;

  /**
   * Number of units being billed.
   *
   * Must be a finite number greater than zero.
   */
  readonly quantity: number;

  /**
   * Optional unit of measure for the quantity.
   *
   * Examples include `"kg"`, `"hour"`, `"piece"`, or `"month"`.
   */
  readonly unit?: string;

  // ── Money ─────────────────────────────────────────────────────────────────

  /**
   * Price of one unit before discounts and taxes.
   *
   * Stored as a {@link MajikMoney} value to preserve currency-aware monetary
   * arithmetic.
   */
  readonly unitPrice: MajikMoney;

  /**
   * Taxes resolved for this line item.
   *
   * Explicit line-item taxes take precedence over invoice-level defaults.
   */
  readonly taxes: TaxManager;

  /**
   * Optional discount applied to the line total.
   *
   * The discount may be percentage-based or a fixed monetary amount depending
   * on the supplied {@link Discount}.
   */
  readonly discount?: Discount;

  // ── Computed — additive taxes (VAT, GST, excise) ──────────────────────────

  /**
   * Gross line amount before discounts and taxes.
   *
   * Calculated as:
   *
   * `unitPrice × quantity`
   */
  readonly lineTotal: MajikMoney;

  /**
   * Monetary amount removed from `lineTotal` by the configured discount.
   *
   * When no discount is applied, this is zero in the line item's currency.
   */
  readonly discountAmount: MajikMoney;

  /**
   * Total amount of all additive taxes on this line.
   *
   * This includes both:
   * - inclusive additive taxes extracted from the line amount, and
   * - exclusive additive taxes added on top of the discounted base.
   *
   * Withholding taxes are intentionally excluded.
   */
  readonly additiveTaxAmount: MajikMoney;

  /**
   * Total amount of all withholding taxes on this line.
   *
   * Withholding amounts are tracked separately because they reduce the amount
   * actually remitted by the buyer rather than increasing the invoice's
   * `netTotal`.
   */
  readonly withholdingTaxAmount: MajikMoney;

  /**
   * Backward-compatible alias for {@link additiveTaxAmount}.
   *
   * This property is retained so callers using the historical `taxAmount`
   * name continue to receive the additive tax total.
   */
  readonly taxAmount: MajikMoney;

  /**
   * Final contribution of this line item to the invoice grand total.
   *
   * For exclusive additive taxes:
   *
   * `postDiscount + exclusiveTaxTotal`
   *
   * For inclusive taxes, the tax is already embedded inside `postDiscount`
   * and therefore is not added again.
   *
   * The invoice-level grand total is expected to be the sum of `netTotal`
   * across all line items.
   */
  readonly netTotal: MajikMoney;

  /**
   * Amount actually payable by the buyer after withholding taxes are deducted.
   *
   * Calculated as:
   *
   * `netTotal − withholdingTaxAmount`
   *
   * This represents the amount the buyer actually remits to the seller after
   * withholding obligations are accounted for.
   */
  readonly netPayable: MajikMoney;

  /**
   * Additive tax amounts grouped by `taxType`.
   *
   * Each entry contains the calculated monetary amount for that tax type.
   *
   * @example
   * ```ts
   * item.additiveTaxBreakdown.get("VAT");
   * ```
   */
  readonly additiveTaxBreakdown: ReadonlyMap<string, MajikMoney>;

  /**
   * Withholding tax amounts grouped by `taxType`.
   *
   * Each entry contains the calculated monetary amount for that withholding
   * tax type.
   *
   * @example
   * ```ts
   * item.withholdingTaxBreakdown.get("EWT");
   * ```
   */
  readonly withholdingTaxBreakdown: ReadonlyMap<string, MajikMoney>;

  // ── Accounting ────────────────────────────────────────────────────────────

  /**
   * Optional accounting or chart-of-accounts code associated with the line.
   */
  readonly accountCode?: string;

  /**
   * Optional cost-center identifier used for internal accounting allocation.
   */
  readonly costCenter?: string;

  /**
   * Optional arbitrary tags used to classify or organize the line item.
   */
  readonly tags?: string[];

  /**
   * Optional application-defined metadata associated with the line item.
   *
   * Metadata is preserved as supplied and is not interpreted by the line-item
   * calculation engine.
   */
  readonly metadata?: Record<string, unknown>;

  // ── Private constructor ───────────────────────────────────────────────────

  /**
   * Construct a fully calculated line item from validated input.
   *
   * This constructor is intentionally private. Use {@link LineItem.create}
   * for normal construction so input validation and money conversion happen
   * consistently.
   *
   * @param input - Validated source data for the line item.
   * @param unitPriceMoney - Unit price represented as `MajikMoney`.
   * @param currencyCode - Currency used for monetary calculations.
   * @param defaultTaxes - Optional invoice-level taxes to inherit when the
   * line item does not define its own taxes.
   */
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
    // This is the taxable base after discounts.
    // Inclusive taxes, when present, remain embedded in this amount.

    const postDiscount = this.lineTotal.subtract(this.discountAmount);

    // ── Step 4: additive taxes (VAT / GST / excise) ────────────────────────
    // Inclusive taxes are extracted from the discounted amount.
    // Exclusive taxes are calculated on the discounted amount and added on top.

    let inclusiveTaxTotal = MajikMoney.zero(currencyCode);
    let exclusiveTaxTotal = MajikMoney.zero(currencyCode);

    const additiveTaxes = this.taxes.additive;
    const additiveMap = new Map<string, MajikMoney>();

    for (const tax of additiveTaxes) {
      if (tax.inclusive) {
        // Extract embedded tax from the postDiscount amount using tax.rate / (1 + tax.rate)
        const amount = postDiscount.applyPercentage(tax.rate / (1 + tax.rate));
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
    // Inclusive taxes are already contained in postDiscount.
    // Only exclusive taxes are therefore added to the line total contribution.

    this.netTotal = postDiscount.add(exclusiveTaxTotal);

    // ── Step 6: withholding taxes (EWT / WHT) ─────────────────────────────
    // Withholding is calculated independently from additive tax totals.
    // Inclusive additive taxes are removed from the withholding base so that
    // withholding is calculated against the underlying non-VAT amount.
    // Withholding does not increase netTotal or the invoice grand total.

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
    // Withholding reduces the amount paid to the seller but does not change
    // the line's gross invoice contribution.

    this.netPayable = this.netTotal.subtract(withholdingTotal);
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Create and fully calculate a line item from raw input.
   *
   * This is the primary construction method for `LineItem`.
   *
   * The input is validated before the unit price is converted to
   * {@link MajikMoney} and the line's tax/discount calculations are performed.
   *
   * @param input - Raw line-item definition.
   * @param currencyCode - ISO currency code used for all monetary values.
   * @param defaultTaxes - Optional invoice-level taxes to inherit when the
   * line item does not provide its own taxes.
   * @returns A fully validated and calculated `LineItem`.
   * @throws {@link LineItemValidationError} When the input violates a
   * line-item validation rule.
   * @throws Errors produced by tax resolution or monetary conversion when
   * those operations reject the supplied data.
   *
   * @example
   * ```ts
   * const item = LineItem.create(
   *   {
   *     description: "Consulting",
   *     quantity: 10,
   *     unitPrice: 500,
   *   },
   *   "PHP",
   * );
   * ```
   */
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

  /**
   * Validate raw line-item input before construction.
   *
   * Validation covers the fundamental line-item invariants:
   * - a non-empty description is required
   * - quantity must be finite and greater than zero
   * - unit price must be finite and non-negative
   * - tax input must be valid according to {@link TaxManager}
   * - discount values must be finite and non-negative
   * - percentage discounts must be between `0` and `1`
   *
   * This method validates input only; it does not construct or return a
   * `LineItem`.
   *
   * @param input - Raw line-item definition to validate.
   * @returns Nothing when the input is valid.
   * @throws {@link LineItemValidationError} When a line-item rule is violated.
   * @throws Errors produced by {@link resolveTaxes} when supplied tax input
   * is invalid.
   *
   * @example
   * ```ts
   * LineItem.validate(input);
   * ```
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

  /**
   * Get the gross line total as a JavaScript number.
   *
   * This is the numeric representation of {@link lineTotal}.
   *
   * @returns `unitPrice × quantity` expressed in major currency units.
   */
  get lineTotalAmount(): number {
    return this.lineTotal.toMajor();
  }

  /**
   * Get the additive tax total as a JavaScript number.
   *
   * This is the backward-compatible numeric equivalent of
   * {@link additiveTaxAmount}.
   *
   * @returns Total additive tax in major currency units.
   */
  get taxAmountValue(): number {
    return this.additiveTaxAmount.toMajor();
  }

  /**
   * Get the additive tax total as a JavaScript number.
   *
   * This is the explicit numeric counterpart of {@link additiveTaxAmount}.
   *
   * @returns Total additive tax in major currency units.
   */
  get additiveTaxAmountValue(): number {
    return this.additiveTaxAmount.toMajor();
  }

  /**
   * Get the withholding tax total as a JavaScript number.
   *
   * @returns Total withholding tax in major currency units.
   */
  get withholdingTaxAmountValue(): number {
    return this.withholdingTaxAmount.toMajor();
  }

  /**
   * Get the discount amount as a JavaScript number.
   *
   * @returns Discount amount in major currency units.
   */
  get discountAmountValue(): number {
    return this.discountAmount.toMajor();
  }

  /**
   * Get the line's invoice-total contribution as a JavaScript number.
   *
   * @returns `netTotal` in major currency units.
   */
  get netTotalAmount(): number {
    return this.netTotal.toMajor();
  }

  /**
   * Get the amount actually payable after withholding as a JavaScript number.
   *
   * @returns `netPayable` in major currency units.
   */
  get netPayableAmount(): number {
    return this.netPayable.toMajor();
  }

  /**
   * Get the nominal combined rate of all additive taxes.
   *
   * This is a simple sum of the configured additive tax rates and does not
   * account for whether taxes are inclusive, the order of calculation, or
   * the resulting monetary tax amount.
   *
   * For example, additive VAT at `12%` and an additive excise tax at `5%`
   * produce a nominal rate of `17%` (`0.17`).
   *
   * @returns Sum of all additive tax rates as a decimal fraction.
   */
  get nominalTaxRate(): number {
    const additive = this.taxes.additive;
    return additive.reduce((s, t) => s + t.rate, 0);
  }

  /**
   * Get the effective additive tax rate for the discounted line amount.
   *
   * Unlike {@link nominalTaxRate}, this is derived from the actual calculated
   * additive tax amount relative to the post-discount amount.
   *
   * @returns Effective additive tax rate as a decimal fraction.
   */
  get effectiveTaxRate(): number {
    const postDiscount = this.lineTotal.subtract(this.discountAmount);
    return this.additiveTaxAmount.ratio(postDiscount);
  }

  /**
   * Determine whether this line has a positive-rate additive tax.
   *
   * Withholding and informational taxes do not make a line taxable for this
   * purpose.
   *
   * @returns `true` when at least one additive tax has a rate greater than zero.
   */
  get isTaxable(): boolean {
    return this.taxes
      .toArray()
      .some((t) => (t.behaviour ?? "additive") === "additive" && t.rate > 0);
  }

  /**
   * Determine whether a discount was supplied for this line.
   *
   * @returns `true` when a discount exists; otherwise `false`.
   */
  get hasDiscount(): boolean {
    return !!this.discount;
  }

  /**
   * Get the calculated additive tax amount for a specific tax type.
   *
   * @param taxType - Tax type used to look up the calculated amount.
   * @returns The tax amount in major currency units, or `0` when no matching
   * additive tax exists.
   *
   * @example
   * ```ts
   * const vat = item.taxAmountByType("VAT");
   * ```
   */
  taxAmountByType(taxType: string): number {
    return this.additiveTaxBreakdown.get(taxType)?.toMajor() ?? 0;
  }

  /**
   * Get the calculated withholding amount for a specific tax type.
   *
   * @param taxType - Tax type used to look up the calculated withholding amount.
   * @returns The withholding amount in major currency units, or `0` when no
   * matching withholding tax exists.
   *
   * @example
   * ```ts
   * const ewt = item.withholdingAmountByType("EWT");
   * ```
   */
  withholdingAmountByType(taxType: string): number {
    return this.withholdingTaxBreakdown.get(taxType)?.toMajor() ?? 0;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /**
   * Serialize this line item into its JSON representation.
   *
   * Monetary values are serialized through {@link serializeMoney} so the
   * resulting object can be persisted or transported without losing the
   * underlying monetary representation.
   *
   * The legacy `taxAmount` field is also emitted as an alias of
   * `additiveTaxAmount` for backward compatibility.
   *
   * @returns JSON-serializable representation of the line item.
   *
   * @example
   * ```ts
   * const json = item.toJSON();
   * JSON.stringify(json);
   * ```
   */
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

  /**
   * Reconstruct a line item from its serialized JSON representation.
   *
   * The persisted unit price is deserialized back into {@link MajikMoney},
   * while the original input fields are reconstructed and passed through the
   * normal line-item calculation path.
   *
   * @param json - Serialized line-item representation.
   * @param currencyCode - Currency code used when reconstructing the line item.
   * @returns A reconstructed and fully calculated `LineItem`.
   *
   * @example
   * ```ts
   * const item = LineItem.fromJSON(savedItem, "PHP");
   * ```
   */
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

// Freeze static methods
Object.freeze(LineItem);

// Freeze instance methods
Object.freeze(LineItem.prototype);
