import { describe, it, expect } from "vitest";
import { MajikMoney } from "@thezelijah/majik-money";
import { InvoiceTotals } from "../src/core/general-invoice/invoice-totals";
import type { LineItem } from "../src/core/general-invoice/line-item";
import type {
  CurrencyCode,
  InvoiceTotalsJSON,
} from "../src/core/general-invoice/types";

describe("InvoiceTotals", () => {
  // ===========================================================================
  // Fixtures & Helpers
  // ===========================================================================

  const makeLineItem = (
    line: number,
    discount: number,
    tax: number,
    withholding: number,
    net: number,
    payable: number,
    currency: CurrencyCode = "PHP",
  ): LineItem => {
    return {
      lineTotal: MajikMoney.fromMajor(line, currency),
      discountAmount: MajikMoney.fromMajor(discount, currency),
      additiveTaxAmount: MajikMoney.fromMajor(tax, currency),
      withholdingTaxAmount: MajikMoney.fromMajor(withholding, currency),
      netTotal: MajikMoney.fromMajor(net, currency),
      netPayable: MajikMoney.fromMajor(payable, currency),
    } as unknown as LineItem;
  };

  const makeEmptyItem = (currency: CurrencyCode = "PHP"): LineItem =>
    makeLineItem(0, 0, 0, 0, 0, 0, currency);

  const makeTotalsJSON = (
    overrides: Partial<InvoiceTotalsJSON> = {},
  ): InvoiceTotalsJSON => {
    const zero = MajikMoney.zero("PHP");

    return {
      subtotal: {
        ...zero,
      } as never,
      discountTotal: {
        ...zero,
      } as never,
      taxTotal: {
        ...zero,
      } as never,
      withholdingTotal: {
        ...zero,
      } as never,
      grandTotal: {
        ...zero,
      } as never,
      netPayable: {
        ...zero,
      } as never,
      ...overrides,
    };
  };

  // ===========================================================================
  // Construction / Factory
  // ===========================================================================

  describe("fromLineItems()", () => {
    describe("empty collection", () => {
      it("creates an InvoiceTotals instance", () => {
        const totals = InvoiceTotals.fromLineItems([], "PHP");

        expect(totals).toBeInstanceOf(InvoiceTotals);
      });

      it("initializes every aggregate to zero", () => {
        const totals = InvoiceTotals.fromLineItems([], "PHP");

        expect(totals.subtotalAmount).toBe(0);
        expect(totals.discountTotalAmount).toBe(0);
        expect(totals.taxTotalAmount).toBe(0);
        expect(totals.withholdingTotalAmount).toBe(0);
        expect(totals.grandTotalAmount).toBe(0);
        expect(totals.netPayableAmount).toBe(0);
      });

      it("initializes all monetary values in the requested currency", () => {
        const totals = InvoiceTotals.fromLineItems([], "USD");

        expect(totals.subtotal.currency.code).toBe("USD");
        expect(totals.discountTotal.currency.code).toBe("USD");
        expect(totals.taxTotal.currency.code).toBe("USD");
        expect(totals.withholdingTotal.currency.code).toBe("USD");
        expect(totals.grandTotal.currency.code).toBe("USD");
        expect(totals.netPayable.currency.code).toBe("USD");
      });

      it("preserves zero state across all indicators", () => {
        const totals = InvoiceTotals.fromLineItems([], "PHP");

        expect(totals.hasDiscount).toBe(false);
        expect(totals.hasTax).toBe(false);
        expect(totals.hasWithholding).toBe(false);

        expect(totals.effectiveDiscountRate).toBe(0);
        expect(totals.effectiveTaxRate).toBe(0);
      });

      it("does not require a line-item object for the empty case", () => {
        const totals = InvoiceTotals.fromLineItems([], "PHP");

        expect(totals.subtotalAmount).toBe(0);
      });
    });

    describe("single line item", () => {
      it("mirrors every monetary property from one line item", () => {
        const item = makeLineItem(1000, 100, 108, 50, 1008, 958);

        const totals = InvoiceTotals.fromLineItems([item], "PHP");

        expect(totals.subtotalAmount).toBe(1000);
        expect(totals.discountTotalAmount).toBe(100);
        expect(totals.taxTotalAmount).toBe(108);
        expect(totals.withholdingTotalAmount).toBe(50);
        expect(totals.grandTotalAmount).toBe(1008);
        expect(totals.netPayableAmount).toBe(958);
      });

      it("preserves the source line item's currency", () => {
        const item = makeLineItem(1000, 100, 108, 50, 1008, 958, "USD");

        const totals = InvoiceTotals.fromLineItems([item], "PHP");

        expect(totals.subtotal.currency.code).toBe("USD");
        expect(totals.grandTotal.currency.code).toBe("USD");
      });

      it("does not modify the supplied line item", () => {
        const item = makeLineItem(1000, 100, 108, 50, 1008, 958);

        const before = {
          line: item.lineTotal.toMajor(),
          discount: item.discountAmount.toMajor(),
          tax: item.additiveTaxAmount.toMajor(),
          withholding: item.withholdingTaxAmount.toMajor(),
          net: item.netTotal.toMajor(),
          payable: item.netPayable.toMajor(),
        };

        InvoiceTotals.fromLineItems([item], "PHP");

        expect(item.lineTotal.toMajor()).toBe(before.line);
        expect(item.discountAmount.toMajor()).toBe(before.discount);
        expect(item.additiveTaxAmount.toMajor()).toBe(before.tax);
        expect(item.withholdingTaxAmount.toMajor()).toBe(before.withholding);
        expect(item.netTotal.toMajor()).toBe(before.net);
        expect(item.netPayable.toMajor()).toBe(before.payable);
      });
    });

    describe("multiple line items", () => {
      it("aggregates subtotal correctly", () => {
        const items = [
          makeLineItem(1000, 100, 108, 45, 1008, 963),
          makeLineItem(500, 0, 60, 25, 560, 535),
          makeLineItem(200, 200, 0, 0, 0, 0),
        ];

        const totals = InvoiceTotals.fromLineItems(items, "PHP");

        expect(totals.subtotalAmount).toBe(1700);
      });

      it("aggregates discount totals correctly", () => {
        const totals = InvoiceTotals.fromLineItems(
          [
            makeLineItem(1000, 100, 108, 45, 1008, 963),
            makeLineItem(500, 0, 60, 25, 560, 535),
            makeLineItem(200, 200, 0, 0, 0, 0),
          ],
          "PHP",
        );

        expect(totals.discountTotalAmount).toBe(300);
      });

      it("aggregates additive tax totals correctly", () => {
        const totals = InvoiceTotals.fromLineItems(
          [
            makeLineItem(1000, 100, 108, 45, 1008, 963),
            makeLineItem(500, 0, 60, 25, 560, 535),
            makeLineItem(200, 200, 0, 0, 0, 0),
          ],
          "PHP",
        );

        expect(totals.taxTotalAmount).toBe(168);
      });

      it("aggregates withholding totals correctly", () => {
        const totals = InvoiceTotals.fromLineItems(
          [
            makeLineItem(1000, 100, 108, 45, 1008, 963),
            makeLineItem(500, 0, 60, 25, 560, 535),
          ],
          "PHP",
        );

        expect(totals.withholdingTotalAmount).toBe(70);
      });

      it("aggregates grand totals from line netTotal values", () => {
        const totals = InvoiceTotals.fromLineItems(
          [
            makeLineItem(1000, 100, 108, 45, 1008, 963),
            makeLineItem(500, 0, 60, 25, 560, 535),
          ],
          "PHP",
        );

        expect(totals.grandTotalAmount).toBe(1568);
      });

      it("aggregates net payable from line netPayable values", () => {
        const totals = InvoiceTotals.fromLineItems(
          [
            makeLineItem(1000, 100, 108, 45, 1008, 963),
            makeLineItem(500, 0, 60, 25, 560, 535),
          ],
          "PHP",
        );

        expect(totals.netPayableAmount).toBe(1498);
      });

      it("supports a mixture of discounted, taxable, withholding, and zero-value lines", () => {
        const totals = InvoiceTotals.fromLineItems(
          [
            makeLineItem(2000, 200, 216, 40, 2016, 1976),
            makeLineItem(500, 0, 0, 25, 500, 475),
            makeLineItem(300, 300, 0, 0, 0, 0),
            makeEmptyItem(),
          ],
          "PHP",
        );

        expect(totals.subtotalAmount).toBe(2800);
        expect(totals.discountTotalAmount).toBe(500);
        expect(totals.taxTotalAmount).toBe(216);
        expect(totals.withholdingTotalAmount).toBe(65);
        expect(totals.grandTotalAmount).toBe(2516);
        expect(totals.netPayableAmount).toBe(2451);
      });
    });

    describe("runtime-invalid inputs", () => {
      it("throws when lineItems is undefined", () => {
        expect(() =>
          InvoiceTotals.fromLineItems(undefined as never, "PHP"),
        ).toThrow();
      });

      it("throws when lineItems is null", () => {
        expect(() =>
          InvoiceTotals.fromLineItems(null as never, "PHP"),
        ).toThrow();
      });

      it("throws when a non-array object lacks the required collection API", () => {
        expect(() => InvoiceTotals.fromLineItems({} as never, "PHP")).toThrow();
      });

      it("throws when line items contain incompatible currencies", () => {
        const php = makeLineItem(100, 0, 0, 0, 100, 100, "PHP");

        const usd = makeLineItem(100, 0, 0, 0, 100, 100, "USD");

        expect(() => InvoiceTotals.fromLineItems([php, usd], "PHP")).toThrow();
      });
    });
  });

  // ===========================================================================
  // Monetary Amount Getters
  // ===========================================================================

  describe("Amount Getters", () => {
    it("returns subtotal in major units", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000.5, 0, 0, 0, 1000.5, 1000.5)],
        "PHP",
      );

      expect(totals.subtotalAmount).toBe(1000.5);
    });

    it("returns discountTotal in major units", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 125.5, 0, 0, 874.5, 874.5)],
        "PHP",
      );

      expect(totals.discountTotalAmount).toBe(125.5);
    });

    it("returns taxTotal in major units", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 123.45, 0, 1123.45, 1123.45)],
        "PHP",
      );

      expect(totals.taxTotalAmount).toBe(123.45);
    });

    it("returns withholdingTotal in major units", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 0, 55.55, 1000, 944.45)],
        "PHP",
      );

      expect(totals.withholdingTotalAmount).toBe(55.55);
    });

    it("returns grandTotal in major units", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 100, 108, 0, 1008, 1008)],
        "PHP",
      );

      expect(totals.grandTotalAmount).toBe(1008);
    });

    it("returns netPayable in major units", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 120, 50, 1120, 1070)],
        "PHP",
      );

      expect(totals.netPayableAmount).toBe(1070);
    });

    it("returns all values correctly for fractional monetary amounts", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000.5, 100.25, 108.03, 50.1, 1008.28, 958.18)],
        "PHP",
      );

      expect(totals.subtotalAmount).toBe(1000.5);
      expect(totals.discountTotalAmount).toBe(100.25);
      expect(totals.taxTotalAmount).toBe(108.03);
      expect(totals.withholdingTotalAmount).toBe(50.1);
      expect(totals.grandTotalAmount).toBe(1008.28);
      expect(totals.netPayableAmount).toBe(958.18);
    });
  });

  // ===========================================================================
  // Derived Rates
  // ===========================================================================

  describe("Derived Rates", () => {
    describe("effectiveDiscountRate", () => {
      it("calculates discount / subtotal", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 200, 0, 0, 800, 800)],
          "PHP",
        );

        expect(totals.effectiveDiscountRate).toBeCloseTo(0.2, 10);
      });

      it("returns zero when subtotal is zero", () => {
        const totals = InvoiceTotals.fromLineItems([], "PHP");

        expect(totals.effectiveDiscountRate).toBe(0);
      });

      it("returns zero when discount is zero", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 0, 0, 1000, 1000)],
          "PHP",
        );

        expect(totals.effectiveDiscountRate).toBe(0);
      });

      it("returns one for a 100% discount", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 1000, 0, 0, 0, 0)],
          "PHP",
        );

        expect(totals.effectiveDiscountRate).toBe(1);
      });

      it("uses aggregate values rather than individual line percentages", () => {
        const totals = InvoiceTotals.fromLineItems(
          [
            makeLineItem(1000, 100, 0, 0, 900, 900),
            makeLineItem(300, 150, 0, 0, 150, 150),
          ],
          "PHP",
        );

        // Total discount = 250
        // Total subtotal = 1300
        expect(totals.effectiveDiscountRate).toBeCloseTo(250 / 1300, 10);
      });
    });

    describe("effectiveTaxRate", () => {
      it("calculates tax / post-discount base", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 100, 108, 0, 1008, 1008)],
          "PHP",
        );

        // post-discount = 900
        // tax = 108
        // effective rate = 108 / 900 = 12%
        expect(totals.effectiveTaxRate).toBeCloseTo(0.12, 10);
      });

      it("returns zero when grand total is zero", () => {
        const totals = InvoiceTotals.fromLineItems([], "PHP");

        expect(totals.effectiveTaxRate).toBe(0);
      });

      it("returns zero when there is no additive tax", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 0, 50, 1000, 950)],
          "PHP",
        );

        expect(totals.effectiveTaxRate).toBe(0);
      });

      it("ignores withholding tax", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 120, 50, 1120, 1070)],
          "PHP",
        );

        expect(totals.effectiveTaxRate).toBeCloseTo(0.12, 10);
      });

      it("accounts for aggregate discount across multiple lines", () => {
        const totals = InvoiceTotals.fromLineItems(
          [
            makeLineItem(1000, 100, 108, 0, 1008, 1008),
            makeLineItem(500, 50, 54, 0, 504, 504),
          ],
          "PHP",
        );

        // subtotal = 1500
        // discount = 150
        // post-discount = 1350
        // tax = 162
        expect(totals.effectiveTaxRate).toBeCloseTo(162 / 1350, 10);
      });

      it("can represent a zero effective rate with positive grand total", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 100, 0, 0, 900, 900)],
          "PHP",
        );

        expect(totals.grandTotalAmount).toBe(900);
        expect(totals.effectiveTaxRate).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Indicators
  // ===========================================================================

  describe("Indicators", () => {
    describe("hasDiscount", () => {
      it("returns true when discount total is positive", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 50, 0, 0, 950, 950)],
          "PHP",
        );

        expect(totals.hasDiscount).toBe(true);
      });

      it("returns false when discount total is zero", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 0, 0, 1000, 1000)],
          "PHP",
        );

        expect(totals.hasDiscount).toBe(false);
      });

      it("returns false for an empty invoice", () => {
        expect(InvoiceTotals.fromLineItems([], "PHP").hasDiscount).toBe(false);
      });

      it("returns true when at least one line contains a discount", () => {
        const totals = InvoiceTotals.fromLineItems(
          [
            makeLineItem(1000, 0, 0, 0, 1000, 1000),
            makeLineItem(500, 25, 0, 0, 475, 475),
          ],
          "PHP",
        );

        expect(totals.hasDiscount).toBe(true);
      });
    });

    describe("hasTax", () => {
      it("returns true when additive tax total is positive", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 120, 0, 1120, 1120)],
          "PHP",
        );

        expect(totals.hasTax).toBe(true);
      });

      it("returns false when additive tax total is zero", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 0, 50, 1000, 950)],
          "PHP",
        );

        expect(totals.hasTax).toBe(false);
      });

      it("returns false for an empty invoice", () => {
        expect(InvoiceTotals.fromLineItems([], "PHP").hasTax).toBe(false);
      });

      it("ignores withholding tax when determining hasTax", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 0, 50, 1000, 950)],
          "PHP",
        );

        expect(totals.hasTax).toBe(false);
        expect(totals.hasWithholding).toBe(true);
      });
    });

    describe("hasWithholding", () => {
      it("returns true when withholding total is positive", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 0, 50, 1000, 950)],
          "PHP",
        );

        expect(totals.hasWithholding).toBe(true);
      });

      it("returns false when withholding total is zero", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 120, 0, 1120, 1120)],
          "PHP",
        );

        expect(totals.hasWithholding).toBe(false);
      });

      it("returns false for an empty invoice", () => {
        expect(InvoiceTotals.fromLineItems([], "PHP").hasWithholding).toBe(
          false,
        );
      });

      it("can be true independently of hasTax", () => {
        const totals = InvoiceTotals.fromLineItems(
          [makeLineItem(1000, 0, 0, 50, 1000, 950)],
          "PHP",
        );

        expect(totals.hasTax).toBe(false);
        expect(totals.hasWithholding).toBe(true);
      });
    });
  });

  // ===========================================================================
  // Aggregate Invariants
  // ===========================================================================

  describe("Aggregate Invariants", () => {
    it("subtotal equals the sum of lineTotal", () => {
      const items = [
        makeLineItem(100, 10, 0, 0, 90, 90),
        makeLineItem(200, 20, 10, 0, 190, 190),
        makeLineItem(300, 0, 30, 5, 330, 325),
      ];

      const totals = InvoiceTotals.fromLineItems(items, "PHP");

      expect(totals.subtotalAmount).toBe(600);
    });

    it("discountTotal equals the sum of line discounts", () => {
      const items = [
        makeLineItem(100, 10, 0, 0, 90, 90),
        makeLineItem(200, 20, 10, 0, 190, 190),
        makeLineItem(300, 0, 30, 5, 330, 325),
      ];

      const totals = InvoiceTotals.fromLineItems(items, "PHP");

      expect(totals.discountTotalAmount).toBe(30);
    });

    it("taxTotal excludes withholding", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 120, 50, 1120, 1070)],
        "PHP",
      );

      expect(totals.taxTotalAmount).toBe(120);
      expect(totals.withholdingTotalAmount).toBe(50);
    });

    it("grandTotal is based on line netTotal values", () => {
      const totals = InvoiceTotals.fromLineItems(
        [
          makeLineItem(1000, 100, 108, 0, 1008, 1008),
          makeLineItem(500, 50, 54, 0, 504, 504),
        ],
        "PHP",
      );

      expect(totals.grandTotalAmount).toBe(1512);
    });

    it("netPayable is based on line netPayable values", () => {
      const totals = InvoiceTotals.fromLineItems(
        [
          makeLineItem(1000, 0, 120, 50, 1120, 1070),
          makeLineItem(500, 0, 60, 20, 560, 540),
        ],
        "PHP",
      );

      expect(totals.netPayableAmount).toBe(1610);
    });

    it("netPayable equals grandTotal minus withholdingTotal for valid line-item inputs", () => {
      const totals = InvoiceTotals.fromLineItems(
        [
          makeLineItem(1000, 0, 120, 50, 1120, 1070),
          makeLineItem(500, 50, 54, 20, 504, 484),
        ],
        "PHP",
      );

      expect(totals.netPayableAmount).toBe(
        totals.grandTotalAmount - totals.withholdingTotalAmount,
      );
    });

    it("grandTotal reflects discounts through the supplied line netTotal values", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 200, 96, 0, 896, 896)],
        "PHP",
      );

      expect(totals.grandTotalAmount).toBe(896);

      expect(
        totals.subtotalAmount -
          totals.discountTotalAmount +
          totals.taxTotalAmount,
      ).toBe(896);
    });

    it("withholding does not increase grandTotal", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 120, 50, 1120, 1070)],
        "PHP",
      );

      expect(totals.grandTotalAmount).toBe(1120);

      expect(totals.grandTotalAmount).not.toBe(1170);
    });
  });

  // ===========================================================================
  // Serialization
  // ===========================================================================

  describe("toJSON()", () => {
    it("returns a JSON representation", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 100, 108, 50, 1008, 958)],
        "PHP",
      );

      const json = totals.toJSON();

      expect(json).toBeDefined();
      expect(typeof json).toBe("object");
    });

    it("serializes subtotal", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 0, 0, 1000, 1000)],
        "PHP",
      );

      expect(totals.toJSON().subtotal).toBeDefined();
    });

    it("serializes discountTotal", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 100, 0, 0, 900, 900)],
        "PHP",
      );

      expect(totals.toJSON().discountTotal).toBeDefined();
    });

    it("serializes taxTotal", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 120, 0, 1120, 1120)],
        "PHP",
      );

      expect(totals.toJSON().taxTotal).toBeDefined();
    });

    it("serializes withholdingTotal", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 0, 50, 1000, 950)],
        "PHP",
      );

      expect(totals.toJSON().withholdingTotal).toBeDefined();
    });

    it("serializes grandTotal", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 120, 0, 1120, 1120)],
        "PHP",
      );

      expect(totals.toJSON().grandTotal).toBeDefined();
    });

    it("serializes netPayable", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 0, 120, 50, 1120, 1070)],
        "PHP",
      );

      expect(totals.toJSON().netPayable).toBeDefined();
    });

    it("serializes all monetary values", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 100, 108, 50, 1008, 958)],
        "PHP",
      );

      const json = totals.toJSON();

      expect(json).toEqual(
        expect.objectContaining({
          subtotal: expect.anything(),
          discountTotal: expect.anything(),
          taxTotal: expect.anything(),
          withholdingTotal: expect.anything(),
          grandTotal: expect.anything(),
          netPayable: expect.anything(),
        }),
      );
    });

    it("can be passed through JSON.stringify()", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 100, 108, 50, 1008, 958)],
        "PHP",
      );

      expect(() => JSON.stringify(totals.toJSON())).not.toThrow();
    });

    it("does not expose a reference to the internal MajikMoney instances", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 100, 108, 50, 1008, 958)],
        "PHP",
      );

      const json = totals.toJSON();

      expect(json.subtotal).not.toBe(totals.subtotal);
      expect(json.discountTotal).not.toBe(totals.discountTotal);
      expect(json.taxTotal).not.toBe(totals.taxTotal);
      expect(json.withholdingTotal).not.toBe(totals.withholdingTotal);
      expect(json.grandTotal).not.toBe(totals.grandTotal);
      expect(json.netPayable).not.toBe(totals.netPayable);
    });
  });

  // ===========================================================================
  // Deserialization
  // ===========================================================================

  describe("fromJSON()", () => {
    const createSerializedTotals = () => {
      const original = InvoiceTotals.fromLineItems(
        [
          makeLineItem(1500, 125, 165, 50, 1540, 1490),
          makeLineItem(500, 50, 54, 20, 504, 484),
        ],
        "PHP",
      );

      return {
        original,
        json: original.toJSON(),
      };
    };

    it("reconstructs an InvoiceTotals instance", () => {
      const { json } = createSerializedTotals();

      const restored = InvoiceTotals.fromJSON(json);

      expect(restored).toBeInstanceOf(InvoiceTotals);
    });

    it("restores subtotal exactly", () => {
      const { original, json } = createSerializedTotals();

      const restored = InvoiceTotals.fromJSON(json);

      expect(restored.subtotalAmount).toBe(original.subtotalAmount);
    });

    it("restores discountTotal exactly", () => {
      const { original, json } = createSerializedTotals();

      const restored = InvoiceTotals.fromJSON(json);

      expect(restored.discountTotalAmount).toBe(original.discountTotalAmount);
    });

    it("restores taxTotal exactly", () => {
      const { original, json } = createSerializedTotals();

      const restored = InvoiceTotals.fromJSON(json);

      expect(restored.taxTotalAmount).toBe(original.taxTotalAmount);
    });

    it("restores withholdingTotal exactly", () => {
      const { original, json } = createSerializedTotals();

      const restored = InvoiceTotals.fromJSON(json);

      expect(restored.withholdingTotalAmount).toBe(
        original.withholdingTotalAmount,
      );
    });

    it("restores grandTotal exactly", () => {
      const { original, json } = createSerializedTotals();

      const restored = InvoiceTotals.fromJSON(json);

      expect(restored.grandTotalAmount).toBe(original.grandTotalAmount);
    });

    it("restores netPayable exactly", () => {
      const { original, json } = createSerializedTotals();

      const restored = InvoiceTotals.fromJSON(json);

      expect(restored.netPayableAmount).toBe(original.netPayableAmount);
    });

    it("preserves currency through serialization", () => {
      const original = InvoiceTotals.fromLineItems(
        [makeLineItem(100, 0, 0, 0, 100, 100, "USD")],
        "USD",
      );

      const restored = InvoiceTotals.fromJSON(original.toJSON());

      expect(restored.subtotal.currency.code).toBe("USD");
      expect(restored.grandTotal.currency.code).toBe("USD");
      expect(restored.netPayable.currency.code).toBe("USD");
    });

    it("supports a complete serialization round trip", () => {
      const { original } = createSerializedTotals();

      const serialized = original.toJSON();

      const restored = InvoiceTotals.fromJSON(serialized);

      expect(restored.toJSON()).toEqual(serialized);
    });

    it("supports a JSON.stringify + JSON.parse round trip", () => {
      const { original } = createSerializedTotals();

      const serializedString = JSON.stringify(original.toJSON());

      const parsed = JSON.parse(serializedString) as InvoiceTotalsJSON;

      const restored = InvoiceTotals.fromJSON(parsed);

      expect(restored.subtotalAmount).toBe(original.subtotalAmount);

      expect(restored.discountTotalAmount).toBe(original.discountTotalAmount);

      expect(restored.taxTotalAmount).toBe(original.taxTotalAmount);

      expect(restored.withholdingTotalAmount).toBe(
        original.withholdingTotalAmount,
      );

      expect(restored.grandTotalAmount).toBe(original.grandTotalAmount);

      expect(restored.netPayableAmount).toBe(original.netPayableAmount);
    });

    it("does not trust values outside the serialized monetary fields", () => {
      const { original, json } = createSerializedTotals();

      const restored = InvoiceTotals.fromJSON(json);

      expect(restored.grandTotalAmount).toBe(original.grandTotalAmount);

      expect(restored.netPayableAmount).toBe(original.netPayableAmount);
    });

    describe("invalid serialized input", () => {
      it("throws when json is undefined", () => {
        expect(() => InvoiceTotals.fromJSON(undefined as never)).toThrow();
      });

      it("throws when json is null", () => {
        expect(() => InvoiceTotals.fromJSON(null as never)).toThrow();
      });

      it("throws when json is a primitive", () => {
        expect(() => InvoiceTotals.fromJSON("invalid" as never)).toThrow();
      });

      it("throws when a required monetary field is missing", () => {
        const { json } = createSerializedTotals();

        const invalid = {
          ...json,
        };

        delete (invalid as Partial<InvoiceTotalsJSON>).subtotal;

        expect(() =>
          InvoiceTotals.fromJSON(invalid as InvoiceTotalsJSON),
        ).toThrow();
      });

      it("throws when a serialized monetary value is invalid", () => {
        const { json } = createSerializedTotals();

        const invalid = {
          ...json,
          grandTotal: null,
        };

        expect(() => InvoiceTotals.fromJSON(invalid as never)).toThrow();
      });

      it("throws when a serialized monetary value is malformed", () => {
        const { json } = createSerializedTotals();

        const invalid = {
          ...json,
          grandTotal: "not-money",
        };

        expect(() => InvoiceTotals.fromJSON(invalid as never)).toThrow(
          'InvoiceTotals JSON field "grandTotal" is invalid',
        );
      });
    });
  });

  // ===========================================================================
  // Immutability
  // ===========================================================================

  describe("Immutability", () => {
    it("freezes each created instance", () => {
      const totals = InvoiceTotals.fromLineItems([], "PHP");

      expect(Object.isFrozen(totals)).toBe(true);
    });

    it("freezes the static class", () => {
      expect(Object.isFrozen(InvoiceTotals)).toBe(true);
    });

    it("freezes the prototype", () => {
      expect(Object.isFrozen(InvoiceTotals.prototype)).toBe(true);
    });

    it("prevents mutation of subtotal", () => {
      const totals = InvoiceTotals.fromLineItems([], "PHP");

      expect(() => {
        (
          totals as InvoiceTotals & {
            subtotal: MajikMoney;
          }
        ).subtotal = MajikMoney.fromMajor(1000, "PHP");
      }).toThrow();
    });

    it("prevents mutation of discountTotal", () => {
      const totals = InvoiceTotals.fromLineItems([], "PHP");

      expect(() => {
        (
          totals as InvoiceTotals & {
            discountTotal: MajikMoney;
          }
        ).discountTotal = MajikMoney.fromMajor(100, "PHP");
      }).toThrow();
    });

    it("prevents mutation of taxTotal", () => {
      const totals = InvoiceTotals.fromLineItems([], "PHP");

      expect(() => {
        (
          totals as InvoiceTotals & {
            taxTotal: MajikMoney;
          }
        ).taxTotal = MajikMoney.fromMajor(100, "PHP");
      }).toThrow();
    });

    it("prevents mutation of withholdingTotal", () => {
      const totals = InvoiceTotals.fromLineItems([], "PHP");

      expect(() => {
        (
          totals as InvoiceTotals & {
            withholdingTotal: MajikMoney;
          }
        ).withholdingTotal = MajikMoney.fromMajor(100, "PHP");
      }).toThrow();
    });

    it("prevents mutation of grandTotal", () => {
      const totals = InvoiceTotals.fromLineItems([], "PHP");

      expect(() => {
        (
          totals as InvoiceTotals & {
            grandTotal: MajikMoney;
          }
        ).grandTotal = MajikMoney.fromMajor(100, "PHP");
      }).toThrow();
    });

    it("prevents mutation of netPayable", () => {
      const totals = InvoiceTotals.fromLineItems([], "PHP");

      expect(() => {
        (
          totals as InvoiceTotals & {
            netPayable: MajikMoney;
          }
        ).netPayable = MajikMoney.fromMajor(100, "PHP");
      }).toThrow();
    });

    it("remains unchanged after reading all derived getters", () => {
      const totals = InvoiceTotals.fromLineItems(
        [makeLineItem(1000, 100, 108, 50, 1008, 958)],
        "PHP",
      );

      const snapshot = totals.toJSON();

      void totals.subtotalAmount;
      void totals.discountTotalAmount;
      void totals.taxTotalAmount;
      void totals.withholdingTotalAmount;
      void totals.grandTotalAmount;
      void totals.netPayableAmount;
      void totals.effectiveDiscountRate;
      void totals.effectiveTaxRate;
      void totals.hasDiscount;
      void totals.hasTax;
      void totals.hasWithholding;

      expect(totals.toJSON()).toEqual(snapshot);
    });
  });

  // ===========================================================================
  // Precision / Monetary Behaviour
  // ===========================================================================

  describe("Monetary Precision", () => {
    it("preserves currency-rounded line values during aggregation", () => {
      const item1 = makeLineItem(
        1000.12,
        100.11,
        108.01,
        50.01,
        1008.02,
        958.01,
      );

      const item2 = makeLineItem(
        2000.34,
        200.22,
        216.03,
        100.02,
        2016.15,
        1916.13,
      );

      const totals = InvoiceTotals.fromLineItems([item1, item2], "PHP");

      expect(totals.subtotalAmount).toBe(3000.46);

      expect(totals.discountTotalAmount).toBe(300.33);

      expect(totals.taxTotalAmount).toBe(324.04);

      expect(totals.withholdingTotalAmount).toBe(150.03);

      expect(totals.grandTotalAmount).toBe(3024.17);

      expect(totals.netPayableAmount).toBe(2874.14);
    });

    it("does not rely on floating-point arithmetic for aggregate sums", () => {
      const item1 = makeLineItem(0.1, 0, 0, 0, 0.1, 0.1);

      const item2 = makeLineItem(0.2, 0, 0, 0, 0.2, 0.2);

      const totals = InvoiceTotals.fromLineItems([item1, item2], "PHP");

      expect(totals.subtotalAmount).toBe(0.3);

      expect(totals.grandTotalAmount).toBe(0.3);

      expect(totals.netPayableAmount).toBe(0.3);
    });
  });
});
