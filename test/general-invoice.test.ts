/**
 * @file general-invoice.test.ts
 *
 * Comprehensive unit test suite for the GeneralInvoice domain aggregate.
 *
 * Coverage:
 * - construction and defaults
 * - validation and runtime-invalid input
 * - identity and metadata mutations
 * - dates, terms, references
 * - lifecycle transitions and guards
 * - line-item operations
 * - default/per-line tax configuration
 * - tax inclusivity
 * - payment and settlement lifecycle
 * - computed getters and analytics
 * - tax breakdowns and discount summaries
 * - accounting projections
 * - foreign-exchange projections
 * - JSON serialization/deserialization
 * - canonical signing representation
 * - CSV/API projections
 * - immutability and domain invariants
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GeneralInvoice,
  InvoiceLifecycleError,
  InvoiceMutationError,
  InvoiceProjectionError,
  InvoiceValidationError,
} from "../src/core/general-invoice";

import type {
  AccountingContext,
  DocumentReference,
  GeneralInvoiceInput,
  GeneralInvoiceJSON,
  InvoiceStatus,
  LineItemInput,
  Party,
  PaymentTerms,
  Period,
  ProofOfPayment,
  TaxDetail,
} from "../src/core/general-invoice";

// ============================================================================
// Test Suite
// ============================================================================

describe("GeneralInvoice", () => {
  // ==========================================================================
  // Fixtures
  // ==========================================================================

  const makeIssuer = (overrides: Partial<Party> = {}): Party => ({
    legalName: "Majikah Solutions OPC",
    address: {
      country: "PH",
      city: "Mandaluyong",
      line1: "ABC 123",
    },
    ...overrides,
  });

  const makeRecipient = (overrides: Partial<Party> = {}): Party => ({
    legalName: "Example Client",
    address: {
      country: "US",
      city: "New York",
      line1: "XYZ 123",
    },
    ...overrides,
  });

  const makeLineItem = (
    overrides: Partial<LineItemInput> = {},
  ): LineItemInput => ({
    id: "li-1",
    description: "Software Development",
    quantity: 1,
    unitPrice: 50_000,
    unit: "hour",
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

  const makePeriod = (overrides: Partial<Period> = {}): Period => ({
    start: "2026-10-01",
    end: "2026-10-31",
    ...overrides,
  });

  const makeReference = (
    overrides: Partial<DocumentReference> = {},
  ): DocumentReference => ({
    type: "PO",
    number: "PO-001",
    ...overrides,
  });

  const makePayment = (
    overrides: Partial<ProofOfPayment> = {},
  ): ProofOfPayment => ({
    id: "pay-1",
    amount: 100,
    currency: "PHP",
    settledAt: "2026-10-02T10:00:00Z",
    method: "Cash",
    reference: "REF-001",
    ...overrides,
  });

  const makeBaseInput = (
    overrides: Partial<GeneralInvoiceInput> = {},
  ): GeneralInvoiceInput => ({
    issuer: makeIssuer(),
    recipient: makeRecipient(),
    currency: "PHP",
    lineItems: [makeLineItem()],
    ...overrides,
  });

  const createInvoice = (
    overrides: Partial<GeneralInvoiceInput> = {},
  ): GeneralInvoice => GeneralInvoice.create(makeBaseInput(overrides));

  const expectValidationError = (
    fn: () => unknown,
    message?: string | RegExp,
  ): InvoiceValidationError => {
    let thrown: unknown;

    try {
      fn();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvoiceValidationError);

    const error = thrown as InvoiceValidationError;

    if (message !== undefined) {
      if (typeof message === "string") {
        expect(error.message).toContain(message);
      } else {
        expect(error.message).toMatch(message);
      }
    }

    return error;
  };

  const expectMutationError = (
    fn: () => unknown,
    message?: string | RegExp,
  ): InvoiceMutationError => {
    let thrown: unknown;

    try {
      fn();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvoiceMutationError);

    const error = thrown as InvoiceMutationError;

    if (message !== undefined) {
      if (typeof message === "string") {
        expect(error.message).toContain(message);
      } else {
        expect(error.message).toMatch(message);
      }
    }

    return error;
  };

  const expectLifecycleError = (
    fn: () => unknown,
    message?: string | RegExp,
  ): InvoiceLifecycleError => {
    let thrown: unknown;

    try {
      fn();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvoiceLifecycleError);

    const error = thrown as InvoiceLifecycleError;

    if (message !== undefined) {
      if (typeof message === "string") {
        expect(error.message).toContain(message);
      } else {
        expect(error.message).toMatch(message);
      }
    }

    return error;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // Construction
  // ==========================================================================

  describe("Construction & Factory", () => {
    it("creates a GeneralInvoice instance", () => {
      const invoice = createInvoice();

      expect(invoice).toBeInstanceOf(GeneralInvoice);
    });

    it("generates an invoice ID when none is supplied", () => {
      const invoice = createInvoice();

      expect(invoice.id).toBeDefined();
      expect(typeof invoice.id).toBe("string");
      expect(invoice.id.length).toBeGreaterThan(0);
    });

    it("generates distinct IDs for separate invoices", () => {
      const first = createInvoice();
      const second = createInvoice();

      expect(first.id).not.toBe(second.id);
    });

    it("preserves an explicit invoice ID", () => {
      const invoice = createInvoice({
        id: "inv-001",
      });

      expect(invoice.id).toBe("inv-001");
    });

    it("preserves an explicit empty-string ID because the fallback is nullish", () => {
      const invoice = createInvoice({
        id: "",
      });

      expect(invoice.id).toBe("");
    });

    it("defaults type to commercial", () => {
      const invoice = createInvoice();

      expect(invoice.type).toBe("commercial");
    });

    it("defaults status to draft", () => {
      const invoice = createInvoice();

      expect(invoice.status).toBe("draft");
    });

    it("uses the current date when issueDate is omitted", () => {
      const invoice = createInvoice();

      expect(invoice.issueDate).toBe("2026-10-01");
    });

    it("sets createdAt to the current timestamp", () => {
      const invoice = createInvoice();

      expect(invoice.createdAt).toBe("2026-10-01T00:00:00.000Z");
    });

    it("sets updatedAt to the current timestamp", () => {
      const invoice = createInvoice();

      expect(invoice.updatedAt).toBe("2026-10-01T00:00:00.000Z");
    });

    it("sets the current schema version", () => {
      const invoice = createInvoice();

      expect(invoice.version).toBeDefined();
      expect(typeof invoice.version).toBe("string");
    });

    it("preserves all supplied top-level fields", () => {
      const invoice = createInvoice({
        id: "inv-002",
        invoiceNumber: "INV-2026-001",
        type: "tax",
        status: "draft",
        issueDate: "2026-09-01",
        dueDate: "2026-10-15",
        period: makePeriod(),
        paymentTerms: "custom",
        notes: "Thank you",
        tags: ["urgent", "software"],
        metadata: {
          source: "api",
        },
      });

      expect(invoice.id).toBe("inv-002");
      expect(invoice.invoiceNumber).toBe("INV-2026-001");
      expect(invoice.type).toBe("tax");
      expect(invoice.status).toBe("draft");
      expect(invoice.issueDate).toBe("2026-09-01");
      expect(invoice.dueDate).toBe("2026-10-15");
      expect(invoice.period).toEqual(makePeriod());
      expect(invoice.paymentTerms).toEqual("custom");
      expect(invoice.notes).toBe("Thank you");
      expect(invoice.tags).toEqual(["urgent", "software"]);
      expect(invoice.metadata).toEqual({
        source: "api",
      });
    });

    it("constructs calculated totals from line items", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            quantity: 2,
            unitPrice: 1_000,
          }),
        ],
      });

      expect(invoice.totals.subtotalAmount).toBe(2_000);
      expect(invoice.totals.grandTotalAmount).toBe(2_000);
      expect(invoice.totalAmount).toBe(2_000);
    });

    it("starts with no proof-of-payment records", () => {
      const invoice = createInvoice();

      expect(invoice.proofOfPayments).toEqual([]);
      expect(invoice.paymentStatus).toBe("pending");
    });

    it("normalizes invoice-level default taxes into TaxManager", () => {
      const invoice = createInvoice({
        defaultTaxes: [makeVat()],
      });

      expect(invoice.defaultTaxes).toBeDefined();
      expect(invoice.defaultTaxes.hasTaxType("VAT")).toBe(true);
    });
  });

  // ==========================================================================
  // Validation
  // ==========================================================================

  describe("validate()", () => {
    it("returns valid=true for a valid invoice", () => {
      const result = GeneralInvoice.validate(makeBaseInput());

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("does not throw for valid input", () => {
      expect(() => GeneralInvoice.validate(makeBaseInput())).not.toThrow();
    });

    it("requires issuer", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          issuer: undefined,
        } as never),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "issuer",
          }),
        ]),
      );
    });

    it("requires issuer legalName", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          issuer: makeIssuer({
            legalName: "   ",
          }),
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "issuer.legalName",
          }),
        ]),
      );
    });

    it("requires recipient", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          recipient: undefined,
        } as never),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "recipient",
          }),
        ]),
      );
    });

    it("requires recipient legalName", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          recipient: makeRecipient({
            legalName: " ",
          }),
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "recipient.legalName",
          }),
        ]),
      );
    });

    it.each([
      ["", "Currency is required"],
      ["PH", "valid ISO 4217"],
      ["P", "valid ISO 4217"],
      ["PHPH", "valid ISO 4217"],
      ["php", "valid ISO 4217"],
      ["12P", "valid ISO 4217"],
    ])("rejects invalid currency %s", (currency, expectedMessage) => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          currency,
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "currency",
          }),
        ]),
      );
      expect(
        result.errors.some((e) => e.message.includes(expectedMessage)),
      ).toBe(true);
    });

    it("requires at least one line item", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          lineItems: [],
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "lineItems",
          }),
        ]),
      );
    });

    it("rejects invalid issueDate format", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          issueDate: "2026/10/01",
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "issueDate",
          }),
        ]),
      );
    });

    it("rejects invalid dueDate format", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          dueDate: "2026/10/15",
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "dueDate",
          }),
        ]),
      );
    });

    it("rejects dueDate before issueDate", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          issueDate: "2026-10-10",
          dueDate: "2026-10-01",
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "dueDate",
            message: expect.stringContaining("before issueDate"),
          }),
        ]),
      );
    });

    it("accepts dueDate equal to issueDate", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          issueDate: "2026-10-10",
          dueDate: "2026-10-10",
        }),
      );

      expect(result.valid).toBe(true);
    });

    it("rejects reversed period", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          period: {
            start: "2026-10-31",
            end: "2026-10-01",
          },
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "period",
          }),
        ]),
      );
    });

    it("rejects incomplete period", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          period: {
            start: "2026-10-01",
            end: undefined,
          } as never,
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "period",
          }),
        ]),
      );
    });

    it("accepts a same-day period", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          period: {
            start: "2026-10-01",
            end: "2026-10-01",
          },
        }),
      );

      expect(result.valid).toBe(true);
    });

    it("rejects invalid issuer country code", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          issuer: makeIssuer({
            address: {
              country: "USA",
              city: "Manila",
              line1: "ABC",
            },
          }),
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "issuer.address.country",
          }),
        ]),
      );
    });

    it("rejects invalid recipient country code", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          recipient: makeRecipient({
            address: {
              country: "USX",
              city: "New York",
              line1: "XYZ",
            },
          }),
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "recipient.address.country",
          }),
        ]),
      );
    });

    it("validates default taxes", () => {
      const result = GeneralInvoice.validate(
        makeBaseInput({
          defaultTaxes: [
            {
              taxType: "VAT",
              rate: 2,
            },
          ],
        }),
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "defaultTaxes[0].rate",
          }),
        ]),
      );
    });

    it("collects multiple validation errors", () => {
      const result = GeneralInvoice.validate({
        issuer: {
          legalName: " ",
        },
        recipient: {
          legalName: " ",
        },
        currency: "PH",
        lineItems: [],
        dueDate: "bad",
      } as GeneralInvoiceInput);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  // ==========================================================================
  // assertValid()
  // ==========================================================================

  describe("assertValid()", () => {
    it("does not throw for valid input", () => {
      expect(() => GeneralInvoice.assertValid(makeBaseInput())).not.toThrow();
    });

    it("throws InvoiceValidationError for invalid input", () => {
      expectValidationError(() =>
        GeneralInvoice.assertValid(
          makeBaseInput({
            currency: "PH",
          }),
        ),
      );
    });

    it("combines multiple validation errors", () => {
      const error = expectValidationError(() =>
        GeneralInvoice.assertValid({
          issuer: {
            legalName: "",
          },
          recipient: {
            legalName: "",
          },
          currency: "PH",
          lineItems: [],
        } as GeneralInvoiceInput),
      );

      expect(error.message).toContain("issuer.legalName");
      expect(error.message).toContain("recipient.legalName");
      expect(error.message).toContain("currency");
      expect(error.message).toContain("lineItems");
    });

    it("prevents create() from constructing invalid invoices", () => {
      expectValidationError(() =>
        GeneralInvoice.create(
          makeBaseInput({
            lineItems: [],
          }),
        ),
      );
    });
  });

  // ==========================================================================
  // Identity & Metadata
  // ==========================================================================

  describe("Identity & Metadata Mutations", () => {
    let invoice: GeneralInvoice;

    beforeEach(() => {
      invoice = createInvoice();
    });

    describe("withInvoiceNumber()", () => {
      it("sets the invoice number", () => {
        const updated = invoice.withInvoiceNumber("  INV-001  ");

        expect(updated.invoiceNumber).toBe("INV-001");
      });

      it("returns a new invoice instance", () => {
        const updated = invoice.withInvoiceNumber("INV-001");

        expect(updated).not.toBe(invoice);
      });

      it("does not mutate the original", () => {
        invoice.withInvoiceNumber("INV-001");

        expect(invoice.invoiceNumber).toBeUndefined();
      });

      it("refreshes updatedAt", () => {
        vi.advanceTimersByTime(1000);

        const updated = invoice.withInvoiceNumber("INV-001");

        expect(updated.updatedAt).not.toBe(invoice.updatedAt);
      });

      it("rejects empty invoice number", () => {
        expectValidationError(
          () => invoice.withInvoiceNumber("   "),
          /Invoice number cannot be empty/,
        );
      });

      it("rejects non-string invoice number at runtime", () => {
        expectValidationError(() => invoice.withInvoiceNumber(123 as never));
      });

      it("is blocked on a voided invoice", () => {
        const voided = invoice.voidInvoice();

        expectMutationError(() => voided.withInvoiceNumber("INV-002"));
      });
    });

    describe("withNotes()", () => {
      it("sets and trims notes", () => {
        const updated = invoice.withNotes("  Important note  ");

        expect(updated.notes).toBe("Important note");
      });

      it("allows empty string and stores an empty value", () => {
        const updated = invoice.withNotes("");

        expect(updated.notes).toBe("");
      });

      it("rejects non-string notes", () => {
        expectValidationError(() => invoice.withNotes(123 as never));
      });

      it("does not mutate the original", () => {
        const updated = invoice.withNotes("Note");

        expect(invoice.notes).toBeUndefined();
        expect(updated.notes).toBe("Note");
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice.voidInvoice();

        expectMutationError(() => voided.withNotes("new"));
      });
    });

    describe("withoutNotes()", () => {
      it("removes notes", () => {
        const updated = invoice.withNotes("Note").withoutNotes();

        expect(updated.notes).toBeUndefined();
      });

      it("does not mutate the original", () => {
        const noted = invoice.withNotes("Note");

        const cleared = noted.withoutNotes();

        expect(noted.notes).toBe("Note");
        expect(cleared.notes).toBeUndefined();
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice.withNotes("Note").voidInvoice();

        expectMutationError(() => voided.withoutNotes());
      });
    });

    describe("withTag()", () => {
      it("adds a trimmed tag", () => {
        const updated = invoice.withTag("  urgent  ");

        expect(updated.tags).toEqual(["urgent"]);
      });

      it("prevents duplicate tags", () => {
        const tagged = invoice.withTag("urgent").withTag("urgent");

        expect(tagged.tags).toEqual(["urgent"]);
      });

      it("returns the same instance when tag already exists", () => {
        const tagged = invoice.withTag("urgent");

        expect(tagged.withTag("urgent")).toBe(tagged);
      });

      it("rejects empty tags", () => {
        expectValidationError(() => invoice.withTag("   "));
      });

      it("rejects non-string tags at runtime", () => {
        expectValidationError(() => invoice.withTag(123 as never));
      });

      it("does not mutate the original", () => {
        const updated = invoice.withTag("urgent");

        expect(invoice.tags).toBeUndefined();
        expect(updated.tags).toEqual(["urgent"]);
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice.voidInvoice();

        expectMutationError(() => voided.withTag("urgent"));
      });
    });

    describe("withoutTag()", () => {
      it("removes the matching tag", () => {
        const updated = invoice
          .withTag("urgent")
          .withTag("paid")
          .withoutTag("urgent");

        expect(updated.tags).toEqual(["paid"]);
      });

      it("is a no-op in terms of data for an absent tag", () => {
        const tagged = invoice.withTag("urgent");

        const updated = tagged.withoutTag("missing");

        expect(updated.tags).toEqual(["urgent"]);
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice.withTag("urgent").voidInvoice();

        expectMutationError(() => voided.withoutTag("urgent"));
      });
    });

    describe("withTags()", () => {
      it("replaces all tags", () => {
        const updated = invoice.withTags([" urgent ", "software", "urgent"]);

        expect(updated.tags).toEqual(["urgent", "software"]);
      });

      it("accepts an empty tag collection", () => {
        const updated = invoice.withTags([]);

        expect(updated.tags).toEqual([]);
      });

      it("rejects non-array input", () => {
        expectValidationError(() => invoice.withTags("urgent" as never));
      });

      it("rejects empty tag values", () => {
        expectValidationError(
          () => invoice.withTags(["urgent", " "]),
          /empty or invalid/,
        );
      });

      it("rejects non-string tag values", () => {
        expectValidationError(() => invoice.withTags(["urgent", 123] as never));
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice.voidInvoice();

        expectMutationError(() => voided.withTags(["urgent"]));
      });
    });

    describe("withMetadata()", () => {
      it("adds new metadata", () => {
        const updated = invoice.withMetadata({
          source: "api",
        });

        expect(updated.metadata).toEqual({
          source: "api",
        });
      });

      it("merges into existing metadata", () => {
        const updated = invoice
          .withMetadataReplaced({
            a: 1,
            b: 2,
          })
          .withMetadata({
            b: 3,
            c: 4,
          });

        expect(updated.metadata).toEqual({
          a: 1,
          b: 3,
          c: 4,
        });
      });

      it("removes metadata keys assigned null", () => {
        const updated = invoice
          .withMetadataReplaced({
            a: 1,
            b: 2,
          })
          .withMetadata({
            b: null,
          });

        expect(updated.metadata).toEqual({
          a: 1,
        });
      });

      it("rejects a null metadata patch", () => {
        expectValidationError(() => invoice.withMetadata(null as never));
      });

      it("rejects an array metadata patch", () => {
        expectValidationError(() => invoice.withMetadata([] as never));
      });

      it("rejects primitive metadata patches", () => {
        expectValidationError(() => invoice.withMetadata("invalid" as never));
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice.voidInvoice();

        expectMutationError(() =>
          voided.withMetadata({
            a: 1,
          }),
        );
      });
    });

    describe("withMetadataReplaced()", () => {
      it("replaces all metadata", () => {
        const updated = invoice
          .withMetadataReplaced({
            a: 1,
            b: 2,
          })
          .withMetadataReplaced({
            c: 3,
          });

        expect(updated.metadata).toEqual({
          c: 3,
        });
      });

      it("clones the replacement object", () => {
        const metadata = {
          source: "api",
        };

        const updated = invoice.withMetadataReplaced(metadata);

        metadata.source = "changed";

        expect(updated.metadata).toEqual({
          source: "api",
        });
      });

      it("rejects null", () => {
        expectValidationError(() =>
          invoice.withMetadataReplaced(null as never),
        );
      });

      it("rejects arrays", () => {
        expectValidationError(() => invoice.withMetadataReplaced([] as never));
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice.voidInvoice();

        expectMutationError(() =>
          voided.withMetadataReplaced({
            a: 1,
          }),
        );
      });
    });

    describe("withoutMetadata()", () => {
      it("removes all metadata", () => {
        const updated = invoice
          .withMetadataReplaced({
            a: 1,
          })
          .withoutMetadata();

        expect(updated.metadata).toBeUndefined();
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice
          .withMetadataReplaced({
            a: 1,
          })
          .voidInvoice();

        expectMutationError(() => voided.withoutMetadata());
      });
    });
  });

  // ==========================================================================
  // Dates / Terms / References
  // ==========================================================================

  describe("Dates, Terms & References", () => {
    describe("withIssueDate()", () => {
      it("updates issueDate on draft invoices", () => {
        const invoice = createInvoice();

        const updated = invoice.withIssueDate("2026-09-15");

        expect(updated.issueDate).toBe("2026-09-15");
      });

      it("rejects invalid date format", () => {
        expectValidationError(
          () => createInvoice().withIssueDate("09/15/2026" as never),
          /YYYY-MM-DD/,
        );
      });

      it("rejects an issueDate after dueDate", () => {
        const invoice = createInvoice({
          issueDate: "2026-09-01",
          dueDate: "2026-10-15",
        });

        expectValidationError(() => invoice.withIssueDate("2026-11-01"));
      });

      it("is restricted to draft status", () => {
        const issued = createInvoice().issue();

        expectMutationError(() => issued.withIssueDate("2026-09-01"));
      });
    });

    describe("withDueDate()", () => {
      it("sets dueDate", () => {
        const updated = createInvoice().withDueDate("2026-10-31");

        expect(updated.dueDate).toBe("2026-10-31");
      });

      it("works after issuance because due-date editing is not draft restricted", () => {
        const issued = createInvoice().issue();

        const updated = issued.withDueDate("2026-10-31");

        expect(updated.dueDate).toBe("2026-10-31");
      });

      it("rejects a dueDate before issueDate", () => {
        expectValidationError(() =>
          createInvoice({
            issueDate: "2026-10-10",
          }).withDueDate("2026-10-01"),
        );
      });

      it("rejects invalid dueDate format", () => {
        expectValidationError(() =>
          createInvoice().withDueDate("bad" as never),
        );
      });

      it("is blocked on voided invoices", () => {
        const voided = createInvoice().voidInvoice();

        expectMutationError(() => voided.withDueDate("2026-10-31"));
      });
    });

    describe("withoutDueDate()", () => {
      it("removes dueDate", () => {
        const updated = createInvoice({
          dueDate: "2026-10-31",
        }).withoutDueDate();

        expect(updated.dueDate).toBeUndefined();
      });

      it("is blocked on voided invoices", () => {
        const voided = createInvoice({
          dueDate: "2026-10-31",
        }).voidInvoice();

        expectMutationError(() => voided.withoutDueDate());
      });
    });

    describe("withPeriod()", () => {
      it("sets a valid period", () => {
        const period = makePeriod();

        const updated = createInvoice().withPeriod(period);

        expect(updated.period).toEqual(period);
      });

      it("clones the period object", () => {
        const period = makePeriod();

        const updated = createInvoice().withPeriod(period);

        period.end = "2026-12-31";

        expect(updated.period).toEqual({
          start: "2026-10-01",
          end: "2026-10-31",
        });
      });

      it("rejects null", () => {
        expectValidationError(() => createInvoice().withPeriod(null as never));
      });

      it("rejects reversed period", () => {
        expectValidationError(() =>
          createInvoice().withPeriod({
            start: "2026-10-31",
            end: "2026-10-01",
          }),
        );
      });

      it("rejects invalid start date", () => {
        expectValidationError(() =>
          createInvoice().withPeriod({
            start: "bad",
            end: "2026-10-31",
          }),
        );
      });

      it("rejects invalid end date", () => {
        expectValidationError(() =>
          createInvoice().withPeriod({
            start: "2026-10-01",
            end: "bad",
          }),
        );
      });

      it("is restricted to draft status", () => {
        const issued = createInvoice().issue();

        expectMutationError(() => issued.withPeriod(makePeriod()));
      });
    });

    describe("withoutPeriod()", () => {
      it("removes the period", () => {
        const updated = createInvoice({
          period: makePeriod(),
        }).withoutPeriod();

        expect(updated.period).toBeUndefined();
      });

      it("is restricted to draft status", () => {
        const issued = createInvoice({
          period: makePeriod(),
        }).issue();

        expectMutationError(() => issued.withoutPeriod());
      });
    });

    describe("withPaymentTerms()", () => {
      it("sets payment terms", () => {
        const terms: PaymentTerms = "net60";

        const updated = createInvoice().withPaymentTerms(terms);

        expect(updated.paymentTerms).toEqual(terms);
      });

      it("preserves the supplied payment terms value", () => {
        const terms: PaymentTerms = "net60";

        const updated = createInvoice().withPaymentTerms(terms);

        expect(updated.paymentTerms).toBe(terms);
      });

      it("rejects empty terms", () => {
        expectValidationError(() =>
          createInvoice().withPaymentTerms(null as never),
        );
      });

      it("is blocked on voided invoices", () => {
        const voided = createInvoice().voidInvoice();

        expectMutationError(() => voided.withPaymentTerms("net60"));
      });
    });

    describe("references", () => {
      it("adds and trims a reference", () => {
        const updated = createInvoice().withReference({
          type: " PO ",
          number: " PO-100 ",
        });

        expect(updated.references).toEqual([
          {
            type: "PO",
            number: "PO-100",
          },
        ]);
      });

      it("rejects a missing reference", () => {
        expectValidationError(() =>
          createInvoice().withReference(null as never),
        );
      });

      it("rejects empty reference type", () => {
        expectValidationError(() =>
          createInvoice().withReference({
            type: " ",
            number: "PO-001",
          }),
        );
      });

      it("rejects empty reference number", () => {
        expectValidationError(() =>
          createInvoice().withReference({
            type: "PO",
            number: " ",
          }),
        );
      });

      it("replaces all references", () => {
        const updated = createInvoice().withReferences([
          makeReference({
            type: "PO",
            number: "PO-001",
          }),
          makeReference({
            type: "CONTRACT",
            number: "C-001",
          }),
        ]);

        expect(updated.references).toHaveLength(2);
      });

      it("rejects non-array references", () => {
        expectValidationError(() =>
          createInvoice().withReferences({} as never),
        );
      });

      it("rejects an invalid reference inside the array", () => {
        expectValidationError(() =>
          createInvoice().withReferences([
            makeReference(),
            {
              type: "",
              number: "BAD",
            },
          ]),
        );
      });

      it("removes a matching reference", () => {
        const updated = createInvoice()
          .withReference(makeReference())
          .withReference({
            type: "CONTRACT",
            number: "C-001",
          })
          .withoutReference("PO", "PO-001");

        expect(updated.references).toEqual([
          {
            type: "CONTRACT",
            number: "C-001",
          },
        ]);
      });

      it("clears all references", () => {
        const updated = createInvoice()
          .withReference(makeReference())
          .withoutReferences();

        expect(updated.references).toBeUndefined();
      });

      it("blocks reference mutation on voided invoices", () => {
        const voided = createInvoice().voidInvoice();

        expectMutationError(() => voided.withReference(makeReference()));

        expectMutationError(() => voided.withReferences([makeReference()]));

        expectMutationError(() => voided.withoutReference("PO", "PO-001"));

        expectMutationError(() => voided.withoutReferences());
      });
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe("Lifecycle", () => {
    describe("draft", () => {
      it("starts as draft", () => {
        const invoice = createInvoice();

        expect(invoice.status).toBe("draft");
        expect(invoice.isDraft).toBe(true);
      });

      it("allows draft -> issued", () => {
        const invoice = createInvoice();

        expect(invoice.canTransitionTo("issued")).toBe(true);

        const issued = invoice.issue();

        expect(issued.status).toBe("issued");
      });

      it("allows draft -> void", () => {
        const invoice = createInvoice();

        const voided = invoice.voidInvoice();

        expect(voided.status).toBe("void");
      });

      it("allows staying in draft through withStatus", () => {
        const invoice = createInvoice();

        expect(invoice.withStatus("draft")).toBe(invoice);
      });
    });

    describe("normal progression", () => {
      it("supports draft -> issued -> sent -> viewed", () => {
        const invoice = createInvoice();

        const issued = invoice.issue();

        const sent = issued.send();

        const viewed = sent.view();

        expect(issued.status).toBe("issued");
        expect(sent.status).toBe("sent");
        expect(viewed.status).toBe("viewed");
      });

      it("reports status getters correctly", () => {
        const issued = createInvoice().issue();

        expect(issued.isSent).toBe(false);
        expect(issued.isViewed).toBe(false);

        const sent = issued.send();

        expect(sent.isSent).toBe(true);

        const viewed = sent.view();

        expect(viewed.isViewed).toBe(true);
      });
    });

    describe("invalid transitions", () => {
      it("rejects draft -> paid", () => {
        const invoice = createInvoice();

        expectLifecycleError(() => invoice.markAsPaid());
      });

      it("rejects draft -> partial", () => {
        const invoice = createInvoice();

        expectLifecycleError(() => invoice.markAsPartiallyPaid());
      });

      it("rejects draft -> disputed", () => {
        const invoice = createInvoice();

        expectLifecycleError(() => invoice.dispute());
      });

      it("rejects paid -> draft", () => {
        const paid = createInvoice().issue().markAsPaid();

        expectLifecycleError(() => paid.withStatus("draft"));
      });

      it("rejects void -> any non-terminal status", () => {
        const voided = createInvoice().voidInvoice();

        expectLifecycleError(() => voided.withStatus("draft"));

        expectLifecycleError(() => voided.withStatus("issued"));
      });

      it("returns false from canTransitionTo for invalid transitions", () => {
        const invoice = createInvoice();

        expect(invoice.canTransitionTo("paid")).toBe(false);
      });
    });

    describe("allowedTransitions()", () => {
      const expected: Record<InvoiceStatus, InvoiceStatus[]> = {
        draft: ["draft", "issued", "void"],
        issued: ["sent", "viewed", "partial", "paid", "disputed", "void"],
        sent: ["viewed", "partial", "paid", "disputed", "void"],
        viewed: ["partial", "paid", "disputed", "void"],
        partial: ["paid", "disputed", "void"],
        paid: ["void"],
        overdue: ["paid", "partial", "disputed", "void"],
        disputed: ["issued", "void"],
        void: [],
      };

      it.each(Object.entries(expected))(
        "returns the correct destinations from %s",
        (status, allowed) => {
          const invoice = createInvoice().withStatus(
            status as InvoiceStatus,
            true,
          );

          expect(invoice.allowedTransitions()).toEqual(allowed);
        },
      );

      it("returns a copy that cannot modify lifecycle configuration", () => {
        const invoice = createInvoice();

        const transitions = invoice.allowedTransitions();

        transitions.push("paid");

        expect(invoice.allowedTransitions()).not.toContain("paid");
      });
    });

    describe("forced transitions", () => {
      it("allows an otherwise invalid transition when force=true", () => {
        const invoice = createInvoice();

        const paid = invoice.withStatus("paid", true);

        expect(paid.status).toBe("paid");
      });

      it("returns the same instance when target status is already current", () => {
        const invoice = createInvoice();

        expect(invoice.withStatus("draft", true)).toBe(invoice);
      });
    });

    describe("voiding", () => {
      it("marks the invoice void", () => {
        const voided = createInvoice().voidInvoice();

        expect(voided.isVoided).toBe(true);
        expect(voided.isTerminal).toBe(true);
      });

      it("appends the void reason to notes", () => {
        const voided = createInvoice()
          .withNotes("Existing note")
          .voidInvoice("Cancelled by user");

        expect(voided.notes).toContain("Existing note");

        expect(voided.notes).toContain("VOID REASON: Cancelled by user");
      });

      it("can void without a reason", () => {
        const voided = createInvoice().voidInvoice();

        expect(voided.status).toBe("void");
      });

      it("blocks normal editable mutations after voiding", () => {
        const voided = createInvoice().withNotes("Note").voidInvoice();

        expectMutationError(() => voided.withNotes("Changed"));

        expectMutationError(() => voided.withTag("new"));

        expectMutationError(() => voided.withDueDate("2026-12-01"));

        expectMutationError(() =>
          voided.addPayment(
            makePayment({
              amount: 10,
            }),
          ),
        );
      });
    });

    describe("dispute", () => {
      it("moves issued -> disputed", () => {
        const disputed = createInvoice().issue().dispute("Incorrect total");

        expect(disputed.status).toBe("disputed");
        expect(disputed.isDisputed).toBe(true);
      });

      it("appends a dispute reason", () => {
        const disputed = createInvoice()
          .withNotes("Original")
          .issue()
          .dispute("Incorrect total");

        expect(disputed.notes).toContain("DISPUTE REASON: Incorrect total");
      });

      it("supports dispute without reason", () => {
        const disputed = createInvoice().issue().dispute();

        expect(disputed.status).toBe("disputed");
      });

      it("resolves a dispute back to issued", () => {
        const resolved = createInvoice()
          .issue()
          .dispute("Incorrect total")
          .resolveDispute("Corrected");

        expect(resolved.status).toBe("issued");
        expect(resolved.notes).toContain("RESOLUTION: Corrected");
      });

      it("rejects resolving an undisputed invoice", () => {
        expectLifecycleError(() => createInvoice().resolveDispute("Corrected"));
      });
    });

    describe("overdue", () => {
      it("is not overdue without a due date", () => {
        const invoice = createInvoice();

        expect(invoice.isOverdue).toBe(false);
        expect(invoice.effectiveStatus).toBe(invoice.status);
      });

      it("becomes overdue after due date when unpaid", () => {
        const invoice = createInvoice({
          dueDate: "2026-09-30",
        }).issue();

        expect(invoice.isOverdue).toBe(true);
        expect(invoice.effectiveStatus).toBe("overdue");
        expect(invoice.status).toBe("issued");
      });

      it("is not overdue on the due date itself", () => {
        const invoice = createInvoice({
          dueDate: "2026-10-01",
        }).issue();

        expect(invoice.isOverdue).toBe(false);
      });

      it("does not become overdue when fully paid", () => {
        const invoice = createInvoice({
          dueDate: "2026-09-30",
        }).issue();

        const paid = invoice.addPayment(
          makePayment({
            amount: 50_000,
          }),
        );

        expect(paid.isFullyPaid).toBe(true);
        expect(paid.isOverdue).toBe(false);
      });

      it("does not become overdue when status is paid", () => {
        const invoice = createInvoice({
          dueDate: "2026-09-30",
        }).issue();

        const paid = invoice.markAsPaid();

        expect(paid.isOverdue).toBe(false);
      });

      it("does not become overdue when status is disputed", () => {
        const disputed = createInvoice({
          dueDate: "2026-09-30",
        })
          .issue()
          .dispute();

        expect(disputed.isOverdue).toBe(false);
      });

      it("does not become overdue when status is void", () => {
        const voided = createInvoice({
          dueDate: "2026-09-30",
        }).voidInvoice();

        expect(voided.isOverdue).toBe(false);
      });

      it("markAsOverdue requires the invoice to actually be overdue", () => {
        const invoice = createInvoice({
          dueDate: "2026-10-01",
        }).issue();

        expectLifecycleError(() => invoice.markAsOverdue());
      });

      it("markAsOverdue can be forced", () => {
        const invoice = createInvoice().issue();

        const overdue = invoice.markAsOverdue(true);

        expect(overdue.status).toBe("overdue");
      });

      it("marks an actually overdue invoice as overdue", () => {
        const invoice = createInvoice({
          dueDate: "2026-09-30",
        }).issue();

        const overdue = invoice.markAsOverdue();

        expect(overdue.status).toBe("overdue");
      });
    });

    describe("restartInvoice()", () => {
      it("restarts a voided invoice as draft", () => {
        const original = createInvoice().issue().voidInvoice("Cancelled");

        const restarted = original.restartInvoice();

        expect(restarted).not.toBe(original);

        expect(restarted.status).toBe("draft");
        expect(restarted.proofOfPayments).toEqual([]);
      });

      it("preserves invoice financial data", () => {
        const original = createInvoice({
          invoiceNumber: "INV-001",
          dueDate: "2026-10-31",
          lineItems: [
            makeLineItem({
              quantity: 2,
            }),
          ],
        })
          .issue()
          .voidInvoice();

        const restarted = original.restartInvoice();

        expect(restarted.id).toBe(original.id);

        expect(restarted.invoiceNumber).toBe(original.invoiceNumber);

        expect(restarted.totals.grandTotalAmount).toBe(
          original.totals.grandTotalAmount,
        );

        expect(restarted.dueDate).toBe(original.dueDate);
      });
    });
  });

  // ==========================================================================
  // Line Items
  // ==========================================================================

  describe("Line Item Operations", () => {
    let invoice: GeneralInvoice;

    beforeEach(() => {
      invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "li-1",
            quantity: 1,
            unitPrice: 1_000,
          }),
        ],
      });
    });

    describe("withLineItem()", () => {
      it("adds a line item", () => {
        const updated = invoice.withLineItem(
          makeLineItem({
            id: "li-2",
            description: "Consulting",
            quantity: 2,
            unitPrice: 500,
          }),
        );

        expect(updated.lineItemCount).toBe(2);
      });

      it("recalculates invoice totals", () => {
        const updated = invoice.withLineItem(
          makeLineItem({
            id: "li-2",
            quantity: 2,
            unitPrice: 500,
          }),
        );

        expect(updated.subtotalAmount).toBe(2_000);

        expect(updated.totalAmount).toBe(2_000);
      });

      it("does not mutate original line items", () => {
        const updated = invoice.withLineItem(
          makeLineItem({
            id: "li-2",
          }),
        );

        expect(invoice.lineItemCount).toBe(1);

        expect(updated.lineItemCount).toBe(2);
      });

      it("is restricted to draft invoices", () => {
        const issued = invoice.issue();

        expectMutationError(() =>
          issued.withLineItem(
            makeLineItem({
              id: "li-2",
            }),
          ),
        );
      });

      it("validates the new line item", () => {
        expect(() =>
          invoice.withLineItem({
            id: "li-2",
            description: "",
            quantity: 1,
            unitPrice: 100,
          }),
        ).toThrow();
      });
    });

    describe("withLineItems()", () => {
      it("replaces all line items", () => {
        const updated = invoice.withLineItems([
          makeLineItem({
            id: "new-1",
            unitPrice: 2_000,
          }),
          makeLineItem({
            id: "new-2",
            unitPrice: 3_000,
          }),
        ]);

        expect(updated.lineItemCount).toBe(2);

        expect(updated.lineItems.map((li) => li.id)).toEqual([
          "new-1",
          "new-2",
        ]);
      });

      it("recalculates totals", () => {
        const updated = invoice.withLineItems([
          makeLineItem({
            id: "new-1",
            unitPrice: 2_000,
          }),
          makeLineItem({
            id: "new-2",
            unitPrice: 3_000,
          }),
        ]);

        expect(updated.subtotalAmount).toBe(5_000);
      });

      it("rejects an empty array", () => {
        expectValidationError(() => invoice.withLineItems([]));
      });

      it("rejects non-array input", () => {
        expectValidationError(() => invoice.withLineItems({} as never));
      });

      it("is restricted to draft invoices", () => {
        const issued = invoice.issue();

        expectMutationError(() =>
          issued.withLineItems([
            makeLineItem({
              id: "li-2",
            }),
          ]),
        );
      });
    });

    describe("withoutLineItem()", () => {
      it("removes a line item", () => {
        const updated = invoice
          .withLineItem(
            makeLineItem({
              id: "li-2",
            }),
          )
          .withoutLineItem("li-2");

        expect(updated.lineItemCount).toBe(1);
      });

      it("recalculates totals after removal", () => {
        const updated = invoice
          .withLineItem(
            makeLineItem({
              id: "li-2",
              unitPrice: 2_000,
            }),
          )
          .withoutLineItem("li-2");

        expect(updated.subtotalAmount).toBe(1_000);
      });

      it("rejects an empty ID", () => {
        expectValidationError(() => invoice.withoutLineItem(" "));
      });

      it("rejects a missing ID", () => {
        expectValidationError(() => invoice.withoutLineItem("does-not-exist"));
      });

      it("prevents removing the final line item", () => {
        expectValidationError(() => invoice.withoutLineItem("li-1"));
      });

      it("is restricted to draft invoices", () => {
        const issued = invoice
          .withLineItem(
            makeLineItem({
              id: "li-2",
            }),
          )
          .issue();

        expectMutationError(() => issued.withoutLineItem("li-2"));
      });
    });

    describe("withUpdatedLineItem()", () => {
      it("updates quantity", () => {
        const updated = invoice.withUpdatedLineItem("li-1", {
          quantity: 5,
        });

        expect(updated.lineItems[0].quantity).toBe(5);
      });

      it("updates unit price", () => {
        const updated = invoice.withUpdatedLineItem("li-1", {
          unitPrice: 2_500,
        });

        expect(updated.lineItems[0].unitPrice.toMajor()).toBe(2_500);
      });

      it("updates description", () => {
        const updated = invoice.withUpdatedLineItem("li-1", {
          description: "Updated Service",
        });

        expect(updated.lineItems[0].description).toBe("Updated Service");
      });

      it("updates discount", () => {
        const updated = invoice.withUpdatedLineItem("li-1", {
          discount: {
            type: "percentage",
            value: 0.1,
          },
        });

        expect(updated.lineItems[0].discount).toEqual({
          type: "percentage",
          value: 0.1,
        });
      });

      it("recalculates totals after an update", () => {
        const updated = invoice.withUpdatedLineItem("li-1", {
          quantity: 2,
        });

        expect(updated.totalAmount).toBe(2_000);
      });

      it("preserves unspecified fields", () => {
        const original = invoice.lineItems[0];

        const updated = invoice.withUpdatedLineItem("li-1", {
          quantity: 2,
        });

        expect(updated.lineItems[0].unit).toBe(original.unit);

        expect(updated.lineItems[0].description).toBe(original.description);
      });

      it("rejects empty ID", () => {
        expectValidationError(() =>
          invoice.withUpdatedLineItem(" ", {
            quantity: 2,
          }),
        );
      });

      it("rejects unknown ID", () => {
        expectValidationError(() =>
          invoice.withUpdatedLineItem("missing", {
            quantity: 2,
          }),
        );
      });

      it("rejects null patch", () => {
        expectValidationError(() =>
          invoice.withUpdatedLineItem("li-1", null as never),
        );
      });

      it("rejects an array patch", () => {
        expectValidationError(() =>
          invoice.withUpdatedLineItem("li-1", [] as never),
        );
      });

      it("rejects invalid quantity inside the patch", () => {
        expect(() =>
          invoice.withUpdatedLineItem("li-1", {
            quantity: 0,
          }),
        ).toThrow(/quantity must be greater than zero/);
      });

      it("is restricted to draft invoices", () => {
        const issued = invoice.issue();

        expectMutationError(() =>
          issued.withUpdatedLineItem("li-1", {
            quantity: 2,
          }),
        );
      });
    });

    describe("withClearedLineItems()", () => {
      it("clears every line item", () => {
        const cleared = invoice
          .withLineItem(
            makeLineItem({
              id: "li-2",
            }),
          )
          .withClearedLineItems();

        expect(cleared.lineItemCount).toBe(0);
      });

      it("recalculates totals to zero", () => {
        const cleared = invoice.withClearedLineItems();

        expect(cleared.subtotalAmount).toBe(0);
        expect(cleared.totalAmount).toBe(0);
      });

      it("is restricted to draft invoices", () => {
        const issued = invoice.issue();

        expectMutationError(() => issued.withClearedLineItems());
      });
    });
  });

  // ==========================================================================
  // Tax Configuration
  // ==========================================================================

  describe("Tax Configuration", () => {
    describe("withDefaultTaxes()", () => {
      it("sets an invoice default tax", () => {
        const invoice = createInvoice();

        const updated = invoice.withDefaultTaxes(makeVat());

        expect(updated.defaultTaxes.hasTaxType("VAT")).toBe(true);
      });

      it("accepts a TaxManager", () => {
        const taxes = createInvoice().defaultTaxes;

        const updated = createInvoice().withDefaultTaxes(taxes);

        expect(updated.defaultTaxes.all).toEqual(taxes.all);
      });

      it("accepts an array of taxes", () => {
        const updated = createInvoice().withDefaultTaxes([
          makeVat(),
          makeEwt(),
        ]);

        expect(updated.defaultTaxes.taxTypes).toEqual(["VAT", "EWT"]);
      });

      it("rejects invalid tax definitions", () => {
        expect(() =>
          createInvoice().withDefaultTaxes({
            taxType: "VAT",
            rate: 2,
          }),
        ).toThrow();
      });

      it("is restricted to draft invoices", () => {
        const issued = createInvoice().issue();

        expectMutationError(() => issued.withDefaultTaxes(makeVat()));
      });
    });

    describe("withoutDefaultTaxes()", () => {
      it("removes invoice default taxes", () => {
        const updated = createInvoice({
          defaultTaxes: [makeVat()],
        }).withoutDefaultTaxes();

        expect(updated.defaultTaxes.isEmpty).toBe(true);
      });

      it("is restricted to draft invoices", () => {
        const issued = createInvoice({
          defaultTaxes: [makeVat()],
        }).issue();

        expectMutationError(() => issued.withoutDefaultTaxes());
      });
    });

    describe("line-item tax operations", () => {
      it("sets taxes on one line item", () => {
        const updated = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
            }),
          ],
        }).withTaxesOnLineItem("li-1", makeVat());

        expect(updated.lineItems[0].taxes.hasTaxType("VAT")).toBe(true);
      });

      it("recalculates totals after assigning taxes", () => {
        const updated = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
              unitPrice: 1_000,
            }),
          ],
        }).withTaxesOnLineItem(
          "li-1",
          makeVat({
            inclusive: false,
          }),
        );

        expect(updated.taxAmount).toBe(120);

        expect(updated.totalAmount).toBe(1_120);
      });

      it("rejects an unknown line item", () => {
        expectValidationError(() =>
          createInvoice().withTaxesOnLineItem("missing", makeVat()),
        );
      });

      it("removes taxes from one line item", () => {
        const taxed = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
              taxes: [makeVat()],
            }),
          ],
        });

        const updated = taxed.withoutTaxesOnLineItem("li-1");

        expect(updated.lineItems[0].taxes.isEmpty).toBe(true);

        expect(updated.taxAmount).toBe(0);
      });

      it("removes taxes from every line", () => {
        const taxed = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
              taxes: [makeVat()],
            }),
            makeLineItem({
              id: "li-2",
              taxes: [makeEwt()],
            }),
          ],
        });

        const updated = taxed.withoutTaxesOnAllLineItems();

        expect(updated.lineItems.every((li) => li.taxes.isEmpty)).toBe(true);
      });

      it("replaces taxes on every line", () => {
        const invoice = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
            }),
            makeLineItem({
              id: "li-2",
            }),
          ],
        });

        const updated = invoice.withTaxesOnAllLineItems(
          makeVat({
            rate: 0.05,
          }),
        );

        expect(
          updated.lineItems.every(
            (li) => li.taxes.getByType("VAT")?.rate === 0.05,
          ),
        ).toBe(true);
      });

      it("line-item tax mutations are draft-only", () => {
        const issued = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
            }),
          ],
        }).issue();

        expectMutationError(() =>
          issued.withTaxesOnLineItem("li-1", makeVat()),
        );

        expectMutationError(() => issued.withoutTaxesOnLineItem("li-1"));

        expectMutationError(() => issued.withTaxesOnAllLineItems(makeVat()));

        expectMutationError(() => issued.withoutTaxesOnAllLineItems());
      });
    });

    describe("tax inclusivity", () => {
      it("marks matching taxes inclusive", () => {
        const invoice = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
              taxes: [
                makeVat({
                  inclusive: false,
                }),
              ],
            }),
          ],
          defaultTaxes: [
            makeVat({
              inclusive: false,
            }),
          ],
        });

        const updated = invoice.withInclusiveTax("VAT");

        expect(updated.lineItems[0].taxes.getByType("VAT")?.inclusive).toBe(
          true,
        );

        expect(updated.defaultTaxes.getByType("VAT")?.inclusive).toBe(true);
      });

      it("marks matching taxes exclusive", () => {
        const invoice = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
              taxes: [
                makeVat({
                  inclusive: true,
                }),
              ],
            }),
          ],
          defaultTaxes: [
            makeVat({
              inclusive: true,
            }),
          ],
        });

        const updated = invoice.withExclusiveTax("VAT");

        expect(updated.lineItems[0].taxes.getByType("VAT")?.inclusive).toBe(
          false,
        );

        expect(updated.defaultTaxes.getByType("VAT")?.inclusive).toBe(false);
      });

      it("can toggle all eligible additive taxes when no taxType is supplied", () => {
        const invoice = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-vat",
              taxes: [
                makeVat({
                  inclusive: false,
                }),
              ],
            }),
            makeLineItem({
              id: "li-local",
              taxes: [
                makeVat({
                  taxType: "LOCAL",
                  rate: 0.05,
                  inclusive: false,
                }),
              ],
            }),
          ],
        });

        const updated = invoice.withInclusiveTax();

        expect(
          updated.lineItems.every((li) =>
            li.taxes.additive.every((tax) => tax.inclusive === true),
          ),
        ).toBe(true);
      });

      it("does not mark withholding taxes inclusive", () => {
        const invoice = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
              taxes: [
                makeVat({
                  inclusive: false,
                }),
                makeEwt(),
              ],
            }),
          ],
        });

        const updated = invoice.withInclusiveTax();

        expect(updated.lineItems[0].taxes.getByType("VAT")?.inclusive).toBe(
          true,
        );

        expect(
          updated.lineItems[0].taxes.getByType("EWT")?.inclusive,
        ).toBeUndefined();
      });

      it("is restricted to draft invoices", () => {
        const issued = createInvoice({
          lineItems: [
            makeLineItem({
              id: "li-1",
              taxes: [makeVat()],
            }),
          ],
        }).issue();

        expectMutationError(() => issued.withInclusiveTax("VAT"));

        expectMutationError(() => issued.withExclusiveTax("VAT"));
      });
    });

    describe("default tax inheritance", () => {
      it("uses default taxes when a line has no explicit taxes", () => {
        const invoice = createInvoice({
          defaultTaxes: [
            makeVat({
              rate: 0.12,
            }),
          ],
          lineItems: [
            makeLineItem({
              id: "li-1",
            }),
          ],
        });

        expect(invoice.lineItems[0].taxes.getByType("VAT")?.rate).toBe(0.12);

        expect(invoice.taxAmount).toBe(6_000);
      });

      it("prefers explicit line taxes over invoice defaults", () => {
        const invoice = createInvoice({
          defaultTaxes: [
            makeVat({
              rate: 0.12,
            }),
          ],
          lineItems: [
            makeLineItem({
              id: "li-1",
              taxes: [
                makeVat({
                  rate: 0.05,
                }),
              ],
            }),
          ],
        });

        expect(invoice.lineItems[0].taxes.getByType("VAT")?.rate).toBe(0.05);

        expect(invoice.taxAmount).toBe(2_500);
      });

      /**
       * Contract regression test.
       *
       * The class documentation says invoice-default taxes are inherited and
       * affected inherited lines are rebuilt when defaults change.
       *
       * This test may expose the current reference-based inheritance issue
       * in GeneralInvoice.create()/withDefaultTaxes().
       */
      it("recalculates lines that inherit non-empty invoice default taxes when defaults change", () => {
        const invoice = createInvoice({
          defaultTaxes: [
            makeVat({
              rate: 0.12,
              taxType: "VAT",
            }),
          ],
          lineItems: [
            makeLineItem({
              id: "li-1",
            }),
          ],
        });

        const updated = invoice.withDefaultTaxes(
          makeVat({
            rate: 0.05,
            taxType: "VAT",
          }),
        );

        expect(updated.lineItems[0].taxes).toStrictEqual(updated.defaultTaxes);
        expect(updated.lineItems[0].taxes.getByType("VAT")?.rate).toBe(0.05);
        expect(updated.taxAmount).toBe(2_500);
      });

      /**
       * Companion inheritance regression test.
       */
      it("removes inherited non-empty default taxes from lines when defaults are removed", () => {
        const invoice = createInvoice({
          defaultTaxes: [
            makeVat({
              rate: 0.12,
            }),
          ],
          lineItems: [
            makeLineItem({
              id: "li-1",
            }),
          ],
        });

        expect(invoice.lineItems[0].taxes).toBe(invoice.defaultTaxes);

        const updated = invoice.withoutDefaultTaxes();

        expect(updated.defaultTaxes.isEmpty).toBe(true);
        expect(updated.lineItems[0].taxes.isEmpty).toBe(true);
        expect(updated.lineItems[0].taxes).toStrictEqual(updated.defaultTaxes);
      });
    });
  });

  // ==========================================================================
  // Payments / Settlement
  // ==========================================================================

  describe("Payments & Settlement", () => {
    let invoice: GeneralInvoice;

    beforeEach(() => {
      invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
          }),
        ],
      }).issue();
    });

    describe("initial state", () => {
      it("starts with pending payment status", () => {
        expect(invoice.paymentStatus).toBe("pending");
      });

      it("starts with zero totalPaid", () => {
        expect(invoice.totalPaid.toMajor()).toBe(0);
      });

      it("amountDue equals net payable before payments", () => {
        expect(invoice.amountDue.toMajor()).toBe(
          invoice.totals.netPayableAmount,
        );
      });

      it("is not fully paid initially", () => {
        expect(invoice.isFullyPaid).toBe(false);
      });
    });

    describe("addPayment()", () => {
      it("records a valid payment", () => {
        const updated = invoice.addPayment(
          makePayment({
            amount: 400,
          }),
        );

        expect(updated.proofOfPayments).toHaveLength(1);

        expect(updated.proofOfPayments[0].id).toBe("pay-1");
      });

      it("returns a new invoice", () => {
        const updated = invoice.addPayment(
          makePayment({
            amount: 400,
          }),
        );

        expect(updated).not.toBe(invoice);
      });

      it("does not mutate original payment collection", () => {
        const updated = invoice.addPayment(
          makePayment({
            amount: 400,
          }),
        );

        expect(invoice.proofOfPayments).toEqual([]);

        expect(updated.proofOfPayments).toHaveLength(1);
      });

      it("calculates partial payment state", () => {
        const updated = invoice.addPayment(
          makePayment({
            amount: 400,
          }),
        );

        expect(updated.paymentStatus).toBe("partially_paid");

        expect(updated.status).toBe("partial");
      });

      it("calculates totalPaid", () => {
        const updated = invoice.addPayment(
          makePayment({
            amount: 400,
          }),
        );

        expect(updated.totalPaid.toMajor()).toBe(400);
      });

      it("calculates amountDue after a partial payment", () => {
        const updated = invoice.addPayment(
          makePayment({
            amount: 400,
          }),
        );

        expect(updated.amountDue.toMajor()).toBe(600);
      });

      it("marks the invoice paid when payment exactly settles net payable", () => {
        const updated = invoice.addPayment(
          makePayment({
            amount: 1_000,
          }),
        );

        expect(updated.paymentStatus).toBe("settled");

        expect(updated.isFullyPaid).toBe(true);

        expect(updated.status).toBe("paid");

        expect(updated.amountDue.toMajor()).toBe(0);
      });

      it("sorts proof-of-payment records chronologically", () => {
        const updated = invoice
          .addPayment(
            makePayment({
              id: "pay-late",
              amount: 100,
              settledAt: "2026-10-03T10:00:00Z",
            }),
          )
          .addPayment(
            makePayment({
              id: "pay-early",
              amount: 100,
              settledAt: "2026-10-02T10:00:00Z",
            }),
          );

        expect(updated.proofOfPayments.map((p) => p.id)).toEqual([
          "pay-early",
          "pay-late",
        ]);
      });

      it("rejects missing payment ID", () => {
        expectValidationError(() =>
          invoice.addPayment({
            ...makePayment(),
            id: "",
          }),
        );
      });

      it("rejects duplicate payment IDs", () => {
        const payment = makePayment({
          amount: 100,
        });

        const partial = invoice.addPayment(payment);

        expectValidationError(() => partial.addPayment(payment));
      });

      it.each([0, -0.01, -1])(
        "rejects non-positive payment amount %s",
        (amount) => {
          expectValidationError(() =>
            invoice.addPayment(
              makePayment({
                amount,
              }),
            ),
          );
        },
      );

      it("rejects currency mismatch", () => {
        expectValidationError(() =>
          invoice.addPayment(
            makePayment({
              currency: "USD",
            }),
          ),
        );
      });

      it("rejects overpayment", () => {
        expectValidationError(() =>
          invoice.addPayment(
            makePayment({
              amount: 1_000.01,
            }),
          ),
        );
      });

      it("rejects payments on voided invoices", () => {
        const voided = invoice.voidInvoice();

        expectMutationError(() =>
          voided.addPayment(
            makePayment({
              amount: 100,
            }),
          ),
        );
      });
    });

    describe("removePayment()", () => {
      it("removes an existing payment", () => {
        const updated = invoice
          .addPayment(
            makePayment({
              amount: 100,
            }),
          )
          .removePayment("pay-1");

        expect(updated.proofOfPayments).toEqual([]);

        expect(updated.paymentStatus).toBe("pending");
      });

      it("rejects an empty payment ID", () => {
        expectValidationError(() => invoice.removePayment(" "));
      });

      it("rejects an unknown payment ID", () => {
        expectValidationError(() => invoice.removePayment("missing"));
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice.voidInvoice();

        expectMutationError(() => voided.removePayment("pay-1"));
      });
    });

    describe("clearPayments()", () => {
      it("clears all payments", () => {
        const updated = invoice
          .addPayment(
            makePayment({
              amount: 100,
            }),
          )
          .clearPayments();

        expect(updated.proofOfPayments).toEqual([]);

        expect(updated.paymentStatus).toBe("pending");
      });

      it("is blocked on voided invoices", () => {
        const voided = invoice.voidInvoice();

        expectMutationError(() => voided.clearPayments());
      });
    });

    describe("payment getters", () => {
      it("returns totalPaid as MajikMoney", () => {
        const updated = invoice
          .addPayment(
            makePayment({
              id: "pay-1",
              amount: 100,
            }),
          )
          .addPayment(
            makePayment({
              id: "pay-2",
              amount: 200,
            }),
          );

        expect(updated.totalPaid.toMajor()).toBe(300);
      });

      it("tracks amountDue as a monetary object", () => {
        const updated = invoice.addPayment(
          makePayment({
            amount: 250,
          }),
        );

        expect(updated.amountDue.toMajor()).toBe(750);
      });

      it("reports isFullyPaid only when due reaches zero", () => {
        expect(invoice.isFullyPaid).toBe(false);

        const paid = invoice.addPayment(
          makePayment({
            amount: 1_000,
          }),
        );

        expect(paid.isFullyPaid).toBe(true);
      });
    });
  });

  // ==========================================================================
  // Basic Getters
  // ==========================================================================

  describe("Basic Getters", () => {
    it("isDisputed reflects disputed status", () => {
      const invoice = createInvoice().issue().dispute();

      expect(invoice.isDisputed).toBe(true);
    });

    it("isVoided reflects void status", () => {
      const invoice = createInvoice().voidInvoice();

      expect(invoice.isVoided).toBe(true);
    });

    it("isSent reflects sent status", () => {
      const invoice = createInvoice().issue().send();

      expect(invoice.isSent).toBe(true);
    });

    it("isViewed reflects viewed status", () => {
      const invoice = createInvoice().issue().send().view();

      expect(invoice.isViewed).toBe(true);
    });

    it("isPaid reflects paid status", () => {
      const invoice = createInvoice().issue().markAsPaid();

      expect(invoice.isPaid).toBe(true);
    });

    it("isTerminal reflects void status", () => {
      expect(createInvoice().voidInvoice().isTerminal).toBe(true);

      expect(createInvoice().issue().isTerminal).toBe(false);
    });

    it("isCreditNote reflects credit type", () => {
      const invoice = createInvoice({
        type: "credit",
      });

      expect(invoice.isCreditNote).toBe(true);
    });

    it("isTaxInvoice reflects tax type", () => {
      const invoice = createInvoice({
        type: "tax",
      });

      expect(invoice.isTaxInvoice).toBe(true);
    });

    it("returns totalAmount from totals", () => {
      const invoice = createInvoice();

      expect(invoice.totalAmount).toBe(invoice.totals.grandTotalAmount);
    });

    it("returns taxAmount from totals", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            taxes: [makeVat()],
          }),
        ],
      });

      expect(invoice.taxAmount).toBe(invoice.totals.taxTotalAmount);
    });

    it("returns withholdingAmount from totals", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            taxes: [makeEwt()],
          }),
        ],
      });

      expect(invoice.withholdingAmount).toBe(
        invoice.totals.withholdingTotalAmount,
      );
    });

    it("returns netPayableAmount from totals", () => {
      const invoice = createInvoice();

      expect(invoice.netPayableAmount).toBe(invoice.totals.netPayableAmount);
    });

    it("returns subtotalAmount from totals", () => {
      const invoice = createInvoice();

      expect(invoice.subtotalAmount).toBe(invoice.totals.subtotalAmount);
    });

    it("returns discountAmount from totals", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            discount: {
              type: "fixed",
              value: 100,
            },
          }),
        ],
      });

      expect(invoice.discountAmount).toBe(invoice.totals.discountTotalAmount);
    });

    it("returns lineItemCount correctly", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "1",
          }),
          makeLineItem({
            id: "2",
          }),
          makeLineItem({
            id: "3",
          }),
        ],
      });

      expect(invoice.lineItemCount).toBe(3);
    });

    it("delegates effectiveTaxRate", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [makeVat()],
          }),
        ],
      });

      expect(invoice.effectiveTaxRate).toBe(invoice.totals.effectiveTaxRate);
    });

    it("delegates hasTax", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            taxes: [makeVat()],
          }),
        ],
      });

      expect(invoice.hasTax).toBe(true);
    });

    it("delegates hasWithholding", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            taxes: [makeEwt()],
          }),
        ],
      });

      expect(invoice.hasWithholding).toBe(true);
    });

    it("delegates hasDiscount", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            discount: {
              type: "fixed",
              value: 100,
            },
          }),
        ],
      });

      expect(invoice.hasDiscount).toBe(true);
    });

    it("formattedTotal delegates to MajikMoney formatting", () => {
      const invoice = createInvoice();

      expect(invoice.formattedTotal).toBe(invoice.totals.grandTotal.format());
    });
  });

  // ==========================================================================
  // Tax / Account / Collection Getters
  // ==========================================================================

  describe("Collection Getters", () => {
    const invoiceWithTaxes = createInvoice({
      lineItems: [
        makeLineItem({
          id: "li-1",
          accountCode: "4000",
          costCenter: "CC-1",
          taxes: [
            makeVat({
              taxType: "VAT",
            }),
            makeEwt({
              taxType: "EWT",
            }),
          ],
        }),
        makeLineItem({
          id: "li-2",
          accountCode: "4000",
          costCenter: "CC-2",
          taxes: [
            makeVat({
              taxType: "VAT",
            }),
            makeInformational({
              taxType: "EXEMPT",
            }),
          ],
        }),
        makeLineItem({
          id: "li-3",
          accountCode: "4100",
          costCenter: "CC-1",
          taxes: [
            makeEwt({
              taxType: "CWT",
            }),
          ],
        }),
      ],
    });

    it("returns unique tax types", () => {
      expect(invoiceWithTaxes.taxTypes).toEqual([
        "VAT",
        "EWT",
        "EXEMPT",
        "CWT",
      ]);
    });

    it("returns unique additive tax types", () => {
      expect(invoiceWithTaxes.additiveTaxTypes).toEqual(["VAT"]);
    });

    it("returns unique withholding tax types", () => {
      expect(invoiceWithTaxes.withholdingTaxTypes).toEqual(["EWT", "CWT"]);
    });

    it("returns unique cost centers", () => {
      expect(invoiceWithTaxes.costCenters).toEqual(["CC-1", "CC-2"]);
    });

    it("returns unique account codes", () => {
      expect(invoiceWithTaxes.accountCodes).toEqual(["4000", "4100"]);
    });

    it("excludes missing cost centers", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            costCenter: undefined,
          }),
        ],
      });

      expect(invoice.costCenters).toEqual([]);
    });

    it("excludes missing account codes", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            accountCode: undefined,
          }),
        ],
      });

      expect(invoice.accountCodes).toEqual([]);
    });
  });

  // ==========================================================================
  // Analytics
  // ==========================================================================

  describe("Tax Analytics", () => {
    it("taxTotalByType returns additive tax amount", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [
              makeVat({
                taxType: "VAT",
              }),
            ],
          }),
        ],
      });

      expect(invoice.taxTotalByType("VAT")).toBe(120);
    });

    it("taxTotalByType aggregates across lines", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "1",
            unitPrice: 1_000,
            taxes: [makeVat()],
          }),
          makeLineItem({
            id: "2",
            unitPrice: 2_000,
            taxes: [makeVat()],
          }),
        ],
      });

      expect(invoice.taxTotalByType("VAT")).toBe(360);
    });

    it("taxTotalByType excludes withholding taxes", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [makeEwt()],
          }),
        ],
      });

      expect(invoice.taxTotalByType("EWT")).toBe(0);
    });

    it("taxTotalByType returns zero for unknown type", () => {
      const invoice = createInvoice();

      expect(invoice.taxTotalByType("GST")).toBe(0);
    });

    it("taxTotalByType rejects empty taxType", () => {
      expectValidationError(() => createInvoice().taxTotalByType(" "));
    });

    it("withholdingTotalByType returns withholding amount", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [makeEwt()],
          }),
        ],
      });

      expect(invoice.withholdingTotalByType("EWT")).toBe(50);
    });

    it("withholdingTotalByType aggregates across lines", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "1",
            unitPrice: 1_000,
            taxes: [makeEwt()],
          }),
          makeLineItem({
            id: "2",
            unitPrice: 2_000,
            taxes: [makeEwt()],
          }),
        ],
      });

      expect(invoice.withholdingTotalByType("EWT")).toBe(150);
    });

    it("withholdingTotalByType rejects empty taxType", () => {
      expectValidationError(() => createInvoice().withholdingTotalByType(""));
    });

    it("subtotalByCostCenter aggregates matching lines", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "1",
            costCenter: "CC-A",
            unitPrice: 1_000,
          }),
          makeLineItem({
            id: "2",
            costCenter: "CC-A",
            unitPrice: 2_000,
          }),
          makeLineItem({
            id: "3",
            costCenter: "CC-B",
            unitPrice: 500,
          }),
        ],
      });

      expect(invoice.subtotalByCostCenter("CC-A")).toBe(3_000);

      expect(invoice.subtotalByCostCenter("CC-B")).toBe(500);
    });

    it("subtotalByCostCenter returns zero for an unused cost center", () => {
      expect(createInvoice().subtotalByCostCenter("missing")).toBe(0);
    });

    it("subtotalByCostCenter rejects empty input", () => {
      expectValidationError(() => createInvoice().subtotalByCostCenter(" "));
    });

    it("subtotalByAccountCode aggregates matching lines", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "1",
            accountCode: "4000",
            unitPrice: 1_000,
          }),
          makeLineItem({
            id: "2",
            accountCode: "4000",
            unitPrice: 2_000,
          }),
          makeLineItem({
            id: "3",
            accountCode: "4100",
            unitPrice: 500,
          }),
        ],
      });

      expect(invoice.subtotalByAccountCode("4000")).toBe(3_000);

      expect(invoice.subtotalByAccountCode("4100")).toBe(500);
    });

    it("subtotalByAccountCode returns zero for an unused account", () => {
      expect(createInvoice().subtotalByAccountCode("9999")).toBe(0);
    });

    it("subtotalByAccountCode rejects empty input", () => {
      expectValidationError(() => createInvoice().subtotalByAccountCode(""));
    });
  });

  // ==========================================================================
  // Tax Breakdown
  // ==========================================================================

  describe("taxBreakdown()", () => {
    it("returns additive tax groups", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [
              makeVat({
                rate: 0.12,
              }),
            ],
          }),
        ],
      });

      const breakdown = invoice.taxBreakdown();

      expect(breakdown).toHaveLength(1);
      expect(breakdown[0]).toEqual(
        expect.objectContaining({
          taxType: "VAT",
          rate: 0.12,
          behaviour: "additive",
          inclusive: false,
          taxableBase: 1_000,
          taxAmount: 120,
          lineCount: 1,
        }),
      );
    });

    it("returns withholding tax groups", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [
              makeEwt({
                rate: 0.05,
              }),
            ],
          }),
        ],
      });

      const breakdown = invoice.taxBreakdown();

      expect(breakdown).toHaveLength(1);
      expect(breakdown[0]).toEqual(
        expect.objectContaining({
          taxType: "EWT",
          rate: 0.05,
          behaviour: "withholding",
          taxableBase: 1_000,
          taxAmount: 50,
          lineCount: 1,
        }),
      );
    });

    it("excludes informational taxes", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            taxes: [makeInformational()],
          }),
        ],
      });

      expect(invoice.taxBreakdown()).toEqual([]);
    });

    it("groups repeated taxes across multiple lines", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "1",
            unitPrice: 1_000,
            taxes: [makeVat()],
          }),
          makeLineItem({
            id: "2",
            unitPrice: 2_000,
            taxes: [makeVat()],
          }),
        ],
      });

      const breakdown = invoice.taxBreakdown();

      expect(breakdown).toHaveLength(1);
      expect(breakdown[0]).toEqual(
        expect.objectContaining({
          taxType: "VAT",
          taxableBase: 3_000,
          taxAmount: 360,
          lineCount: 2,
        }),
      );
    });

    it("separates groups by inclusive state", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "exclusive",
            unitPrice: 1_000,
            taxes: [
              makeVat({
                inclusive: false,
              }),
            ],
          }),
          makeLineItem({
            id: "inclusive",
            unitPrice: 1_120,
            taxes: [
              makeVat({
                inclusive: true,
              }),
            ],
          }),
        ],
      });

      const breakdown = invoice.taxBreakdown();

      expect(breakdown.some((entry) => entry.inclusive === true)).toBe(true);

      expect(breakdown.some((entry) => entry.inclusive === false)).toBe(true);
    });

    it("uses a pre-tax base for inclusive additive taxes", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_120,
            taxes: [
              makeVat({
                inclusive: true,
              }),
            ],
          }),
        ],
      });

      const vat = invoice
        .taxBreakdown()
        .find((entry) => entry.taxType === "VAT");

      expect(vat).toEqual(
        expect.objectContaining({
          taxableBase: 1_000,
          taxAmount: 120,
        }),
      );
    });

    it("uses a base excluding inclusive taxes for withholding", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_120,
            taxes: [
              makeVat({
                inclusive: true,
              }),
              makeEwt({
                rate: 0.05,
              }),
            ],
          }),
        ],
      });

      const ewt = invoice
        .taxBreakdown()
        .find((entry) => entry.taxType === "EWT");

      expect(ewt).toEqual(
        expect.objectContaining({
          taxableBase: 1_000,
          taxAmount: 50,
        }),
      );
    });
  });

  // ==========================================================================
  // Discount Summary
  // ==========================================================================

  describe("discountSummary()", () => {
    it("returns zero summary without discounts", () => {
      const invoice = createInvoice();

      const summary = invoice.discountSummary();

      expect(summary.totalDiscount).toBe(0);

      expect(summary.effectiveRate).toBe(0);

      expect(summary.lines).toEqual([]);
    });

    it("summarizes percentage discounts", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "li-1",
            unitPrice: 1_000,
            discount: {
              type: "percentage",
              value: 0.1,
            },
          }),
        ],
      });

      const summary = invoice.discountSummary();

      expect(summary.totalDiscount).toBe(100);

      expect(summary.effectiveRate).toBeCloseTo(0.1, 10);

      expect(summary.lines).toEqual([
        expect.objectContaining({
          lineItemId: "li-1",
          discountType: "percentage",
          discountValue: 0.1,
          discountAmount: 100,
        }),
      ]);
    });

    it("summarizes fixed discounts", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "li-1",
            discount: {
              type: "fixed",
              value: 125,
            },
          }),
        ],
      });

      const summary = invoice.discountSummary();

      expect(summary.totalDiscount).toBe(125);

      expect(summary.lines[0]).toEqual(
        expect.objectContaining({
          discountType: "fixed",
          discountValue: 125,
          discountAmount: 125,
        }),
      );
    });

    it("includes only lines that actually have discounts", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "discounted",
            discount: {
              type: "fixed",
              value: 100,
            },
          }),
          makeLineItem({
            id: "normal",
          }),
        ],
      });

      const summary = invoice.discountSummary();

      expect(summary.lines).toHaveLength(1);

      expect(summary.lines[0].lineItemId).toBe("discounted");
    });
  });

  // ==========================================================================
  // Account Grouping
  // ==========================================================================

  describe("lineItemsByAccountCode()", () => {
    it("groups line items by explicit account code", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "1",
            accountCode: "4000",
            unitPrice: 1_000,
          }),
          makeLineItem({
            id: "2",
            accountCode: "4000",
            unitPrice: 2_000,
          }),
          makeLineItem({
            id: "3",
            accountCode: "4100",
            unitPrice: 500,
          }),
        ],
      });

      const groups = invoice.lineItemsByAccountCode();

      expect(groups).toHaveLength(2);

      const revenue = groups.find((g) => g.accountCode === "4000");

      expect(revenue).toBeDefined();
      expect(revenue!.lineItems).toHaveLength(2);

      expect(revenue!.subtotal).toBe(3_000);
    });

    it("groups missing accountCode under default revenue account", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            accountCode: undefined,
            unitPrice: 1_000,
          }),
        ],
      });

      const groups = invoice.lineItemsByAccountCode();

      expect(groups).toHaveLength(1);
      expect(groups[0].accountCode).toBe("4000");
    });

    it("supports an accounting context override", () => {
      const context = {
        accounts: {
          revenue: "REV-001",
        },
      } as AccountingContext;

      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            accountCode: undefined,
            unitPrice: 1_000,
          }),
        ],
      });

      const groups = invoice.lineItemsByAccountCode(context);

      expect(groups[0].accountCode).toBe("REV-001");
    });
  });

  // ==========================================================================
  // FX
  // ==========================================================================

  describe("computeWithFxRate()", () => {
    it("converts invoice totals to a target currency", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 50_000,
          }),
        ],
      });

      const fx = invoice.computeWithFxRate(0.018, "USD");

      expect(fx.targetCurrency).toBe("USD");

      expect(fx.rate).toBe(0.018);

      expect(fx.subtotal).toBe(900);

      expect(fx.grandTotal).toBe(900);
    });

    it("converts discounts", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            discount: {
              type: "fixed",
              value: 100,
            },
          }),
        ],
      });

      const fx = invoice.computeWithFxRate(2, "USD");

      expect(fx.discountTotal).toBe(200);
    });

    it("converts additive taxes", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [makeVat()],
          }),
        ],
      });

      const fx = invoice.computeWithFxRate(2, "USD");

      expect(fx.taxTotal).toBe(240);
    });

    it("does not mutate the invoice currency", () => {
      const invoice = createInvoice();

      invoice.computeWithFxRate(0.018, "USD");

      expect(invoice.currency).toBe("PHP");
    });

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["negative infinity", Number.NEGATIVE_INFINITY],
    ])("rejects invalid FX rate: %s", (_label, rate) => {
      expectValidationError(() =>
        createInvoice().computeWithFxRate(rate, "USD"),
      );
    });

    it.each(["USD1", "US", "usd", ""])(
      "rejects invalid target currency %s",
      (currency) => {
        expectValidationError(() =>
          createInvoice().computeWithFxRate(1, currency as never),
        );
      },
    );

    it("rejects same-currency FX", () => {
      expectValidationError(() => createInvoice().computeWithFxRate(1, "PHP"));
    });

    it("returns formatted target-currency values", () => {
      const invoice = createInvoice();

      const fx = invoice.computeWithFxRate(0.018, "USD");

      expect(fx.formatted.subtotal).toBeDefined();

      expect(fx.formatted.grandTotal).toBeDefined();
    });
  });

  // ==========================================================================
  // Journal Entry Projection
  // ==========================================================================

  describe("toJournalEntry()", () => {
    it("projects a balanced basic invoice", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
          }),
        ],
      });

      const journal = invoice.toJournalEntry();

      expect(journal.id).toBeDefined();
      expect(journal.status).toBe("draft");
      expect(journal.lines.length).toBe(2);

      const ar = journal.lines.find((line) => line.accountCode === "1200");

      const revenue = journal.lines.find((line) => line.accountCode === "4000");

      expect(ar?.debit).toBe(1_000);
      expect(ar?.credit).toBeUndefined();

      expect(revenue?.credit).toBe(1_000);
      expect(revenue?.debit).toBeUndefined();
    });

    it("includes additive tax as tax payable", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [makeVat()],
          }),
        ],
      });

      const journal = invoice.toJournalEntry();

      const tax = journal.lines.find((line) => line.accountCode === "2100");

      expect(tax).toBeDefined();
      expect(tax?.credit).toBe(120);
    });

    it("excludes withholding from invoice journalization", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [makeEwt()],
          }),
        ],
      });

      const journal = invoice.toJournalEntry();

      expect(journal.lines.some((line) => line.accountCode === "EWT")).toBe(
        false,
      );

      expect(
        journal.lines.reduce((sum, line) => sum + (line.debit ?? 0), 0),
      ).toBe(1_000);

      expect(
        journal.lines.reduce((sum, line) => sum + (line.credit ?? 0), 0),
      ).toBe(1_000);
    });

    it("uses line accountCode instead of default revenue account", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            accountCode: "4100",
            unitPrice: 1_000,
          }),
        ],
      });

      const journal = invoice.toJournalEntry();

      expect(journal.lines.some((line) => line.accountCode === "4100")).toBe(
        true,
      );
    });

    it("supports custom accounting account codes", () => {
      const journal = createInvoice().toJournalEntry({
        accounts: {
          receivable: "AR-001",
          revenue: "REV-001",
          tax: "TAX-001",
        },
      });

      expect(journal.lines.some((line) => line.accountCode === "AR-001")).toBe(
        true,
      );

      expect(journal.lines.some((line) => line.accountCode === "REV-001")).toBe(
        true,
      );
    });

    it("projects credit notes with reversed debit/credit direction", () => {
      const invoice = createInvoice({
        id: "credit-001",
        type: "credit",
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
          }),
        ],
      });

      const journal = invoice.toJournalEntry();

      const ar = journal.lines.find((line) => line.accountCode === "1200");

      const revenue = journal.lines.find((line) => line.accountCode === "4000");

      expect(ar?.credit).toBe(1_000);

      expect(revenue?.debit).toBe(1_000);
    });

    it("rejects an invoice with no line items", () => {
      const empty = createInvoice().withClearedLineItems();

      expect(() => empty.toJournalEntry()).toThrow(InvoiceProjectionError);
    });

    it("is based on the invoice being balanced", () => {
      const invoice = createInvoice();

      expect(invoice.isBalanced()).toBe(true);
    });

    it("includes source-document information", () => {
      const invoice = createInvoice({
        invoiceNumber: "INV-001",
      });

      const journal = invoice.toJournalEntry();

      expect(journal.sourceDocument).toEqual(
        expect.objectContaining({
          type: "invoice",
          id: invoice.id,
          invoiceNumber: "INV-001",
        }),
      );
    });
  });

  // ==========================================================================
  // Sub-ledger
  // ==========================================================================

  describe("toSubLedgerEntry()", () => {
    it("creates an open AR sub-ledger entry", () => {
      const invoice = createInvoice();

      const ledger = invoice.toSubLedgerEntry();

      expect(ledger.type).toBe("AR");

      expect(ledger.status).toBe("open");

      expect(ledger.invoiceId).toBe(invoice.id);

      expect(ledger.balance).toBe(invoice.totals.grandTotalAmount);

      expect(ledger.currency).toBe(invoice.currency);
    });

    it("uses recipient TIN when available", () => {
      const invoice = createInvoice({
        recipient: makeRecipient({
          tin: "TIN-001",
        }),
      });

      const ledger = invoice.toSubLedgerEntry();

      expect(ledger.partyId).toBe("TIN-001");
    });

    it("falls back to legalName when TIN is absent", () => {
      const invoice = createInvoice();

      const ledger = invoice.toSubLedgerEntry();

      expect(ledger.partyId).toBe(invoice.recipient.legalName);
    });

    it("rejects invoices with no line items", () => {
      const empty = createInvoice().withClearedLineItems();

      expect(() => empty.toSubLedgerEntry()).toThrow(InvoiceProjectionError);
    });
  });

  // ==========================================================================
  // isBalanced
  // ==========================================================================

  describe("isBalanced()", () => {
    it("returns true for a normal invoice", () => {
      expect(createInvoice().isBalanced()).toBe(true);
    });

    it("returns false when no line items exist", () => {
      expect(createInvoice().withClearedLineItems().isBalanced()).toBe(false);
    });

    it("reconciles aggregated line totals with invoice totals", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "1",
            unitPrice: 1_000,
          }),
          makeLineItem({
            id: "2",
            unitPrice: 2_000,
          }),
        ],
      });

      const lineSum = invoice.lineItems.reduce(
        (sum, li) => sum + li.netTotalAmount,
        0,
      );

      expect(lineSum).toBe(invoice.totals.grandTotalAmount);

      expect(invoice.isBalanced()).toBe(true);
    });
  });

  // ==========================================================================
  // Serialization
  // ==========================================================================

  describe("toJSON()", () => {
    it("returns a JSON object", () => {
      const invoice = createInvoice();

      expect(typeof invoice.toJSON()).toBe("object");
    });

    it("includes schema version", () => {
      const json = createInvoice().toJSON();

      expect(json.version).toBeDefined();
    });

    it("includes invoice identity and lifecycle", () => {
      const invoice = createInvoice({
        id: "INV-001",
        invoiceNumber: "2026-001",
      });

      const json = invoice.toJSON();

      expect(json.id).toBe("INV-001");

      expect(json.invoiceNumber).toBe("2026-001");

      expect(json.status).toBe("draft");
    });

    it("includes parties", () => {
      const invoice = createInvoice();

      const json = invoice.toJSON();

      expect(json.issuer).toEqual(invoice.issuer);

      expect(json.recipient).toEqual(invoice.recipient);
    });

    it("includes line items", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "li-1",
          }),
        ],
      });

      const json = invoice.toJSON();

      expect(json.lineItems).toHaveLength(1);

      expect(json.lineItems[0].id).toBe("li-1");
    });

    it("includes calculated totals", () => {
      const json = createInvoice().toJSON();

      expect(json.totals).toBeDefined();

      expect(json.totals.grandTotal).toBeDefined();
    });

    it("includes proof-of-payment records", () => {
      const invoice = createInvoice()
        .issue()
        .addPayment(
          makePayment({
            amount: 100,
          }),
        );

      const json = invoice.toJSON();

      expect(json.proofOfPayments).toHaveLength(1);
    });

    it("includes default taxes", () => {
      const invoice = createInvoice({
        defaultTaxes: [makeVat()],
      });

      const json = invoice.toJSON();

      expect(json.defaultTaxes).toEqual(invoice.defaultTaxes.toArray());
    });

    it("includes references", () => {
      const invoice = createInvoice().withReference(makeReference());

      const json = invoice.toJSON();

      expect(json.references).toEqual(invoice.references);
    });

    it("includes tags", () => {
      const invoice = createInvoice().withTags(["urgent", "software"]);

      const json = invoice.toJSON();

      expect(json.tags).toEqual(["urgent", "software"]);
    });

    it("serializes metadata", () => {
      const invoice = createInvoice({
        metadata: {
          source: "api",
          externalId: "ABC-123",
        },
      });

      const json = invoice.toJSON();

      expect(json.metadata).toBeDefined();
    });

    it("can be JSON.stringify()'d", () => {
      const invoice = createInvoice({
        metadata: {
          source: "api",
        },
      });

      expect(() => JSON.stringify(invoice.toJSON())).not.toThrow();
    });
  });

  // ==========================================================================
  // Deserialization
  // ==========================================================================

  describe("fromJSON()", () => {
    const createSerializedInvoice = () => {
      const original = createInvoice({
        id: "INV-JSON-001",
        invoiceNumber: "INV-2026-001",
        type: "tax",
        issueDate: "2026-09-01",
        dueDate: "2026-10-15",
        period: makePeriod(),
        paymentTerms: "custom",
        lineItems: [
          makeLineItem({
            id: "li-1",
            quantity: 2,
            unitPrice: 1_000,
            discount: {
              type: "percentage",
              value: 0.1,
            },
            taxes: [makeVat(), makeEwt()],
          }),
        ],
        defaultTaxes: [makeVat()],
        notes: "Important note",
        tags: ["urgent"],
        metadata: {
          source: "api",
          project: "alpha",
        },
      });

      return {
        original,
        json: original.toJSON(),
      };
    };

    it("reconstructs a GeneralInvoice", () => {
      const { json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored).toBeInstanceOf(GeneralInvoice);
    });

    it("preserves identity", () => {
      const { original, json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored.id).toBe(original.id);

      expect(restored.invoiceNumber).toBe(original.invoiceNumber);
    });

    it("preserves invoice type and status", () => {
      const { original, json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored.type).toBe(original.type);

      expect(restored.status).toBe(original.status);
    });

    it("preserves parties", () => {
      const { original, json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored.issuer).toEqual(original.issuer);

      expect(restored.recipient).toEqual(original.recipient);
    });

    it("preserves line items", () => {
      const { original, json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored.lineItems).toHaveLength(original.lineItems.length);

      expect(restored.lineItems[0].quantity).toBe(
        original.lineItems[0].quantity,
      );
    });

    it("preserves default taxes", () => {
      const { original, json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored.defaultTaxes.all).toEqual(original.defaultTaxes.all);
    });

    it("preserves notes", () => {
      const { original, json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored.notes).toBe(original.notes);
    });

    it("preserves tags", () => {
      const { original, json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored.tags).toEqual(original.tags);
    });

    it("preserves metadata", () => {
      const { original, json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored.metadata).toEqual(original.metadata);
    });

    it("recalculates totals from line items", () => {
      const { original, json } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(json);

      expect(restored.totals.grandTotalAmount).toBe(
        original.totals.grandTotalAmount,
      );

      expect(restored.totals.taxTotalAmount).toBe(
        original.totals.taxTotalAmount,
      );
    });

    it("does not trust serialized totals", () => {
      const { original, json } = createSerializedInvoice();

      const tampered = {
        ...json,
        totals: {
          ...json.totals,
          grandTotal: json.totals.subtotal,
          taxTotal: json.totals.subtotal,
          netPayable: json.totals.subtotal,
        },
      };

      const restored = GeneralInvoice.fromJSON(tampered as GeneralInvoiceJSON);

      expect(restored.totals.grandTotalAmount).toBe(
        original.totals.grandTotalAmount,
      );

      expect(restored.totals.taxTotalAmount).toBe(
        original.totals.taxTotalAmount,
      );

      expect(restored.totals.netPayableAmount).toBe(
        original.totals.netPayableAmount,
      );
    });

    it("supports a direct toJSON/fromJSON round trip", () => {
      const { original } = createSerializedInvoice();

      const restored = GeneralInvoice.fromJSON(original.toJSON());

      expect(restored.toJSON()).toEqual(original.toJSON());
    });

    it("supports JSON.stringify/JSON.parse round trip", () => {
      const { original } = createSerializedInvoice();

      const text = JSON.stringify(original.toJSON());

      const parsed = JSON.parse(text) as GeneralInvoiceJSON;

      const restored = GeneralInvoice.fromJSON(parsed);

      expect(restored.id).toBe(original.id);

      expect(restored.totalAmount).toBe(original.totalAmount);

      expect(restored.taxAmount).toBe(original.taxAmount);
    });

    it("preserves proof-of-payment records", () => {
      const original = createInvoice()
        .issue()
        .addPayment(
          makePayment({
            amount: 100,
          }),
        );

      const restored = GeneralInvoice.fromJSON(original.toJSON());

      expect(restored.proofOfPayments).toEqual(original.proofOfPayments);
    });
  });

  // ==========================================================================
  // Canonical Signing
  // ==========================================================================

  describe("Canonical Signing Representation", () => {
    it("produces canonical JSON", () => {
      const invoice = createInvoice();

      const canonical = invoice.toCanonicalJSON();

      expect(typeof canonical).toBe("string");

      expect(() => JSON.parse(canonical)).not.toThrow();
    });

    it("produces canonical UTF-8 bytes", () => {
      const invoice = createInvoice();

      const bytes = invoice.toCanonicalBytes();

      expect(bytes).toBeInstanceOf(Uint8Array);

      expect(bytes.length).toBeGreaterThan(0);
    });

    it("caches canonical bytes", () => {
      const invoice = createInvoice();

      const first = invoice.toCanonicalBytes();

      const second = invoice.toCanonicalBytes();

      expect(second).toBe(first);
    });

    it("caches canonical JSON", () => {
      const invoice = createInvoice();

      const first = invoice.toCanonicalJSON();

      const second = invoice.toCanonicalJSON();

      expect(second).toBe(first);
    });

    it("caches canonical hash", () => {
      const invoice = createInvoice();

      const first = invoice.toCanonicalHash();

      const second = invoice.toCanonicalHash();

      expect(second).toBe(first);
    });

    it("produces a deterministic hash", () => {
      const first = createInvoice({
        id: "same-id",
        invoiceNumber: "INV-001",
      });

      const second = createInvoice({
        id: "same-id",
        invoiceNumber: "INV-001",
      });

      expect(first.toCanonicalJSON()).toBe(second.toCanonicalJSON());

      expect(first.toCanonicalHash()).toBe(second.toCanonicalHash());
    });

    it("excludes status from the canonical representation", () => {
      const original = createInvoice();

      const changed = original.withStatus("issued");

      expect(changed.toCanonicalHash()).toBe(original.toCanonicalHash());
    });

    it("excludes notes from canonical representation", () => {
      const original = createInvoice();

      const changed = original.withNotes("Operational note");

      expect(changed.toCanonicalHash()).toBe(original.toCanonicalHash());
    });

    it("excludes tags from canonical representation", () => {
      const original = createInvoice();

      const changed = original.withTag("internal");

      expect(changed.toCanonicalHash()).toBe(original.toCanonicalHash());
    });

    it("excludes metadata from canonical representation", () => {
      const original = createInvoice();

      const changed = original.withMetadata({
        source: "api",
      });

      expect(changed.toCanonicalHash()).toBe(original.toCanonicalHash());
    });

    it("excludes settlement information from canonical representation", () => {
      const original = createInvoice();

      const changed = original.addPayment(
        makePayment({
          amount: 100,
        }),
      );

      expect(changed.toCanonicalHash()).toBe(original.toCanonicalHash());
    });

    it("excludes createdAt and updatedAt from canonical representation", () => {
      const original = createInvoice();

      vi.advanceTimersByTime(10_000);

      const changed = original.withNotes("Changed");

      expect(changed.updatedAt).not.toBe(original.updatedAt);

      expect(changed.toCanonicalHash()).toBe(original.toCanonicalHash());
    });

    it("changes canonical representation when invoice number changes", () => {
      const original = createInvoice({
        invoiceNumber: "INV-001",
      });

      const changed = original.withInvoiceNumber("INV-002");

      expect(changed.toCanonicalHash()).not.toBe(original.toCanonicalHash());
    });

    it("changes canonical representation when dueDate changes", () => {
      const original = createInvoice({
        dueDate: "2026-10-15",
      });

      const changed = original.withDueDate("2026-10-20");

      expect(changed.toCanonicalHash()).not.toBe(original.toCanonicalHash());
    });

    it("changes canonical representation when line-item source data changes", () => {
      const original = createInvoice({
        id: "same-id",
        lineItems: [
          makeLineItem({
            id: "li-1",
            quantity: 1,
          }),
        ],
      });

      const changed = original.withUpdatedLineItem("li-1", {
        quantity: 2,
      });

      expect(changed.toCanonicalHash()).not.toBe(original.toCanonicalHash());
    });

    /**
     * Contract regression test.
     *
     * A canonical signed invoice must actually contain the nested source
     * data that the documentation says is part of the signable commitment.
     *
     * With the current JSON.stringify(..., Object.keys(json).sort()) approach,
     * nested properties can be filtered by the top-level replacer list.
     */
    it("includes nested issuer data in canonical JSON", () => {
      const invoice = createInvoice({
        issuer: makeIssuer({
          legalName: "Original Issuer",
        }),
      });

      const canonical = JSON.parse(invoice.toCanonicalJSON()) as {
        issuer?: {
          legalName?: string;
        };
      };

      expect(canonical.issuer?.legalName).toBe("Original Issuer");
    });

    /**
     * Contract regression test for recipient commitment.
     */
    it("changes canonical hash when recipient data changes", () => {
      const first = createInvoice({
        id: "same-id",
        recipient: makeRecipient({
          legalName: "Client A",
        }),
      });

      const second = createInvoice({
        id: "same-id",
        recipient: makeRecipient({
          legalName: "Client B",
        }),
      });

      expect(second.toCanonicalHash()).not.toBe(first.toCanonicalHash());
    });
  });

  // ==========================================================================
  // CSV
  // ==========================================================================

  describe("CSV Export", () => {
    it("exports a header and data row", () => {
      const invoice = createInvoice({
        invoiceNumber: "INV-001",
      });

      const csv = invoice.toCSV();

      const lines = csv.split("\n");

      expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it("exports a single row without a header", () => {
      const invoice = createInvoice();

      const row = invoice.toCSVRow();

      expect(row.includes("\n")).toBe(false);
    });

    it("includes invoice identity in the CSV output", () => {
      const invoice = createInvoice({
        id: "INV-CSV-001",
        invoiceNumber: "2026-CSV-001",
      });

      const csv = invoice.toCSV();

      expect(csv).toContain("INV-CSV-001");

      expect(csv).toContain("2026-CSV-001");
    });
  });

  // ==========================================================================
  // Majik Invoice API Projection
  // ==========================================================================

  describe("toMajikInvoiceInput()", () => {
    it("exports source invoice fields", () => {
      const invoice = createInvoice({
        id: "INV-001",
        invoiceNumber: "2026-001",
        notes: "Note",
      });

      const projected = invoice.toMajikInvoiceInput();

      expect(projected.id).toBe(invoice.id);

      expect(projected.invoiceNumber).toBe(invoice.invoiceNumber);

      expect(projected.notes).toBe("Note");
    });

    it("does not include derived totals", () => {
      const projected = createInvoice().toMajikInvoiceInput();

      expect(projected).not.toHaveProperty("totals");
    });

    it("exports numeric line-item unit prices", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_500,
          }),
        ],
      });

      const projected = invoice.toMajikInvoiceInput();

      expect(projected.lineItems[0].unitPrice).toBe(1_500);
    });

    it("exports taxes and discounts", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            taxes: [makeVat(), makeEwt()],
            discount: {
              type: "fixed",
              value: 100,
            },
          }),
        ],
      });

      const projected = invoice.toMajikInvoiceInput();

      expect(projected.lineItems[0].taxes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taxType: "VAT",
          }),
          expect.objectContaining({
            taxType: "EWT",
          }),
        ]),
      );

      expect(projected.lineItems[0].discount).toEqual({
        type: "fixed",
        value: 100,
      });
    });
  });

  // ==========================================================================
  // Immutability / Structural Guarantees
  // ==========================================================================

  describe("Immutability & Structural Guarantees", () => {
    it("freezes lineItems collection", () => {
      const invoice = createInvoice();

      expect(Object.isFrozen(invoice.lineItems)).toBe(true);
    });

    it("freezes proofOfPayments collection", () => {
      const invoice = createInvoice();

      expect(Object.isFrozen(invoice.proofOfPayments)).toBe(true);
    });

    it("freezes references collection when present", () => {
      const invoice = createInvoice().withReference(makeReference());

      expect(Object.isFrozen(invoice.references)).toBe(true);
    });

    it("does not allow direct lineItems array mutation", () => {
      const invoice = createInvoice();

      expect(() => {
        (invoice.lineItems as unknown as LineItemInput[]).push(
          makeLineItem({
            id: "x",
          }) as never,
        );
      }).toThrow();
    });

    it("does not allow direct payment-array mutation", () => {
      const invoice = createInvoice();

      expect(() => {
        (invoice.proofOfPayments as ProofOfPayment[]).push(makePayment());
      }).toThrow();
    });

    it("structural mutations always return new invoice instances", () => {
      const invoice = createInvoice();

      const changed = invoice
        .withNotes("Note")
        .withTag("tag")
        .withInvoiceNumber("INV-001");

      expect(changed).not.toBe(invoice);
    });

    it("preserves the original invoice when rebuilt", () => {
      const invoice = createInvoice({
        invoiceNumber: "INV-001",
      });

      const changed = invoice.withNotes("Changed");

      expect(invoice.invoiceNumber).toBe("INV-001");

      expect(invoice.notes).toBeUndefined();

      expect(changed.notes).toBe("Changed");
    });
  });

  // ==========================================================================
  // Core Financial Invariants
  // ==========================================================================

  describe("Financial & Domain Invariants", () => {
    it("grandTotal equals the sum of line netTotals", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            id: "1",
            unitPrice: 1_000,
          }),
          makeLineItem({
            id: "2",
            unitPrice: 2_000,
            taxes: [makeVat()],
          }),
          makeLineItem({
            id: "3",
            unitPrice: 500,
            discount: {
              type: "fixed",
              value: 100,
            },
          }),
        ],
      });

      const lineSum = invoice.lineItems.reduce(
        (sum, li) => sum + li.netTotalAmount,
        0,
      );

      expect(invoice.totalAmount).toBe(lineSum);
    });

    it("taxAmount equals aggregate additive tax", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            taxes: [makeVat()],
          }),
        ],
      });

      expect(invoice.taxAmount).toBe(invoice.totals.taxTotalAmount);
    });

    it("withholdingAmount never contributes to grand total", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [makeEwt()],
          }),
        ],
      });

      expect(invoice.totalAmount).toBe(1_000);

      expect(invoice.withholdingAmount).toBe(50);
    });

    it("netPayable equals grandTotal minus withholding", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            taxes: [makeEwt()],
          }),
        ],
      });

      expect(invoice.netPayableAmount).toBe(950);

      expect(invoice.totalAmount - invoice.withholdingAmount).toBe(
        invoice.netPayableAmount,
      );
    });

    it("discounts reduce the amount before additive tax is calculated", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_000,
            discount: {
              type: "fixed",
              value: 100,
            },
            taxes: [makeVat()],
          }),
        ],
      });

      expect(invoice.discountAmount).toBe(100);

      expect(invoice.taxAmount).toBe(108);

      expect(invoice.totalAmount).toBe(1_008);
    });

    it("inclusive VAT remains inside grand total", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_120,
            taxes: [
              makeVat({
                inclusive: true,
              }),
            ],
          }),
        ],
      });

      expect(invoice.taxAmount).toBe(120);

      expect(invoice.totalAmount).toBe(1_120);
    });

    it("withholding can reduce net payable without changing grand total", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            unitPrice: 1_120,
            taxes: [
              makeVat({
                inclusive: true,
              }),
              makeEwt({
                rate: 0.05,
              }),
            ],
          }),
        ],
      });

      expect(invoice.totalAmount).toBe(1_120);

      expect(invoice.withholdingAmount).toBe(50);

      expect(invoice.netPayableAmount).toBe(1_070);
    });

    it("isTaxable ignores withholding-only invoices", () => {
      const invoice = createInvoice({
        lineItems: [
          makeLineItem({
            taxes: [makeEwt()],
          }),
        ],
      });

      expect(invoice.hasTax).toBe(false);

      expect(invoice.hasWithholding).toBe(true);
    });

    it("isCreditNote and isTaxInvoice are mutually descriptive", () => {
      const credit = createInvoice({
        type: "credit",
      });

      const tax = createInvoice({
        type: "tax",
      });

      expect(credit.isCreditNote).toBe(true);

      expect(credit.isTaxInvoice).toBe(false);

      expect(tax.isTaxInvoice).toBe(true);

      expect(tax.isCreditNote).toBe(false);
    });
  });
});
