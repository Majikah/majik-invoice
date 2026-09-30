import { describe, it, expect } from "vitest";
import { TaxManager } from "../src/core/general-invoice/tax-manager";
import { InvoiceValidationError } from "../src/core/general-invoice/errors";
import type {
  TaxDetail,
  TaxBehaviour,
} from "../src/core/general-invoice/types";

describe("TaxManager", () => {
  // ===========================================================================
  // Fixtures
  // ===========================================================================

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
  ) => {
    expect(fn).toThrowError(InvoiceValidationError);

    if (message !== undefined) {
      expect(fn).toThrowError(message);
    }
  };

  // ===========================================================================
  // none()
  // ===========================================================================

  describe("none()", () => {
    it("creates an empty manager", () => {
      const manager = TaxManager.none();

      expect(manager).toBeInstanceOf(TaxManager);
      expect(manager.isEmpty).toBe(true);
      expect(manager.all).toEqual([]);
      expect(manager.taxTypes).toEqual([]);
      expect(manager.additive).toEqual([]);
      expect(manager.withholding).toEqual([]);
      expect(manager.informational).toEqual([]);
    });

    it("returns a distinct instance on each call", () => {
      expect(TaxManager.none()).not.toBe(TaxManager.none());
    });
  });

  // ===========================================================================
  // fromOne()
  // ===========================================================================

  describe("fromOne()", () => {
    it("creates a manager from a valid additive tax", () => {
      const tax = makeVat();
      const manager = TaxManager.fromOne(tax);

      expect(manager.isEmpty).toBe(false);
      expect(manager.all).toHaveLength(1);
      expect(manager.all[0]).toEqual(tax);
    });

    it("creates a manager from a valid withholding tax", () => {
      const tax = makeEwt();
      const manager = TaxManager.fromOne(tax);

      expect(manager.withholding).toEqual([tax]);
      expect(manager.additive).toEqual([]);
    });

    it("creates a manager from a valid informational tax", () => {
      const tax = makeInformational();
      const manager = TaxManager.fromOne(tax);

      expect(manager.informational).toEqual([tax]);
    });

    it("accepts a zero rate", () => {
      const manager = TaxManager.fromOne(makeVat({ rate: 0 }));

      expect(manager.getByType("VAT")?.rate).toBe(0);
    });

    it("accepts a rate of exactly 1", () => {
      const manager = TaxManager.fromOne(makeVat({ rate: 1 }));

      expect(manager.getByType("VAT")?.rate).toBe(1);
    });

    it("defaults an omitted behaviour to additive", () => {
      const manager = TaxManager.fromOne({
        taxType: "VAT",
        rate: 0.12,
      });

      expect(manager.additive).toHaveLength(1);
      expect(manager.withholding).toHaveLength(0);
      expect(manager.informational).toHaveLength(0);
    });

    it("preserves explicit inclusive=false", () => {
      const manager = TaxManager.fromOne(makeVat({ inclusive: false }));

      expect(manager.getByType("VAT")?.inclusive).toBe(false);
    });

    it("preserves explicit inclusive=true for additive taxes", () => {
      const manager = TaxManager.fromOne(makeVat({ inclusive: true }));

      expect(manager.getByType("VAT")?.inclusive).toBe(true);
    });

    it("normalizes surrounding whitespace from taxType", () => {
      const tax = makeVat({ taxType: "  vat  " });
      const manager = TaxManager.fromOne(tax);

      expect(manager.taxTypes).toEqual(["VAT"]);
    });

    it("normalizes taxType to uppercase", () => {
      const manager = TaxManager.fromOne(makeVat({ taxType: "vAt" }));

      expect(manager.taxTypes).toEqual(["VAT"]);
    });

    it("mutates the supplied taxType during normalization", () => {
      const tax = makeVat({ taxType: "  vat  " });

      TaxManager.fromOne(tax);

      // This documents the current implementation behaviour.
      expect(tax.taxType).toBe("VAT");
    });
  });

  // ===========================================================================
  // fromMany()
  // ===========================================================================

  describe("fromMany()", () => {
    it("creates an empty manager from an empty array", () => {
      const manager = TaxManager.fromMany([]);

      expect(manager.isEmpty).toBe(true);
      expect(manager.all).toEqual([]);
    });

    it("creates a manager from multiple valid taxes", () => {
      const vat = makeVat();
      const ewt = makeEwt();

      const manager = TaxManager.fromMany([vat, ewt]);

      expect(manager.all).toEqual([vat, ewt]);
      expect(manager.taxTypes).toEqual(["VAT", "EWT"]);
    });

    it("preserves input ordering", () => {
      const manager = TaxManager.fromMany([
        makeInformational(),
        makeEwt(),
        makeVat(),
      ]);

      expect(manager.taxTypes).toEqual(["EXEMPT", "EWT", "VAT"]);
    });

    it("validates every entry in the collection", () => {
      expectValidationError(
        () =>
          TaxManager.fromMany([
            makeVat(),
            {
              taxType: "EWT",
              rate: 2,
              behaviour: "withholding",
            },
          ]),
        /between 0 and 1/,
      );
    });

    it("reports the failing array entry through validation", () => {
      expectValidationError(
        () =>
          TaxManager.fromMany([
            makeVat(),
            {
              taxType: "",
              rate: 0.05,
            },
          ]),
        /taxType is required/,
      );
    });

    it("rejects duplicate tax types", () => {
      expectValidationError(
        () => TaxManager.fromMany([makeVat(), makeVat({ rate: 0.15 })]),
        /Duplicate tax type/,
      );
    });

    it("rejects duplicate tax types regardless of case and whitespace", () => {
      expectValidationError(
        () =>
          TaxManager.fromMany([
            makeVat({ taxType: " vat " }),
            makeVat({ taxType: "VAT" }),
          ]),
        /Duplicate tax type/,
      );
    });

    it("allows the same taxType across different jurisdictions", () => {
      const manager = TaxManager.fromMany([
        makeVat({
          jurisdiction: "PH",
        }),
        makeVat({
          jurisdiction: "US",
        }),
      ]);

      expect(manager.all).toHaveLength(2);
      expect(manager.all.map((t) => t.jurisdiction)).toEqual(["PH", "US"]);
    });

    it("treats jurisdiction comparison as case-insensitive", () => {
      expectValidationError(
        () =>
          TaxManager.fromMany([
            makeVat({
              taxType: "VAT",
              jurisdiction: "ph",
            }),
            makeVat({
              taxType: "VAT",
              jurisdiction: "PH",
            }),
          ]),
        /Duplicate tax type/,
      );
    });

    it("ignores surrounding whitespace when comparing jurisdictions", () => {
      expectValidationError(
        () =>
          TaxManager.fromMany([
            makeVat({
              taxType: "VAT",
              jurisdiction: " PH ",
            }),
            makeVat({
              taxType: "VAT",
              jurisdiction: "PH",
            }),
          ]),
        /Duplicate tax type/,
      );
    });

    it("allows multiple exclusive additive taxes", () => {
      const manager = TaxManager.fromMany([
        makeVat({ taxType: "VAT", inclusive: false }),
        makeVat({ taxType: "LOCAL_TAX", rate: 0.05, inclusive: false }),
      ]);

      expect(manager.additive).toHaveLength(2);
    });

    it("allows one inclusive additive tax", () => {
      const manager = TaxManager.fromMany([makeVat({ inclusive: true })]);

      expect(manager.getByType("VAT")?.inclusive).toBe(true);
    });

    it("rejects multiple inclusive additive taxes", () => {
      expectValidationError(
        () =>
          TaxManager.fromMany([
            makeVat({
              taxType: "VAT",
              inclusive: true,
            }),
            makeVat({
              taxType: "LOCAL_TAX",
              rate: 0.05,
              inclusive: true,
            }),
          ]),
        /At most one inclusive additive tax is allowed/,
      );
    });

    it("does not count withholding taxes toward the inclusive-additive limit", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: true }),
        makeEwt(),
      ]);

      expect(manager.all).toHaveLength(2);
    });

    it("allows informational taxes with inclusive=true", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: true }),
        makeInformational({ inclusive: true }),
      ]);

      expect(manager.informational[0].inclusive).toBe(true);
    });

    it("rejects an inclusive withholding tax", () => {
      expectValidationError(
        () => TaxManager.fromMany([makeEwt({ inclusive: true })]),
        /Withholding taxes cannot be inclusive/,
      );
    });
  });

  // ===========================================================================
  // resolve()
  // ===========================================================================

  describe("resolve()", () => {
    it("returns own taxes when own manager is non-empty", () => {
      const own = TaxManager.fromOne(makeVat());
      const defaults = TaxManager.fromOne(makeEwt());

      const resolved = TaxManager.resolve(own, defaults);

      expect(resolved).toBe(own);
      expect(resolved).not.toBe(defaults);
    });

    it("returns invoice defaults when own manager is empty", () => {
      const own = TaxManager.none();
      const defaults = TaxManager.fromOne(makeEwt());

      const resolved = TaxManager.resolve(own, defaults);

      expect(resolved).toBe(defaults);
    });

    it("returns the empty default when both managers are empty", () => {
      const own = TaxManager.none();
      const defaults = TaxManager.none();

      expect(TaxManager.resolve(own, defaults)).toBe(defaults);
    });
  });

  // ===========================================================================
  // coerce()
  // ===========================================================================

  describe("coerce()", () => {
    it("coerces undefined to an empty manager", () => {
      const manager = TaxManager.coerce(undefined);

      expect(manager.isEmpty).toBe(true);
    });

    it("coerces a single tax object", () => {
      const manager = TaxManager.coerce(makeVat());

      expect(manager.taxTypes).toEqual(["VAT"]);
    });

    it("coerces an array of taxes", () => {
      const manager = TaxManager.coerce([makeVat(), makeEwt()]);

      expect(manager.taxTypes).toEqual(["VAT", "EWT"]);
    });

    it("coerces an existing manager into a new manager", () => {
      const original = TaxManager.fromMany([makeVat(), makeEwt()]);

      const coerced = TaxManager.coerce(original);

      expect(coerced).not.toBe(original);
      expect(coerced.all).toEqual(original.all);
    });

    it("preserves validation when coercing an existing manager", () => {
      const original = TaxManager.fromOne(makeVat());

      expect(TaxManager.coerce(original).all).toEqual(original.all);
    });

    it("coerces a null runtime value to an empty manager", () => {
      const manager = TaxManager.coerce(null as never);

      expect(manager.isEmpty).toBe(true);
    });

    it("rejects an unsupported truthy primitive", () => {
      expectValidationError(
        () => TaxManager.coerce("invalid" as never),
        /Tax must be a valid object/,
      );
    });
  });

  // ===========================================================================
  // assertValidTax()
  // ===========================================================================

  describe("assertValidTax()", () => {
    const field = "invoice.tax";

    it("returns normally for a valid tax", () => {
      expect(() => TaxManager.assertValidTax(makeVat(), field)).not.toThrow();
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["array", []],
      ["string", "VAT"],
      ["number", 123],
      ["boolean", true],
    ])("rejects %s as a tax object", (_label, value) => {
      expectValidationError(
        () => TaxManager.assertValidTax(value as never, field),
        /Tax must be a valid object/,
      );
    });

    it.each([
      ["missing taxType", { rate: 0.12 }],
      ["empty taxType", { taxType: "", rate: 0.12 }],
      ["whitespace taxType", { taxType: "   ", rate: 0.12 }],
      ["null taxType", { taxType: null, rate: 0.12 }],
      ["numeric taxType", { taxType: 123, rate: 0.12 }],
      ["boolean taxType", { taxType: true, rate: 0.12 }],
    ])("rejects %s", (_label, tax) => {
      expectValidationError(
        () => TaxManager.assertValidTax(tax as never, field),
        /taxType is required/,
      );
    });

    it.each([
      ["string", "0.12"],
      ["null", null],
      ["undefined", undefined],
      ["boolean", true],
      ["bigint", BigInt(1)],
      ["object", {}],
    ])("rejects %s as a rate", (_label, rate) => {
      expectValidationError(
        () =>
          TaxManager.assertValidTax(
            {
              taxType: "VAT",
              rate,
            } as never,
            field,
          ),
        /finite number/,
      );
    });

    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ])("rejects %s as a rate", (_label, rate) => {
      expectValidationError(
        () =>
          TaxManager.assertValidTax(
            {
              taxType: "VAT",
              rate,
            },
            field,
          ),
        /finite number/,
      );
    });

    it.each([
      ["below zero", -0.000001],
      ["negative", -0.01],
      ["above one", 1.000001],
      ["large positive", 100],
    ])("rejects rate %s", (_label, rate) => {
      expectValidationError(
        () =>
          TaxManager.assertValidTax(
            {
              taxType: "VAT",
              rate,
            },
            field,
          ),
        /between 0 and 1/,
      );
    });

    it.each([
      ["zero", 0],
      ["small positive", 0.000001],
      ["12%", 0.12],
      ["50%", 0.5],
      ["one", 1],
      ["negative zero", -0],
    ])("accepts valid rate: %s", (_label, rate) => {
      expect(() =>
        TaxManager.assertValidTax(
          {
            taxType: "VAT",
            rate,
          },
          field,
        ),
      ).not.toThrow();
    });

    it.each<TaxBehaviour>(["additive", "withholding", "informational"])(
      "accepts behaviour=%s",
      (behaviour) => {
        expect(() =>
          TaxManager.assertValidTax(
            {
              taxType: "TEST",
              rate: 0.1,
              behaviour,
            },
            field,
          ),
        ).not.toThrow();
      },
    );

    it.each(["unknown", "Additive", "WITHHOLDING", "foo", "invalid"])(
      "rejects unsupported behaviour=%s",
      (behaviour) => {
        expectValidationError(
          () =>
            TaxManager.assertValidTax(
              {
                taxType: "TEST",
                rate: 0.1,
                behaviour: behaviour as TaxBehaviour,
              },
              field,
            ),
          /behaviour must be one of/,
        );
      },
    );

    it("rejects an inclusive withholding tax", () => {
      expectValidationError(
        () =>
          TaxManager.assertValidTax(
            {
              taxType: "EWT",
              rate: 0.05,
              behaviour: "withholding",
              inclusive: true,
            },
            field,
          ),
        /Withholding taxes cannot be inclusive/,
      );
    });

    it("accepts an exclusive withholding tax", () => {
      expect(() =>
        TaxManager.assertValidTax(
          {
            taxType: "EWT",
            rate: 0.05,
            behaviour: "withholding",
            inclusive: false,
          },
          field,
        ),
      ).not.toThrow();
    });

    it("normalizes taxType in place", () => {
      const tax = {
        taxType: "  eWt  ",
        rate: 0.05,
        behaviour: "withholding" as const,
      };

      TaxManager.assertValidTax(tax, field);

      expect(tax.taxType).toBe("EWT");
    });
  });

  // ===========================================================================
  // add()
  // ===========================================================================

  describe("add()", () => {
    it("adds a new tax", () => {
      const manager = TaxManager.fromOne(makeVat());

      const result = manager.add(makeEwt());

      expect(result.taxTypes).toEqual(["VAT", "EWT"]);
    });

    it("does not mutate the original manager", () => {
      const manager = TaxManager.fromOne(makeVat());

      manager.add(makeEwt());

      expect(manager.taxTypes).toEqual(["VAT"]);
    });

    it("returns a new manager instance", () => {
      const manager = TaxManager.fromOne(makeVat());
      const result = manager.add(makeEwt());

      expect(result).not.toBe(manager);
    });

    it("rejects duplicate taxType", () => {
      const manager = TaxManager.fromOne(makeVat());

      expectValidationError(
        () =>
          manager.add(
            makeVat({
              rate: 0.15,
            }),
          ),
        /already exists/,
      );
    });

    it("rejects duplicate taxType after normalization", () => {
      const manager = TaxManager.fromOne(makeVat());

      expectValidationError(
        () =>
          manager.add(
            makeVat({
              taxType: "  vat ",
            }),
          ),
        /already exists/,
      );
    });

    it("validates the tax before attempting to add it", () => {
      const manager = TaxManager.fromOne(makeVat());

      expectValidationError(
        () =>
          manager.add({
            taxType: "EWT",
            rate: 5,
            behaviour: "withholding",
          }),
        /between 0 and 1/,
      );
    });

    it("rejects an addition that creates multiple inclusive additive taxes", () => {
      const manager = TaxManager.fromOne(makeVat({ inclusive: true }));

      expectValidationError(
        () =>
          manager.add(
            makeVat({
              taxType: "LOCAL",
              rate: 0.05,
              inclusive: true,
            }),
          ),
        /At most one inclusive additive tax is allowed/,
      );
    });
  });

  // ===========================================================================
  // replace()
  // ===========================================================================

  describe("replace()", () => {
    it("replaces an existing tax", () => {
      const manager = TaxManager.fromMany([makeVat(), makeEwt()]);

      const result = manager.replace(makeVat({ rate: 0.15 }));

      expect(result.getByType("VAT")?.rate).toBe(0.15);
      expect(result.getByType("EWT")).toEqual(makeEwt());
    });

    it("does not mutate the original manager", () => {
      const manager = TaxManager.fromOne(makeVat());

      manager.replace(makeVat({ rate: 0.15 }));

      expect(manager.getByType("VAT")?.rate).toBe(0.12);
    });

    it("returns a new instance", () => {
      const manager = TaxManager.fromOne(makeVat());
      const result = manager.replace(makeVat({ rate: 0.15 }));

      expect(result).not.toBe(manager);
    });

    it("rejects replacement of a missing tax type", () => {
      const manager = TaxManager.none();

      expectValidationError(() => manager.replace(makeVat()), /not found/);
    });

    it("validates replacement input", () => {
      const manager = TaxManager.fromOne(makeVat());

      expectValidationError(
        () =>
          manager.replace(
            makeVat({
              rate: 2,
            }),
          ),
        /between 0 and 1/,
      );
    });

    it("can replace an existing tax with a different behaviour", () => {
      const manager = TaxManager.fromOne(makeVat());

      const result = manager.replace({
        taxType: "VAT",
        rate: 0.05,
        behaviour: "informational",
      });

      expect(result.informational).toHaveLength(1);
      expect(result.additive).toHaveLength(0);
    });

    it("rejects replacement that creates multiple inclusive additive taxes", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: true }),
        makeVat({
          taxType: "LOCAL",
          rate: 0.05,
          inclusive: false,
        }),
      ]);

      expectValidationError(
        () =>
          manager.replace(
            makeVat({
              taxType: "LOCAL",
              rate: 0.05,
              inclusive: true,
            }),
          ),
        /At most one inclusive additive tax is allowed/,
      );
    });
  });

  // ===========================================================================
  // set()
  // ===========================================================================

  describe("set()", () => {
    it("adds when the tax type does not exist", () => {
      const manager = TaxManager.none();

      const result = manager.set(makeVat());

      expect(result.taxTypes).toEqual(["VAT"]);
    });

    it("replaces when the tax type already exists", () => {
      const manager = TaxManager.fromOne(makeVat());

      const result = manager.set(makeVat({ rate: 0.15 }));

      expect(result.getByType("VAT")?.rate).toBe(0.15);
      expect(result).not.toBe(manager);
    });

    it("does not mutate the original manager", () => {
      const manager = TaxManager.fromOne(makeVat());

      manager.set(makeVat({ rate: 0.15 }));

      expect(manager.getByType("VAT")?.rate).toBe(0.12);
    });

    it("validates a new tax", () => {
      expectValidationError(
        () =>
          TaxManager.none().set(
            makeVat({
              rate: 1.1,
            }),
          ),
        /between 0 and 1/,
      );
    });

    it("validates a replacement tax", () => {
      const manager = TaxManager.fromOne(makeVat());

      expectValidationError(
        () =>
          manager.set(
            makeVat({
              rate: -0.1,
            }),
          ),
        /between 0 and 1/,
      );
    });

    it("preserves the position of an existing tax when replacing it", () => {
      const manager = TaxManager.fromMany([
        makeVat(),
        makeEwt(),
        makeInformational(),
      ]);

      const result = manager.set(makeEwt({ rate: 0.1 }));

      expect(result.taxTypes).toEqual(["VAT", "EWT", "EXEMPT"]);
    });
  });

  // ===========================================================================
  // remove()
  // ===========================================================================

  describe("remove()", () => {
    it("removes an existing tax", () => {
      const manager = TaxManager.fromMany([makeVat(), makeEwt()]);

      const result = manager.remove("VAT");

      expect(result.taxTypes).toEqual(["EWT"]);
    });

    it("returns a new manager", () => {
      const manager = TaxManager.fromOne(makeVat());
      const result = manager.remove("VAT");

      expect(result).not.toBe(manager);
    });

    it("does not mutate the original manager", () => {
      const manager = TaxManager.fromOne(makeVat());

      manager.remove("VAT");

      expect(manager.taxTypes).toEqual(["VAT"]);
    });

    it("is a no-op for a missing tax type", () => {
      const manager = TaxManager.fromOne(makeVat());

      const result = manager.remove("EWT");

      expect(result.taxTypes).toEqual(["VAT"]);
      expect(result).not.toBe(manager);
    });

    it("removes only the matching tax", () => {
      const manager = TaxManager.fromMany([
        makeVat(),
        makeEwt(),
        makeInformational(),
      ]);

      const result = manager.remove("EWT");

      expect(result.taxTypes).toEqual(["VAT", "EXEMPT"]);
    });

    it("does not perform implicit case normalization when removing", () => {
      const manager = TaxManager.fromOne(makeVat());

      const result = manager.remove("vat");

      expect(result.taxTypes).toEqual(["VAT"]);
    });
  });

  // ===========================================================================
  // clear()
  // ===========================================================================

  describe("clear()", () => {
    it("removes every tax", () => {
      const manager = TaxManager.fromMany([
        makeVat(),
        makeEwt(),
        makeInformational(),
      ]);

      const result = manager.clear();

      expect(result.isEmpty).toBe(true);
      expect(result.all).toEqual([]);
    });

    it("does not mutate the original manager", () => {
      const manager = TaxManager.fromOne(makeVat());

      manager.clear();

      expect(manager.isEmpty).toBe(false);
    });

    it("returns a new empty manager", () => {
      const manager = TaxManager.fromOne(makeVat());
      const result = manager.clear();

      expect(result).not.toBe(manager);
      expect(result).not.toBe(TaxManager.none());
    });
  });

  // ===========================================================================
  // withInclusivity()
  // ===========================================================================

  describe("withInclusivity()", () => {
    it("marks an additive tax as inclusive", () => {
      const manager = TaxManager.fromOne(makeVat({ inclusive: false }));

      const result = manager.withInclusivity(true);

      expect(result.getByType("VAT")?.inclusive).toBe(true);
    });

    it("marks an additive tax as exclusive", () => {
      const manager = TaxManager.fromOne(makeVat({ inclusive: true }));

      const result = manager.withInclusivity(false);

      expect(result.getByType("VAT")?.inclusive).toBe(false);
    });

    it("changes all eligible taxes when no taxType is specified", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: false }),
        makeVat({
          taxType: "LOCAL",
          rate: 0.05,
          inclusive: false,
        }),
        makeInformational({ inclusive: false }),
      ]);

      const result = manager.withInclusivity(true);

      expect(result.getByType("VAT")?.inclusive).toBe(true);
      expect(result.getByType("LOCAL")?.inclusive).toBe(true);
      expect(result.getByType("EXEMPT")?.inclusive).toBe(true);
    });

    it("changes only the requested tax when taxType is supplied", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: false }),
        makeVat({
          taxType: "LOCAL",
          rate: 0.05,
          inclusive: false,
        }),
      ]);

      const result = manager.withInclusivity(true, "VAT");

      expect(result.getByType("VAT")?.inclusive).toBe(true);
      expect(result.getByType("LOCAL")?.inclusive).toBe(false);
    });

    it("skips withholding taxes", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: false }),
        makeEwt(),
      ]);

      const result = manager.withInclusivity(true);

      expect(result.getByType("VAT")?.inclusive).toBe(true);
      expect(result.getByType("EWT")?.inclusive).toBeUndefined();
    });

    it("skips withholding taxes even when explicitly targeted", () => {
      const manager = TaxManager.fromMany([makeEwt()]);

      const result = manager.withInclusivity(true, "EWT");

      expect(result.getByType("EWT")?.inclusive).toBeUndefined();
    });

    it("treats omitted inclusive as false when deciding whether a change is needed", () => {
      const manager = TaxManager.fromOne(makeVat());

      const result = manager.withInclusivity(false);

      expect(result).toBe(manager);
    });

    it("returns the same instance when no eligible tax changes", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: true }),
        makeEwt(),
      ]);

      const result = manager.withInclusivity(true);

      expect(result).toBe(manager);
    });

    it("returns the same instance when targeting an unchanged tax", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: true }),
        makeVat({
          taxType: "LOCAL",
          rate: 0.05,
          inclusive: false,
        }),
      ]);

      const result = manager.withInclusivity(true, "VAT");

      expect(result).toBe(manager);
    });

    it("returns a new instance when at least one value changes", () => {
      const manager = TaxManager.fromOne(makeVat({ inclusive: false }));

      const result = manager.withInclusivity(true);

      expect(result).not.toBe(manager);
    });

    it("preserves the original manager when changing inclusivity", () => {
      const manager = TaxManager.fromOne(makeVat({ inclusive: false }));

      manager.withInclusivity(true);

      expect(manager.getByType("VAT")?.inclusive).toBe(false);
    });

    it("does not change unrelated tax entries", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: false }),
        makeEwt(),
        makeInformational({ inclusive: false }),
      ]);

      const result = manager.withInclusivity(true, "VAT");

      expect(result.getByType("VAT")?.inclusive).toBe(true);
      expect(result.getByType("EWT")).toEqual(makeEwt());
      expect(result.getByType("EXEMPT")?.inclusive).toBe(false);
    });
  });

  // ===========================================================================
  // Queries / selectors
  // ===========================================================================

  describe("Queries & Selectors", () => {
    it("returns all taxes through all", () => {
      const vat = makeVat();
      const ewt = makeEwt();

      const manager = TaxManager.fromMany([vat, ewt]);

      expect(manager.all).toEqual([vat, ewt]);
    });

    it("returns a frozen collection through all", () => {
      const manager = TaxManager.fromOne(makeVat());

      expect(Object.isFrozen(manager.all)).toBe(true);
    });

    it("reports isEmpty correctly", () => {
      expect(TaxManager.none().isEmpty).toBe(true);
      expect(TaxManager.fromOne(makeVat()).isEmpty).toBe(false);
    });

    it("returns only additive taxes", () => {
      const manager = TaxManager.fromMany([
        makeVat(),
        makeEwt(),
        makeInformational(),
      ]);

      expect(manager.additive).toHaveLength(1);
      expect(manager.additive[0].taxType).toBe("VAT");
    });

    it("treats missing behaviour as additive", () => {
      const manager = TaxManager.fromOne({
        taxType: "VAT",
        rate: 0.12,
      });

      expect(manager.additive).toHaveLength(1);
    });

    it("returns only withholding taxes", () => {
      const manager = TaxManager.fromMany([
        makeVat(),
        makeEwt(),
        makeInformational(),
      ]);

      expect(manager.withholding).toHaveLength(1);
      expect(manager.withholding[0].taxType).toBe("EWT");
    });

    it("returns only informational taxes", () => {
      const manager = TaxManager.fromMany([
        makeVat(),
        makeEwt(),
        makeInformational(),
      ]);

      expect(manager.informational).toHaveLength(1);
      expect(manager.informational[0].taxType).toBe("EXEMPT");
    });

    it("returns tax types in collection order", () => {
      const manager = TaxManager.fromMany([
        makeVat(),
        makeEwt(),
        makeInformational(),
      ]);

      expect(manager.taxTypes).toEqual(["VAT", "EWT", "EXEMPT"]);
    });

    it("returns true from hasTaxType for an existing type", () => {
      const manager = TaxManager.fromOne(makeVat());

      expect(manager.hasTaxType("VAT")).toBe(true);
    });

    it("returns false from hasTaxType for a missing type", () => {
      const manager = TaxManager.fromOne(makeVat());

      expect(manager.hasTaxType("GST")).toBe(false);
    });

    it("uses exact taxType matching for hasTaxType", () => {
      const manager = TaxManager.fromOne(makeVat());

      expect(manager.hasTaxType("vat")).toBe(false);
      expect(manager.hasTaxType(" VAT ")).toBe(false);
    });

    it("returns a matching tax with getByType", () => {
      const vat = makeVat();
      const manager = TaxManager.fromMany([vat, makeEwt()]);

      expect(manager.getByType("VAT")).toEqual(vat);
    });

    it("returns undefined from getByType when missing", () => {
      const manager = TaxManager.fromOne(makeVat());

      expect(manager.getByType("GST")).toBeUndefined();
    });

    it("uses exact taxType matching for getByType", () => {
      const manager = TaxManager.fromOne(makeVat());

      expect(manager.getByType("vat")).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // VAT selector
    // -------------------------------------------------------------------------

    describe("vat", () => {
      it("finds an additive VAT tax", () => {
        const manager = TaxManager.fromOne(makeVat());

        expect(manager.vat?.rate).toBe(0.12);
      });

      it("matches VAT case-insensitively", () => {
        const manager = TaxManager.fromOne({
          taxType: "pH-vAt",
          rate: 0.12,
          behaviour: "additive",
        });

        expect(manager.vat).toBeDefined();
      });

      it("matches VAT when VAT appears inside a longer tax type", () => {
        const manager = TaxManager.fromOne({
          taxType: "PH-VAT-OUTPUT",
          rate: 0.12,
          behaviour: "additive",
        });

        expect(manager.vat).toBeDefined();
      });

      it("does not return a withholding VAT", () => {
        const manager = TaxManager.fromOne({
          taxType: "VAT",
          rate: 0.05,
          behaviour: "withholding",
        });

        expect(manager.vat).toBeUndefined();
      });

      it("does not return an informational VAT", () => {
        const manager = TaxManager.fromOne({
          taxType: "VAT",
          rate: 0.12,
          behaviour: "informational",
        });

        expect(manager.vat).toBeUndefined();
      });

      it("returns undefined when no VAT exists", () => {
        const manager = TaxManager.fromOne(makeEwt());

        expect(manager.vat).toBeUndefined();
      });

      it("returns the first matching additive VAT", () => {
        const manager = TaxManager.fromMany([
          makeVat({
            taxType: "VAT-OUTPUT",
            rate: 0.12,
          }),
          makeVat({
            taxType: "VAT-OTHER",
            rate: 0.05,
          }),
        ]);

        expect(manager.vat?.taxType).toBe("VAT-OUTPUT");
      });
    });

    // -------------------------------------------------------------------------
    // EWT selector
    // -------------------------------------------------------------------------

    describe("ewt", () => {
      it("finds a withholding EWT tax", () => {
        const manager = TaxManager.fromOne(makeEwt());

        expect(manager.ewt?.rate).toBe(0.05);
      });

      it("matches EWT case-insensitively", () => {
        const manager = TaxManager.fromOne({
          taxType: "ewt 2307",
          rate: 0.02,
          behaviour: "withholding",
        });

        expect(manager.ewt).toBeDefined();
      });

      it("matches EWT inside a longer tax type", () => {
        const manager = TaxManager.fromOne({
          taxType: "PH-EWT-2307",
          rate: 0.02,
          behaviour: "withholding",
        });

        expect(manager.ewt).toBeDefined();
      });

      it("does not return an additive EWT", () => {
        const manager = TaxManager.fromOne({
          taxType: "EWT",
          rate: 0.05,
          behaviour: "additive",
        });

        expect(manager.ewt).toBeUndefined();
      });

      it("does not return an informational EWT", () => {
        const manager = TaxManager.fromOne({
          taxType: "EWT",
          rate: 0.05,
          behaviour: "informational",
        });

        expect(manager.ewt).toBeUndefined();
      });

      it("returns undefined when no EWT exists", () => {
        const manager = TaxManager.fromOne(makeVat());

        expect(manager.ewt).toBeUndefined();
      });
    });
  });

  // ===========================================================================
  // Serialization
  // ===========================================================================

  describe("toArray()", () => {
    it("serializes an empty manager to an empty array", () => {
      expect(TaxManager.none().toArray()).toEqual([]);
    });

    it("serializes all managed taxes", () => {
      const taxes = [makeVat(), makeEwt(), makeInformational()];

      const manager = TaxManager.fromMany(taxes);

      expect(manager.toArray()).toEqual(taxes);
    });

    it("returns a new array", () => {
      const manager = TaxManager.fromOne(makeVat());

      const a = manager.toArray();
      const b = manager.toArray();

      expect(a).not.toBe(b);
    });

    it("allows the returned array to be modified without changing manager length", () => {
      const manager = TaxManager.fromOne(makeVat());

      const serialized = manager.toArray();

      serialized.push(makeEwt());

      expect(serialized).toHaveLength(2);
      expect(manager.all).toHaveLength(1);
    });

    it("allows serialization to round-trip through fromMany()", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: true }),
        makeEwt(),
        makeInformational(),
      ]);

      const restored = TaxManager.fromMany(manager.toArray());

      expect(restored.all).toEqual(manager.all);
    });

    it("preserves normalization during serialization", () => {
      const manager = TaxManager.fromOne({
        taxType: " vat ",
        rate: 0.12,
      });

      expect(manager.toArray()).toEqual([
        {
          taxType: "VAT",
          rate: 0.12,
          behaviour: undefined,
        },
      ]);
    });
  });

  // ===========================================================================
  // Immutability / encapsulation
  // ===========================================================================

  describe("Immutability & Encapsulation", () => {
    it("freezes the internal tax array", () => {
      const manager = TaxManager.fromMany([makeVat(), makeEwt()]);

      expect(Object.isFrozen(manager.all)).toBe(true);
    });

    it("prevents direct array mutation at runtime", () => {
      const manager = TaxManager.fromOne(makeVat());

      expect(() => {
        (manager.all as TaxDetail[]).push(makeEwt());
      }).toThrow();

      expect(manager.all).toHaveLength(1);
    });

    it("add() leaves original state untouched", () => {
      const original = TaxManager.fromOne(makeVat());

      const next = original.add(makeEwt());

      expect(original.taxTypes).toEqual(["VAT"]);
      expect(next.taxTypes).toEqual(["VAT", "EWT"]);
    });

    it("replace() leaves original state untouched", () => {
      const original = TaxManager.fromOne(makeVat());

      const next = original.replace(makeVat({ rate: 0.15 }));

      expect(original.vat?.rate).toBe(0.12);
      expect(next.vat?.rate).toBe(0.15);
    });

    it("set() leaves original state untouched", () => {
      const original = TaxManager.fromOne(makeVat());

      const next = original.set(makeVat({ rate: 0.15 }));

      expect(original.vat?.rate).toBe(0.12);
      expect(next.vat?.rate).toBe(0.15);
    });

    it("remove() leaves original state untouched", () => {
      const original = TaxManager.fromMany([makeVat(), makeEwt()]);

      const next = original.remove("VAT");

      expect(original.taxTypes).toEqual(["VAT", "EWT"]);
      expect(next.taxTypes).toEqual(["EWT"]);
    });

    it("withInclusivity() leaves original state untouched", () => {
      const original = TaxManager.fromOne(makeVat({ inclusive: false }));

      const next = original.withInclusivity(true);

      expect(original.vat?.inclusive).toBe(false);
      expect(next.vat?.inclusive).toBe(true);
    });
  });

  // ===========================================================================
  // Behavioural invariants
  // ===========================================================================

  describe("Behavioural Invariants", () => {
    it("never contains duplicate tax identities after fromMany()", () => {
      const manager = TaxManager.fromMany([
        makeVat(),
        makeEwt(),
        makeInformational(),
      ]);

      const identities = manager.all.map(
        (tax) => `${tax.taxType}::${tax.jurisdiction ?? ""}`,
      );

      expect(new Set(identities).size).toBe(identities.length);
    });

    it("always exposes normalized tax types", () => {
      const manager = TaxManager.fromMany([
        makeVat({ taxType: " vat " }),
        makeEwt({ taxType: " eWt " }),
        makeInformational({
          taxType: " exempt ",
        }),
      ]);

      expect(manager.taxTypes).toEqual(["VAT", "EWT", "EXEMPT"]);
    });

    it("never accepts an inclusive withholding tax at construction", () => {
      expectValidationError(
        () => TaxManager.fromMany([makeEwt({ inclusive: true })]),
        /Withholding taxes cannot be inclusive/,
      );
    });

    it("enforces the one-inclusive-additive-tax invariant when adding", () => {
      const manager = TaxManager.fromOne(makeVat({ inclusive: true }));

      expectValidationError(
        () =>
          manager.add(
            makeVat({
              taxType: "LOCAL",
              rate: 0.05,
              inclusive: true,
            }),
          ),
        /At most one inclusive additive tax is allowed/,
      );
    });

    it("enforces the one-inclusive-additive-tax invariant when replacing", () => {
      const manager = TaxManager.fromMany([
        makeVat({ inclusive: true }),
        makeVat({
          taxType: "LOCAL",
          rate: 0.05,
          inclusive: false,
        }),
      ]);

      expectValidationError(
        () =>
          manager.replace(
            makeVat({
              taxType: "LOCAL",
              rate: 0.05,
              inclusive: true,
            }),
          ),
        /At most one inclusive additive tax is allowed/,
      );
    });
  });
});
