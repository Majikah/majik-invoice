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

export class InvoiceTotals {
  readonly subtotal: MajikMoney;
  readonly discountTotal: MajikMoney;
  /** Sum of additive taxes only — this is what appears on the invoice as "Tax" */
  readonly taxTotal: MajikMoney;
  /** Sum of withholding taxes — tracked separately, does not reduce grandTotal */
  readonly withholdingTotal: MajikMoney;
  /** subtotal − discountTotal + taxTotal — the invoice-declared amount */
  readonly grandTotal: MajikMoney;
  /** grandTotal − withholdingTotal — the cash the buyer actually remits */
  readonly netPayable: MajikMoney;

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
  }

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

  get subtotalAmount(): number {
    return this.subtotal.toMajor();
  }
  get discountTotalAmount(): number {
    return this.discountTotal.toMajor();
  }
  get taxTotalAmount(): number {
    return this.taxTotal.toMajor();
  }
  get withholdingTotalAmount(): number {
    return this.withholdingTotal.toMajor();
  }
  get grandTotalAmount(): number {
    return this.grandTotal.toMajor();
  }
  get netPayableAmount(): number {
    return this.netPayable.toMajor();
  }

  get effectiveDiscountRate(): number {
    if (this.subtotal.isZero()) return 0;
    return this.discountTotal.ratio(this.subtotal);
  }

  get effectiveTaxRate(): number {
    if (this.grandTotal.isZero()) return 0;
    return this.taxTotal.ratio(this.subtotal.subtract(this.discountTotal));
  }

  get hasDiscount(): boolean {
    return this.discountTotal.isPositive();
  }
  get hasTax(): boolean {
    return this.taxTotal.isPositive();
  }
  get hasWithholding(): boolean {
    return this.withholdingTotal.isPositive();
  }

  // ── Serialization ─────────────────────────────────────────────────────────

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

  static fromJSON(json: InvoiceTotalsJSON): InvoiceTotals {
    return new InvoiceTotals(
      deserializeMoney(json.subtotal) as MajikMoney,
      deserializeMoney(json.discountTotal) as MajikMoney,
      deserializeMoney(json.taxTotal) as MajikMoney,
      deserializeMoney(json.withholdingTotal) as MajikMoney,
      deserializeMoney(json.grandTotal) as MajikMoney,
      deserializeMoney(json.netPayable) as MajikMoney,
    );
  }
}
