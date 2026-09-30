import { describe, it, expect } from "vitest";
import {
  LineItem,
  LineItemValidationError,
} from "../src/core/general-invoice/line-item";
import { TaxManager } from "../src/core/general-invoice/tax-manager";
import type {
  LineItemInput,
  LineItemJSON,
  TaxDetail,
} from "../src/core/general-invoice/types";

describe("LineItem", () => {
  // ===========================================================================
  // Fixtures & Helpers
  // ===========================================================================

  const makeInput = (
    overrides: Partial<LineItemInput> = {},
  ): LineItemInput => ({
    description: "Web Development Services",
    quantity: 10,
    unitPrice: 100,
    ...overrides,
  });

  const makeVat = (overrides: Partial<TaxDetail> = {}): TaxDetail => ({
    taxType: "VAT",
    rate: 0.12,
    behaviour: "additive",
    ...overrides,
  });

  const makeEwt = (overrides: Partial<TaxDetail> = {}): TaxDetail => ({
    taxType: "EWT",
    rate: 0.05,
    behaviour: "withholding",
    ...overrides,
  });

  const makeInformational = (
    overrides: Partial<TaxDetail> = {},
  ): TaxDetail => ({
    taxType: "EXEMPT",
    rate: 0,
    behaviour: "informational",
    ...overrides,
  });

  const expectValidationError = (
    fn: () => unknown,
    message?: string | RegExp,
    field?: string,
  ): LineItemValidationError => {
    let thrown: unknown;

    try {
      fn();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LineItemValidationError);

    const validationError = thrown as LineItemValidationError;

    if (message !== undefined) {
      if (typeof message === "string") {
        expect(validationError.message).toContain(message);
      } else {
        expect(validationError.message).toMatch(message);
      }
    }

    if (field !== undefined) {
      expect(validationError.field).toBe(field);
    }

    return validationError;
  };

  const expectNoValidationError = (fn: () => unknown): void => {
    expect(fn).not.toThrowError(LineItemValidationError);
  };

  // ===========================================================================
  // LineItemValidationError
  // ===========================================================================

  describe("LineItemValidationError", () => {
    it("extends Error correctly", () => {
      const error = new LineItemValidationError("Invalid value", "quantity");

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(LineItemValidationError);
    });

    it("sets the correct name", () => {
      const error = new LineItemValidationError("Invalid value");

      expect(error.name).toBe("LineItemValidationError");
    });

    it("preserves the message", () => {
      const error = new LineItemValidationError("Invalid quantity", "quantity");

      expect(error.message).toBe("Invalid quantity");
    });

    it("preserves the field path", () => {
      const error = new LineItemValidationError("Invalid quantity", "quantity");

      expect(error.field).toBe("quantity");
    });

    it("allows the field to be omitted", () => {
      const error = new LineItemValidationError("Invalid value");

      expect(error.field).toBeUndefined();
    });
  });

  // ===========================================================================
  // Static API: validate()
  // ===========================================================================

  describe("validate()", () => {
    // -------------------------------------------------------------------------
    // Valid input
    // -------------------------------------------------------------------------

    describe("valid input", () => {
      it("accepts a minimal valid line item", () => {
        expect(() => LineItem.validate(makeInput())).not.toThrow();
      });

      it("returns undefined for valid input", () => {
        expect(LineItem.validate(makeInput())).toBeUndefined();
      });

      it("accepts fractional quantity", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              quantity: 0.5,
            }),
          ),
        ).not.toThrow();
      });

      it("accepts zero unit price", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              unitPrice: 0,
            }),
          ),
        ).not.toThrow();
      });

      it("accepts zero-value percentage discount", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              discount: {
                type: "percentage",
                value: 0,
              },
            }),
          ),
        ).not.toThrow();
      });

      it("accepts 100% percentage discount", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              discount: {
                type: "percentage",
                value: 1,
              },
            }),
          ),
        ).not.toThrow();
      });

      it("accepts a fixed discount of zero", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              discount: {
                type: "fixed",
                value: 0,
              },
            }),
          ),
        ).not.toThrow();
      });

      it("accepts valid taxes", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              taxes: [makeVat(), makeEwt(), makeInformational()],
            }),
          ),
        ).not.toThrow();
      });
    });

    // -------------------------------------------------------------------------
    // Description
    // -------------------------------------------------------------------------

    describe("description validation", () => {
      it.each([
        ["empty string", ""],
        ["whitespace", "   "],
        ["tabs", "\t\t"],
        ["newlines", "\n\n"],
        ["mixed whitespace", " \t\n "],
        ["null", null],
        ["undefined", undefined],
      ])("rejects %s", (_label, description) => {
        expectValidationError(
          () =>
            LineItem.validate(
              makeInput({
                description: description as never,
              }),
            ),
          /description is required/,
          "description",
        );
      });

      it("accepts descriptions containing internal whitespace", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              description: "Web   Development Services",
            }),
          ),
        ).not.toThrow();
      });
    });

    // -------------------------------------------------------------------------
    // Quantity
    // -------------------------------------------------------------------------

    describe("quantity validation", () => {
      it.each([
        ["string", "10"],
        ["null", null],
        ["undefined", undefined],
        ["boolean", true],
        ["object", {}],
        ["array", []],
      ])("rejects non-number quantity: %s", (_label, quantity) => {
        expectValidationError(
          () =>
            LineItem.validate(
              makeInput({
                quantity: quantity as never,
              }),
            ),
          /quantity must be a finite number/,
          "quantity",
        );
      });

      it.each([
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["-Infinity", Number.NEGATIVE_INFINITY],
      ])("rejects non-finite quantity: %s", (_label, quantity) => {
        expectValidationError(
          () =>
            LineItem.validate(
              makeInput({
                quantity,
              }),
            ),
          /quantity must be a finite number/,
          "quantity",
        );
      });

      it.each([
        ["zero", 0],
        ["negative one", -1],
        ["negative decimal", -0.01],
        ["large negative", -1000],
      ])("rejects non-positive quantity: %s", (_label, quantity) => {
        expectValidationError(
          () =>
            LineItem.validate(
              makeInput({
                quantity,
              }),
            ),
          /quantity must be greater than zero/,
          "quantity",
        );
      });

      it("accepts the smallest positive finite number", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              quantity: Number.MIN_VALUE,
            }),
          ),
        ).not.toThrow();
      });

      it("accepts fractional quantities", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              quantity: 1.25,
            }),
          ),
        ).not.toThrow();
      });
    });

    // -------------------------------------------------------------------------
    // Unit price
    // -------------------------------------------------------------------------

    describe("unitPrice validation", () => {
      it.each([
        ["string", "100"],
        ["null", null],
        ["undefined", undefined],
        ["boolean", true],
        ["object", {}],
        ["array", []],
      ])("rejects non-number unitPrice: %s", (_label, unitPrice) => {
        expectValidationError(
          () =>
            LineItem.validate(
              makeInput({
                unitPrice: unitPrice as never,
              }),
            ),
          /unitPrice must be a finite number/,
          "unitPrice",
        );
      });

      it.each([
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["-Infinity", Number.NEGATIVE_INFINITY],
      ])("rejects non-finite unitPrice: %s", (_label, unitPrice) => {
        expectValidationError(
          () =>
            LineItem.validate(
              makeInput({
                unitPrice,
              }),
            ),
          /unitPrice must be a finite number/,
          "unitPrice",
        );
      });

      it.each([
        ["negative decimal", -0.01],
        ["negative one", -1],
        ["large negative", -1000],
      ])("rejects negative unitPrice: %s", (_label, unitPrice) => {
        expectValidationError(
          () =>
            LineItem.validate(
              makeInput({
                unitPrice,
              }),
            ),
          /unitPrice cannot be negative/,
          "unitPrice",
        );
      });

      it("accepts zero", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              unitPrice: 0,
            }),
          ),
        ).not.toThrow();
      });

      it("accepts positive fractional values", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              unitPrice: 0.01,
            }),
          ),
        ).not.toThrow();
      });
    });

    // -------------------------------------------------------------------------
    // Discounts
    // -------------------------------------------------------------------------

    describe("discount validation", () => {
      describe("discount value type", () => {
        it.each([
          ["string", "10"],
          ["null", null],
          ["undefined", undefined],
          ["boolean", true],
          ["object", {}],
          ["array", []],
        ])("rejects non-number discount value: %s", (_label, value) => {
          expectValidationError(
            () =>
              LineItem.validate(
                makeInput({
                  discount: {
                    type: "fixed",
                    value: value as never,
                  },
                }),
              ),
            /Discount value must be a finite number/,
            "discount.value",
          );
        });
      });

      describe("discount value finiteness", () => {
        it.each([
          ["NaN", Number.NaN],
          ["Infinity", Number.POSITIVE_INFINITY],
          ["-Infinity", Number.NEGATIVE_INFINITY],
        ])("rejects %s", (_label, value) => {
          expectValidationError(
            () =>
              LineItem.validate(
                makeInput({
                  discount: {
                    type: "fixed",
                    value,
                  },
                }),
              ),
            /Discount value must be a finite number/,
            "discount.value",
          );
        });
      });

      describe("discount sign", () => {
        it.each([
          ["negative decimal", -0.01],
          ["negative one", -1],
          ["large negative", -1000],
        ])("rejects %s", (_label, value) => {
          expectValidationError(
            () =>
              LineItem.validate(
                makeInput({
                  discount: {
                    type: "fixed",
                    value,
                  },
                }),
              ),
            /Discount value cannot be negative/,
            "discount.value",
          );
        });
      });

      describe("percentage discounts", () => {
        it.each([
          ["zero", 0],
          ["small positive", 0.01],
          ["50%", 0.5],
          ["100%", 1],
        ])("accepts %s", (_label, value) => {
          expect(() =>
            LineItem.validate(
              makeInput({
                discount: {
                  type: "percentage",
                  value,
                },
              }),
            ),
          ).not.toThrow();
        });

        it.each([
          ["slightly above 100%", 1.000001],
          ["105%", 1.05],
          ["200%", 2],
        ])("rejects %s", (_label, value) => {
          expectValidationError(
            () =>
              LineItem.validate(
                makeInput({
                  discount: {
                    type: "percentage",
                    value,
                  },
                }),
              ),
            /Percentage discount must be between 0 and 1/,
            "discount.value",
          );
        });
      });

      describe("fixed discounts", () => {
        it("accepts zero", () => {
          expect(() =>
            LineItem.validate(
              makeInput({
                discount: {
                  type: "fixed",
                  value: 0,
                },
              }),
            ),
          ).not.toThrow();
        });

        it("accepts a positive amount", () => {
          expect(() =>
            LineItem.validate(
              makeInput({
                discount: {
                  type: "fixed",
                  value: 50,
                },
              }),
            ),
          ).not.toThrow();
        });
      });
    });

    // -------------------------------------------------------------------------
    // Tax validation delegation
    // -------------------------------------------------------------------------

    describe("tax validation", () => {
      it("rejects invalid taxes through TaxManager validation", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              taxes: [
                makeVat({
                  rate: 1.5,
                }),
              ],
            }),
          ),
        ).toThrow();
      });

      it("rejects duplicate tax types", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              taxes: [
                makeVat(),
                makeVat({
                  rate: 0.05,
                }),
              ],
            }),
          ),
        ).toThrow(/Duplicate tax type/);
      });

      it("rejects inclusive withholding tax", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              taxes: [
                makeEwt({
                  inclusive: true,
                }),
              ],
            }),
          ),
        ).toThrow(/Withholding taxes cannot be inclusive/);
      });

      it("rejects multiple inclusive additive taxes", () => {
        expect(() =>
          LineItem.validate(
            makeInput({
              taxes: [
                makeVat({
                  taxType: "VAT",
                  inclusive: true,
                }),
                makeVat({
                  taxType: "LOCAL",
                  rate: 0.05,
                  inclusive: true,
                }),
              ],
            }),
          ),
        ).toThrow(/At most one inclusive additive tax is allowed/);
      });
    });
  });

  // ===========================================================================
  // Static API: create()
  // ===========================================================================

  describe("create()", () => {
    describe("construction", () => {
      it("creates a LineItem instance", () => {
        const item = LineItem.create(makeInput(), "PHP");

        expect(item).toBeInstanceOf(LineItem);
      });

      it("generates an ID when none is supplied", () => {
        const item = LineItem.create(makeInput(), "PHP");

        expect(item.id).toBeDefined();
        expect(typeof item.id).toBe("string");
        expect(item.id.length).toBeGreaterThan(0);
      });

      it("generates distinct IDs for separate items", () => {
        const first = LineItem.create(makeInput(), "PHP");
        const second = LineItem.create(makeInput(), "PHP");

        expect(first.id).not.toBe(second.id);
      });

      it("preserves an explicit ID", () => {
        const item = LineItem.create(
          makeInput({
            id: "item-123",
          }),
          "PHP",
        );

        expect(item.id).toBe("item-123");
      });

      it("preserves an explicit empty-string ID because the fallback is nullish", () => {
        const item = LineItem.create(
          makeInput({
            id: "",
          }),
          "PHP",
        );

        expect(item.id).toBe("");
      });

      it("trims leading and trailing description whitespace", () => {
        const input = makeInput({
          description: "  Consulting Fee  ",
        });

        const item = LineItem.create(input, "PHP");

        expect(item.description).toBe("Consulting Fee");
      });

      it("does not mutate the source description", () => {
        const input = makeInput({
          description: "  Consulting Fee  ",
        });

        LineItem.create(input, "PHP");

        expect(input.description).toBe("  Consulting Fee  ");
      });
    });

    describe("optional properties", () => {
      it("preserves skuId", () => {
        const item = LineItem.create(
          makeInput({
            skuId: "SKU-001",
          }),
          "PHP",
        );

        expect(item.skuId).toBe("SKU-001");
      });

      it("preserves unit", () => {
        const item = LineItem.create(
          makeInput({
            unit: "hour",
          }),
          "PHP",
        );

        expect(item.unit).toBe("hour");
      });

      it("preserves accountCode", () => {
        const item = LineItem.create(
          makeInput({
            accountCode: "4000",
          }),
          "PHP",
        );

        expect(item.accountCode).toBe("4000");
      });

      it("preserves costCenter", () => {
        const item = LineItem.create(
          makeInput({
            costCenter: "CC-10",
          }),
          "PHP",
        );

        expect(item.costCenter).toBe("CC-10");
      });

      it("preserves tags", () => {
        const tags = ["service", "technology"];

        const item = LineItem.create(makeInput({ tags }), "PHP");

        expect(item.tags).toEqual(tags);
      });

      it("preserves metadata", () => {
        const metadata = {
          project: "alpha",
          clientId: 123,
        };

        const item = LineItem.create(makeInput({ metadata }), "PHP");

        expect(item.metadata).toEqual(metadata);
      });
    });

    describe("invalid input", () => {
      it("rejects invalid description", () => {
        expectValidationError(
          () =>
            LineItem.create(
              makeInput({
                description: "",
              }),
              "PHP",
            ),
          /description is required/,
          "description",
        );
      });

      it("rejects invalid quantity", () => {
        expectValidationError(
          () =>
            LineItem.create(
              makeInput({
                quantity: 0,
              }),
              "PHP",
            ),
          /quantity must be greater than zero/,
          "quantity",
        );
      });

      it("rejects invalid unit price", () => {
        expectValidationError(
          () =>
            LineItem.create(
              makeInput({
                unitPrice: -1,
              }),
              "PHP",
            ),
          /unitPrice cannot be negative/,
          "unitPrice",
        );
      });

      it("rejects a fixed discount larger than the line total", () => {
        expectValidationError(
          () =>
            LineItem.create(
              makeInput({
                quantity: 2,
                unitPrice: 100,
                discount: {
                  type: "fixed",
                  value: 250,
                },
              }),
              "PHP",
            ),
          /Discount cannot exceed line total/,
          "discount.value",
        );
      });

      it("accepts a fixed discount exactly equal to the line total", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 2,
            unitPrice: 100,
            discount: {
              type: "fixed",
              value: 200,
            },
          }),
          "PHP",
        );

        expect(item.discountAmountValue).toBe(200);
        expect(item.netTotalAmount).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Monetary Calculations
  // ===========================================================================

  describe("Monetary Calculations", () => {
    describe("line total", () => {
      it("calculates unit price × quantity", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 5,
            unitPrice: 200,
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(1000);
      });

      it("supports fractional quantities", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 2.5,
            unitPrice: 200,
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(500);
      });

      it("produces zero line total when unit price is zero", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 10,
            unitPrice: 0,
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(0);
      });
    });

    describe("without discount or taxes", () => {
      it("returns the gross amount as net total", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 5,
            unitPrice: 200,
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(1000);
        expect(item.discountAmountValue).toBe(0);
        expect(item.additiveTaxAmountValue).toBe(0);
        expect(item.withholdingTaxAmountValue).toBe(0);
        expect(item.taxAmountValue).toBe(0);
        expect(item.netTotalAmount).toBe(1000);
        expect(item.netPayableAmount).toBe(1000);
      });
    });

    describe("percentage discount", () => {
      it("applies a percentage discount to the line total", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 10,
            unitPrice: 100,
            discount: {
              type: "percentage",
              value: 0.15,
            },
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(1000);
        expect(item.discountAmountValue).toBe(150);
        expect(item.netTotalAmount).toBe(850);
      });

      it("supports a zero percent discount", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 10,
            unitPrice: 100,
            discount: {
              type: "percentage",
              value: 0,
            },
          }),
          "PHP",
        );

        expect(item.discountAmountValue).toBe(0);
        expect(item.netTotalAmount).toBe(1000);
      });

      it("supports a 100% discount", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 10,
            unitPrice: 100,
            discount: {
              type: "percentage",
              value: 1,
            },
          }),
          "PHP",
        );

        expect(item.discountAmountValue).toBe(1000);
        expect(item.netTotalAmount).toBe(0);
      });
    });

    describe("fixed discount", () => {
      it("subtracts a fixed discount from the line total", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 2,
            unitPrice: 500,
            discount: {
              type: "fixed",
              value: 200,
            },
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(1000);
        expect(item.discountAmountValue).toBe(200);
        expect(item.netTotalAmount).toBe(800);
      });

      it("supports a zero fixed discount", () => {
        const item = LineItem.create(
          makeInput({
            discount: {
              type: "fixed",
              value: 0,
            },
          }),
          "PHP",
        );

        expect(item.discountAmountValue).toBe(0);
        expect(item.netTotalAmount).toBe(1000);
      });
    });
  });

  // ===========================================================================
  // Additive Tax Calculations
  // ===========================================================================

  describe("Additive Tax Calculations", () => {
    describe("exclusive additive taxes", () => {
      it("calculates exclusive VAT against the post-discount amount", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1000,
            discount: {
              type: "fixed",
              value: 100,
            },
            taxes: [
              makeVat({
                inclusive: false,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(1000);
        expect(item.discountAmountValue).toBe(100);
        expect(item.additiveTaxAmountValue).toBe(108);
        expect(item.taxAmountValue).toBe(108);
        expect(item.netTotalAmount).toBe(1008);
        expect(item.netPayableAmount).toBe(1008);
      });

      it("calculates exclusive tax when there is no discount", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1000,
            taxes: [
              makeVat({
                inclusive: false,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.additiveTaxAmountValue).toBe(120);
        expect(item.netTotalAmount).toBe(1120);
      });

      it("handles a zero-rate additive tax", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1000,
            taxes: [
              makeVat({
                rate: 0,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.additiveTaxAmountValue).toBe(0);
        expect(item.netTotalAmount).toBe(1000);
      });

      it("calculates multiple exclusive additive taxes", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1000,
            taxes: [
              makeVat({
                taxType: "VAT",
                rate: 0.12,
              }),
              makeVat({
                taxType: "LOCAL",
                rate: 0.05,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.additiveTaxAmountValue).toBe(170);
        expect(item.netTotalAmount).toBe(1170);
      });
    });

    describe("inclusive additive taxes", () => {
      it("extracts inclusive VAT from the line amount", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1120,
            taxes: [
              makeVat({
                inclusive: true,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(1120);
        expect(item.additiveTaxAmountValue).toBe(120);
        expect(item.netTotalAmount).toBe(1120);
        expect(item.netPayableAmount).toBe(1120);
      });

      it("does not double-count inclusive tax in net total", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1120,
            taxes: [
              makeVat({
                inclusive: true,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.netTotalAmount).toBe(1120);
        expect(item.netTotalAmount).not.toBe(1240);
      });

      it("extracts inclusive tax after discount", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1120,
            discount: {
              type: "fixed",
              value: 120,
            },
            taxes: [
              makeVat({
                inclusive: true,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(1120);
        expect(item.discountAmountValue).toBe(120);

        // postDiscount = 1000
        // embedded VAT = 1000 - (1000 / 1.12)
        expect(item.additiveTaxAmountValue).toBe(107.14);

        expect(item.netTotalAmount).toBe(1000);
      });
    });

    describe("tax breakdowns", () => {
      it("stores additive tax amounts by tax type", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1000,
            taxes: [
              makeVat({
                taxType: "VAT",
                rate: 0.12,
              }),
              makeVat({
                taxType: "LOCAL",
                rate: 0.05,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.additiveTaxBreakdown.get("VAT")?.toMajor()).toBe(120);
        expect(item.additiveTaxBreakdown.get("LOCAL")?.toMajor()).toBe(50);
      });

      it("does not include withholding taxes in additive breakdown", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeVat(), makeEwt()],
          }),
          "PHP",
        );

        expect(item.additiveTaxBreakdown.has("EWT")).toBe(false);
      });

      it("taxAmount is the same monetary value as additiveTaxAmount", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeVat()],
          }),
          "PHP",
        );

        expect(item.taxAmount).toBe(item.additiveTaxAmount);
      });

      it("taxAmountValue is an alias of additiveTaxAmountValue", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeVat()],
          }),
          "PHP",
        );

        expect(item.taxAmountValue).toBe(item.additiveTaxAmountValue);
      });
    });
  });

  // ===========================================================================
  // Withholding Tax Calculations
  // ===========================================================================

  describe("Withholding Tax Calculations", () => {
    it("calculates withholding tax against the post-discount base", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeEwt({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.withholdingTaxAmountValue).toBe(50);
      expect(item.netTotalAmount).toBe(1000);
      expect(item.netPayableAmount).toBe(950);
    });

    it("withholding does not increase netTotal", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeEwt({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.netTotalAmount).toBe(1000);
      expect(item.netTotalAmount).not.toBe(1050);
    });

    it("reduces netPayable by the withholding amount", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeEwt({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.withholdingTaxAmountValue).toBe(50);
      expect(item.netPayableAmount).toBe(950);
    });

    it("removes inclusive VAT from the withholding base", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1120,
          taxes: [
            makeVat({
              inclusive: true,
            }),
            makeEwt({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.additiveTaxAmountValue).toBe(120);
      expect(item.withholdingTaxAmountValue).toBe(50);
      expect(item.netTotalAmount).toBe(1120);
      expect(item.netPayableAmount).toBe(1070);
    });

    it("calculates withholding after percentage discounts", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          discount: {
            type: "percentage",
            value: 0.1,
          },
          taxes: [
            makeEwt({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
      );

      // postDiscount = 900
      // EWT = 45
      expect(item.discountAmountValue).toBe(100);
      expect(item.withholdingTaxAmountValue).toBe(45);
      expect(item.netTotalAmount).toBe(900);
      expect(item.netPayableAmount).toBe(855);
    });

    it("supports multiple withholding taxes", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeEwt({
              taxType: "EWT",
              rate: 0.05,
            }),
            makeEwt({
              taxType: "WHT",
              rate: 0.02,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.withholdingTaxAmountValue).toBe(70);
      expect(item.netTotalAmount).toBe(1000);
      expect(item.netPayableAmount).toBe(930);
    });

    it("stores withholding amounts by tax type", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeEwt({
              taxType: "EWT",
              rate: 0.05,
            }),
            makeEwt({
              taxType: "WHT",
              rate: 0.02,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.withholdingTaxBreakdown.get("EWT")?.toMajor()).toBe(50);

      expect(item.withholdingTaxBreakdown.get("WHT")?.toMajor()).toBe(20);
    });

    it("does not include additive taxes in withholding breakdown", () => {
      const item = LineItem.create(
        makeInput({
          taxes: [makeVat(), makeEwt()],
        }),
        "PHP",
      );

      expect(item.withholdingTaxBreakdown.has("VAT")).toBe(false);
    });
  });

  // ===========================================================================
  // Combined Calculation Scenarios
  // ===========================================================================

  describe("Combined Calculation Scenarios", () => {
    it("calculates discount + exclusive VAT", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          discount: {
            type: "fixed",
            value: 100,
          },
          taxes: [
            makeVat({
              inclusive: false,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.lineTotalAmount).toBe(1000);
      expect(item.discountAmountValue).toBe(100);
      expect(item.additiveTaxAmountValue).toBe(108);
      expect(item.netTotalAmount).toBe(1008);
      expect(item.netPayableAmount).toBe(1008);
    });

    it("calculates discount + inclusive VAT", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1120,
          discount: {
            type: "fixed",
            value: 120,
          },
          taxes: [
            makeVat({
              inclusive: true,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.lineTotalAmount).toBe(1120);
      expect(item.discountAmountValue).toBe(120);
      expect(item.netTotalAmount).toBe(1000);
      expect(item.additiveTaxAmountValue).toBe(107.14);
    });

    it("calculates inclusive VAT + EWT", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1120,
          taxes: [
            makeVat({
              inclusive: true,
            }),
            makeEwt({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.additiveTaxAmountValue).toBe(120);
      expect(item.withholdingTaxAmountValue).toBe(50);
      expect(item.netTotalAmount).toBe(1120);
      expect(item.netPayableAmount).toBe(1070);
    });

    it("calculates discount + inclusive VAT + EWT", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 2,
          unitPrice: 1000,
          discount: {
            type: "percentage",
            value: 0.1,
          },
          taxes: [
            makeVat({
              inclusive: true,
            }),
            makeEwt({
              rate: 0.02,
            }),
          ],
        }),
        "PHP",
      );

      // lineTotal = 2000
      // discount = 200
      // postDiscount = 1800
      // VAT = 1800 - (1800 / 1.12) ≈ 192.857143
      // withholding base ≈ 1607.142857
      // EWT ≈ 32.142857
      // netPayable ≈ 1767.857143

      expect(item.lineTotalAmount).toBe(2000);
      expect(item.discountAmountValue).toBe(200);

      expect(item.additiveTaxAmountValue).toBe(192.86);

      expect(item.withholdingTaxAmountValue).toBe(32.14);

      expect(item.netTotalAmount).toBe(1800);

      expect(item.netPayableAmount).toBe(1767.86);
    });

    it("handles informational taxes without affecting totals", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeInformational({
              taxType: "EXEMPT",
            }),
          ],
        }),
        "PHP",
      );

      expect(item.additiveTaxAmountValue).toBe(0);
      expect(item.withholdingTaxAmountValue).toBe(0);
      expect(item.netTotalAmount).toBe(1000);
      expect(item.netPayableAmount).toBe(1000);
    });

    it("handles withholding-only taxation", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeEwt({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.additiveTaxAmountValue).toBe(0);
      expect(item.withholdingTaxAmountValue).toBe(50);
      expect(item.netTotalAmount).toBe(1000);
      expect(item.netPayableAmount).toBe(950);
    });
  });

  // ===========================================================================
  // Tax Inheritance
  // ===========================================================================

  describe("Tax Inheritance", () => {
    it("uses no taxes when neither own nor defaults exist", () => {
      const item = LineItem.create(makeInput(), "PHP");

      expect(item.taxes.isEmpty).toBe(true);
      expect(item.additiveTaxAmountValue).toBe(0);
    });

    it("inherits default taxes when own taxes are undefined", () => {
      const defaults = TaxManager.fromOne(
        makeVat({
          rate: 0.12,
        }),
      );

      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
        }),
        "PHP",
        defaults,
      );

      expect(item.taxes).toBe(defaults);
      expect(item.taxes.getByType("VAT")?.rate).toBe(0.12);
      expect(item.additiveTaxAmountValue).toBe(120);
    });

    it("inherits default taxes when own taxes are an empty array", () => {
      const defaults = TaxManager.fromOne(
        makeVat({
          rate: 0.12,
        }),
      );

      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [],
        }),
        "PHP",
        defaults,
      );

      expect(item.taxes).toBe(defaults);
      expect(item.additiveTaxAmountValue).toBe(120);
    });

    it("prefers explicit own taxes over default taxes", () => {
      const defaults = TaxManager.fromOne(
        makeVat({
          rate: 0.12,
        }),
      );

      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeVat({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
        defaults,
      );

      expect(item.taxes).not.toBe(defaults);
      expect(item.taxes.getByType("VAT")?.rate).toBe(0.05);
      expect(item.additiveTaxAmountValue).toBe(50);
    });

    it("does not inherit defaults when own taxes are present", () => {
      const defaults = TaxManager.fromMany([
        makeVat({
          rate: 0.12,
        }),
        makeEwt({
          rate: 0.05,
        }),
      ]);

      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeVat({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
        defaults,
      );

      expect(item.taxes.taxTypes).toEqual(["VAT"]);
      expect(item.taxes.hasTaxType("EWT")).toBe(false);
    });
  });

  // ===========================================================================
  // Getters & Indicators
  // ===========================================================================

  describe("Getters & Indicators", () => {
    describe("lineTotalAmount", () => {
      it("returns lineTotal in major currency units", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 3,
            unitPrice: 125,
          }),
          "PHP",
        );

        expect(item.lineTotalAmount).toBe(375);
      });
    });

    describe("discountAmountValue", () => {
      it("returns zero without a discount", () => {
        const item = LineItem.create(makeInput(), "PHP");

        expect(item.discountAmountValue).toBe(0);
      });

      it("returns the computed discount", () => {
        const item = LineItem.create(
          makeInput({
            discount: {
              type: "percentage",
              value: 0.1,
            },
          }),
          "PHP",
        );

        expect(item.discountAmountValue).toBe(100);
      });
    });

    describe("additiveTaxAmountValue", () => {
      it("returns zero without additive taxes", () => {
        const item = LineItem.create(makeInput(), "PHP");

        expect(item.additiveTaxAmountValue).toBe(0);
      });
    });

    describe("withholdingTaxAmountValue", () => {
      it("returns zero without withholding taxes", () => {
        const item = LineItem.create(makeInput(), "PHP");

        expect(item.withholdingTaxAmountValue).toBe(0);
      });
    });

    describe("netTotalAmount", () => {
      it("represents the invoice contribution before withholding", () => {
        const item = LineItem.create(
          makeInput({
            unitPrice: 1000,
            quantity: 1,
            taxes: [makeEwt()],
          }),
          "PHP",
        );

        expect(item.netTotalAmount).toBe(1000);
      });
    });

    describe("netPayableAmount", () => {
      it("represents the amount actually remitted after withholding", () => {
        const item = LineItem.create(
          makeInput({
            unitPrice: 1000,
            quantity: 1,
            taxes: [makeEwt()],
          }),
          "PHP",
        );

        expect(item.netPayableAmount).toBe(950);
      });
    });

    describe("nominalTaxRate", () => {
      it("returns zero when there are no additive taxes", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [
              makeEwt({
                rate: 0.05,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.nominalTaxRate).toBe(0);
      });

      it("sums additive tax rates", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [
              makeVat({
                taxType: "VAT",
                rate: 0.12,
              }),
              makeVat({
                taxType: "LOCAL",
                rate: 0.05,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.nominalTaxRate).toBeCloseTo(0.17, 10);
      });

      it("excludes withholding taxes", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [
              makeVat({
                rate: 0.12,
              }),
              makeEwt({
                rate: 0.05,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.nominalTaxRate).toBeCloseTo(0.12, 10);
      });

      it("treats omitted behaviour as additive", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [
              {
                taxType: "VAT",
                rate: 0.12,
              },
            ],
          }),
          "PHP",
        );

        expect(item.nominalTaxRate).toBeCloseTo(0.12, 10);
      });

      it("includes informational taxes in neither additive nor withholding totals", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [
              makeInformational({
                rate: 0.25,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.nominalTaxRate).toBe(0);
      });
    });

    describe("effectiveTaxRate", () => {
      it("matches the configured additive rate for one exclusive tax", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1000,
            taxes: [
              makeVat({
                rate: 0.12,
                inclusive: false,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.effectiveTaxRate).toBeCloseTo(0.12, 10);
      });

      it("reflects the actual inclusive tax ratio", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1120,
            taxes: [
              makeVat({
                rate: 0.12,
                inclusive: true,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.effectiveTaxRate).toBeCloseTo(120 / 1120, 10);
      });

      it("accounts for multiple additive taxes", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1000,
            taxes: [
              makeVat({
                taxType: "VAT",
                rate: 0.12,
              }),
              makeVat({
                taxType: "LOCAL",
                rate: 0.05,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.effectiveTaxRate).toBeCloseTo(0.17, 10);
      });
    });

    describe("isTaxable", () => {
      it("returns true when a positive-rate additive tax exists", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [
              makeVat({
                rate: 0.12,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.isTaxable).toBe(true);
      });

      it("returns false when only a zero-rate additive tax exists", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [
              makeVat({
                rate: 0,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.isTaxable).toBe(false);
      });

      it("returns false when only withholding taxes exist", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [
              makeEwt({
                rate: 0.05,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.isTaxable).toBe(false);
      });

      it("returns false when only informational taxes exist", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeInformational()],
          }),
          "PHP",
        );

        expect(item.isTaxable).toBe(false);
      });

      it("returns true when an additive tax exists alongside withholding", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeVat(), makeEwt()],
          }),
          "PHP",
        );

        expect(item.isTaxable).toBe(true);
      });
    });

    describe("hasDiscount", () => {
      it("returns false without a discount", () => {
        const item = LineItem.create(makeInput(), "PHP");

        expect(item.hasDiscount).toBe(false);
      });

      it("returns true with a percentage discount", () => {
        const item = LineItem.create(
          makeInput({
            discount: {
              type: "percentage",
              value: 0.1,
            },
          }),
          "PHP",
        );

        expect(item.hasDiscount).toBe(true);
      });

      it("returns true even for a zero-value discount because the object exists", () => {
        const item = LineItem.create(
          makeInput({
            discount: {
              type: "fixed",
              value: 0,
            },
          }),
          "PHP",
        );

        expect(item.hasDiscount).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // Tax lookup helpers
    // -------------------------------------------------------------------------

    describe("taxAmountByType()", () => {
      it("returns the additive amount for an existing tax", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1000,
            taxes: [
              makeVat({
                taxType: "VAT",
                rate: 0.12,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.taxAmountByType("VAT")).toBe(120);
      });

      it("returns zero for an unknown tax type", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeVat()],
          }),
          "PHP",
        );

        expect(item.taxAmountByType("GST")).toBe(0);
      });

      it("does not return withholding tax through additive lookup", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeEwt()],
          }),
          "PHP",
        );

        expect(item.taxAmountByType("EWT")).toBe(0);
      });

      it("uses exact tax type lookup", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeVat()],
          }),
          "PHP",
        );

        expect(item.taxAmountByType("vat")).toBe(0);
      });
    });

    describe("withholdingAmountByType()", () => {
      it("returns the withholding amount for an existing tax", () => {
        const item = LineItem.create(
          makeInput({
            quantity: 1,
            unitPrice: 1000,
            taxes: [
              makeEwt({
                taxType: "EWT",
                rate: 0.05,
              }),
            ],
          }),
          "PHP",
        );

        expect(item.withholdingAmountByType("EWT")).toBe(50);
      });

      it("returns zero for an unknown tax type", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeEwt()],
          }),
          "PHP",
        );

        expect(item.withholdingAmountByType("GST")).toBe(0);
      });

      it("does not return additive tax through withholding lookup", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeVat()],
          }),
          "PHP",
        );

        expect(item.withholdingAmountByType("VAT")).toBe(0);
      });

      it("uses exact tax type lookup", () => {
        const item = LineItem.create(
          makeInput({
            taxes: [makeEwt()],
          }),
          "PHP",
        );

        expect(item.withholdingAmountByType("ewt")).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Serialization
  // ===========================================================================

  describe("toJSON()", () => {
    it("returns a serializable line-item representation", () => {
      const item = LineItem.create(makeInput(), "PHP");

      const json = item.toJSON();

      expect(json).toBeDefined();
      expect(typeof json).toBe("object");
    });

    it("serializes identity fields", () => {
      const item = LineItem.create(
        makeInput({
          id: "item-001",
          skuId: "SKU-001",
        }),
        "PHP",
      );

      const json = item.toJSON();

      expect(json.id).toBe("item-001");
      expect(json.skuId).toBe("SKU-001");
    });

    it("serializes source input fields", () => {
      const item = LineItem.create(
        makeInput({
          description: "Consulting",
          quantity: 5,
          unitPrice: 250,
          unit: "hour",
          accountCode: "4000",
          costCenter: "CC-10",
        }),
        "PHP",
      );

      const json = item.toJSON();

      expect(json.description).toBe("Consulting");
      expect(json.quantity).toBe(5);
      expect(json.unit).toBe("hour");
      expect(json.accountCode).toBe("4000");
      expect(json.costCenter).toBe("CC-10");
    });

    it("serializes discount information", () => {
      const discount = {
        type: "percentage" as const,
        value: 0.1,
      };

      const item = LineItem.create(
        makeInput({
          discount,
        }),
        "PHP",
      );

      const json = item.toJSON();

      expect(json.discount).toEqual(discount);
    });

    it("serializes taxes through TaxManager", () => {
      const taxes = [makeVat(), makeEwt()];

      const item = LineItem.create(
        makeInput({
          taxes,
        }),
        "PHP",
      );

      const json = item.toJSON();

      expect(json.taxes).toEqual(item.taxes.toArray());
    });

    it("serializes monetary values", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 2,
          unitPrice: 500,
          discount: {
            type: "fixed",
            value: 100,
          },
          taxes: [makeVat()],
        }),
        "PHP",
      );

      const json = item.toJSON();

      expect(json.unitPrice).toBeDefined();
      expect(json.lineTotal).toBeDefined();
      expect(json.discountAmount).toBeDefined();
      expect(json.additiveTaxAmount).toBeDefined();
      expect(json.withholdingTaxAmount).toBeDefined();
      expect(json.netTotal).toBeDefined();
      expect(json.netPayable).toBeDefined();
    });

    it("serializes the legacy taxAmount alias", () => {
      const item = LineItem.create(
        makeInput({
          taxes: [makeVat()],
        }),
        "PHP",
      );

      const json = item.toJSON();

      expect(json.taxAmount).toEqual(json.additiveTaxAmount);
    });

    it("serializes tags and metadata", () => {
      const item = LineItem.create(
        makeInput({
          tags: ["service", "software"],
          metadata: {
            project: "alpha",
            reference: "ABC-123",
          },
        }),
        "PHP",
      );

      const json = item.toJSON();

      expect(json.tags).toEqual(["service", "software"]);

      expect(json.metadata).toEqual({
        project: "alpha",
        reference: "ABC-123",
      });
    });

    it("can be passed to JSON.stringify()", () => {
      const item = LineItem.create(
        makeInput({
          taxes: [makeVat()],
        }),
        "PHP",
      );

      expect(() => JSON.stringify(item.toJSON())).not.toThrow();
    });
  });

  // ===========================================================================
  // Deserialization
  // ===========================================================================

  describe("fromJSON()", () => {
    const createSerializedItem = (): {
      item: LineItem;
      json: LineItemJSON;
    } => {
      const item = LineItem.create(
        makeInput({
          id: "item-json-001",
          skuId: "SKU-JSON",
          description: "Consulting",
          quantity: 5,
          unitPrice: 200,
          unit: "hour",
          discount: {
            type: "fixed",
            value: 100,
          },
          taxes: [makeVat(), makeEwt()],
          accountCode: "4000",
          costCenter: "CC-10",
          tags: ["service"],
          metadata: {
            project: "alpha",
          },
        }),
        "PHP",
      );

      return {
        item,
        json: item.toJSON(),
      };
    };

    it("reconstructs a LineItem instance", () => {
      const { json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed).toBeInstanceOf(LineItem);
    });

    it("preserves ID", () => {
      const { json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.id).toBe("item-json-001");
    });

    it("preserves source properties", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.description).toBe(item.description);
      expect(reconstructed.quantity).toBe(item.quantity);
      expect(reconstructed.unit).toBe(item.unit);
      expect(reconstructed.skuId).toBe(item.skuId);
      expect(reconstructed.accountCode).toBe(item.accountCode);
      expect(reconstructed.costCenter).toBe(item.costCenter);
    });

    it("preserves discount", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.discount).toEqual(item.discount);
    });

    it("preserves taxes", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.taxes.all).toEqual(item.taxes.all);
    });

    it("preserves tags and metadata", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.tags).toEqual(item.tags);

      expect(reconstructed.metadata).toEqual(item.metadata);
    });

    it("recomputes the same line total", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.lineTotalAmount).toBe(item.lineTotalAmount);
    });

    it("recomputes the same discount amount", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.discountAmountValue).toBe(item.discountAmountValue);
    });

    it("recomputes the same additive tax amount", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.additiveTaxAmountValue).toBe(
        item.additiveTaxAmountValue,
      );
    });

    it("recomputes the same withholding amount", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.withholdingTaxAmountValue).toBe(
        item.withholdingTaxAmountValue,
      );
    });

    it("recomputes the same net total", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.netTotalAmount).toBe(item.netTotalAmount);
    });

    it("recomputes the same net payable amount", () => {
      const { item, json } = createSerializedItem();

      const reconstructed = LineItem.fromJSON(json, "PHP");

      expect(reconstructed.netPayableAmount).toBe(item.netPayableAmount);
    });

    it("supports a full serialization round trip", () => {
      const { item } = createSerializedItem();

      const serialized = item.toJSON();
      const reconstructed = LineItem.fromJSON(serialized, "PHP");

      expect(reconstructed.toJSON()).toEqual(serialized);
    });

    it("recalculates derived values rather than trusting serialized totals", () => {
      const { item, json } = createSerializedItem();

      const tampered = {
        ...json,
        lineTotal: json.netTotal,
        additiveTaxAmount: json.netPayable,
        withholdingTaxAmount: json.lineTotal,
        taxAmount: json.lineTotal,
        discountAmount: json.netTotal,
        netTotal: json.lineTotal,
        netPayable: json.discountAmount,
      };

      const reconstructed = LineItem.fromJSON(tampered, "PHP");

      expect(reconstructed.lineTotalAmount).toBe(item.lineTotalAmount);

      expect(reconstructed.additiveTaxAmountValue).toBe(
        item.additiveTaxAmountValue,
      );

      expect(reconstructed.withholdingTaxAmountValue).toBe(
        item.withholdingTaxAmountValue,
      );

      expect(reconstructed.netTotalAmount).toBe(item.netTotalAmount);

      expect(reconstructed.netPayableAmount).toBe(item.netPayableAmount);
    });
  });

  // ===========================================================================
  // Object Relationships & Immutability
  // ===========================================================================

  describe("Object Relationships & Immutability", () => {
    it("freezes the LineItem constructor", () => {
      expect(Object.isFrozen(LineItem)).toBe(true);
    });

    it("freezes LineItem.prototype", () => {
      expect(Object.isFrozen(LineItem.prototype)).toBe(true);
    });

    it("does not replace the original item when calculations are performed", () => {
      const item = LineItem.create(
        makeInput({
          taxes: [makeVat()],
        }),
        "PHP",
      );

      const before = {
        lineTotal: item.lineTotalAmount,
        discount: item.discountAmountValue,
        tax: item.additiveTaxAmountValue,
        payable: item.netPayableAmount,
      };

      // Reading calculation getters should be side-effect free.
      void item.lineTotalAmount;
      void item.discountAmountValue;
      void item.additiveTaxAmountValue;
      void item.withholdingTaxAmountValue;
      void item.netTotalAmount;
      void item.netPayableAmount;
      void item.nominalTaxRate;
      void item.effectiveTaxRate;
      void item.isTaxable;
      void item.hasDiscount;

      expect(item.lineTotalAmount).toBe(before.lineTotal);
      expect(item.discountAmountValue).toBe(before.discount);
      expect(item.additiveTaxAmountValue).toBe(before.tax);
      expect(item.netPayableAmount).toBe(before.payable);
    });

    it("uses the exact default TaxManager instance when taxes are inherited", () => {
      const defaults = TaxManager.fromOne(makeVat());

      const item = LineItem.create(makeInput(), "PHP", defaults);

      expect(item.taxes).toBe(defaults);
    });

    it("creates a separate TaxManager when explicit taxes are supplied", () => {
      const defaults = TaxManager.fromOne(makeVat());

      const item = LineItem.create(
        makeInput({
          taxes: [
            makeVat({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
        defaults,
      );

      expect(item.taxes).not.toBe(defaults);
    });

    it("does not allow assignment to computed getter properties", () => {
      const item = LineItem.create(makeInput(), "PHP");

      expect(() => {
        // @ts-expect-error Intentional runtime immutability test.
        item.lineTotalAmount = 500;
      }).toThrow();

      expect(item.lineTotalAmount).toBe(1000);
    });
  });

  // ===========================================================================
  // Domain Invariants
  // ===========================================================================

  describe("Domain Invariants", () => {
    it("netTotal equals post-discount plus exclusive additive taxes", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          discount: {
            type: "fixed",
            value: 100,
          },
          taxes: [
            makeVat({
              inclusive: false,
            }),
          ],
        }),
        "PHP",
      );

      const postDiscount = item.lineTotalAmount - item.discountAmountValue;

      const expected = postDiscount + item.additiveTaxAmountValue;

      expect(item.netTotalAmount).toBe(expected);
    });

    it("inclusive additive tax is not added a second time to netTotal", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1120,
          taxes: [
            makeVat({
              inclusive: true,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.netTotalAmount).toBe(item.lineTotalAmount);
    });

    it("netPayable equals netTotal minus withholding", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeEwt({
              rate: 0.05,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.netPayableAmount).toBe(
        item.netTotalAmount - item.withholdingTaxAmountValue,
      );
    });

    it("taxAmount always mirrors additiveTaxAmount", () => {
      const item = LineItem.create(
        makeInput({
          taxes: [makeVat(), makeEwt()],
        }),
        "PHP",
      );

      expect(item.taxAmountValue).toBe(item.additiveTaxAmountValue);

      expect(item.taxAmount).toBe(item.additiveTaxAmount);
    });

    it("withholding taxes never contribute to additiveTaxAmount", () => {
      const item = LineItem.create(
        makeInput({
          taxes: [
            makeEwt({
              rate: 0.1,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.additiveTaxAmountValue).toBe(0);
      expect(item.withholdingTaxAmountValue).toBe(100);
    });

    it("informational taxes never contribute to tax totals", () => {
      const item = LineItem.create(
        makeInput({
          taxes: [
            makeInformational({
              rate: 0.5,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.additiveTaxAmountValue).toBe(0);
      expect(item.withholdingTaxAmountValue).toBe(0);
      expect(item.netTotalAmount).toBe(1000);
    });

    it("a fully discounted line has zero net total", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 2,
          unitPrice: 500,
          discount: {
            type: "fixed",
            value: 1000,
          },
        }),
        "PHP",
      );

      expect(item.lineTotalAmount).toBe(1000);
      expect(item.discountAmountValue).toBe(1000);
      expect(item.netTotalAmount).toBe(0);
    });
  });

  describe("Rounding scenarios", () => {
    it("rounds calculated monetary amounts to the monetary precision of MajikMoney", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1120,
          taxes: [
            makeVat({
              inclusive: true,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.additiveTaxAmountValue).toBe(120);
      expect(Number.isFinite(item.additiveTaxAmountValue)).toBe(true);
      expect(item.additiveTaxAmountValue.toFixed(2)).toBe("120.00");
    });

    it("rounds fractional inclusive tax calculations to currency precision", () => {
      const item = LineItem.create(
        makeInput({
          quantity: 1,
          unitPrice: 1000,
          taxes: [
            makeVat({
              inclusive: true,
            }),
          ],
        }),
        "PHP",
      );

      expect(item.additiveTaxAmountValue).toBe(107.14);
    });
  });
});
