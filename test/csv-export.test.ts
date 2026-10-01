/**
 * @file csv-export.test.ts
 * @description Comprehensive Vitest coverage for the shared CSV export system.
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import type { GeneralInvoice } from "../src";
import type { PublicInvoiceSummary } from "../src/core/types";

import {
  ALL_CSV_COLUMNS,
  DEFAULT_CSV_COLUMNS,
  buildCSVHeader,
  buildCSVRow,
  buildTaxBreakdownColumns,
  dedupeColumns,
  type CSVColumn,
  type CSVResolveContext,
} from "../src/core/csv-export";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const money = (value: number) => ({
  toMajor: () => ({
    toFixed: (digits: number) => value.toFixed(digits),
  }),
});

const amount = (value: number) => value;

const createInvoice = (
  overrides: Record<string, unknown> = {},
): GeneralInvoice =>
  ({
    id: "inv_001",
    invoiceNumber: "INV-2026-001",
    type: "invoice",
    status: "issued",
    paymentStatus: "partial",

    issuer: {
      legalName: "Acme Corporation",
      tin: "123-456-789",
      email: "billing@acme.example",
      address: {
        line1: "100 Main Street",
        line2: "Suite 500",
        city: "Manila",
        stateOrProvince: "Metro Manila",
        postalCode: "1000",
        country: "Philippines",
      },
    },

    recipient: {
      legalName: "Client Corporation",
      tin: "987-654-321",
      email: "accounts@client.example",
      address: {
        line1: "200 Client Avenue",
        line2: "Floor 4",
        city: "Makati",
        stateOrProvince: "Metro Manila",
        postalCode: "1200",
        country: "Philippines",
      },
    },

    issueDate: new Date("2026-09-01T00:00:00.000Z"),
    dueDate: new Date("2026-10-01T00:00:00.000Z"),

    period: {
      start: "2026-09-01",
      end: "2026-09-30",
    },

    paymentTerms: "Net 30",

    currency: "PHP",

    subtotalAmount: amount(10000),
    discountAmount: amount(500),
    taxAmount: amount(1140),
    withholdingAmount: amount(200),
    totalAmount: amount(10640),
    netPayableAmount: amount(10440),

    effectiveTaxRate: 0.12,

    formattedTotal: "₱10,640.00",

    totalPaid: money(4000),
    amountDue: money(6440),

    isFullyPaid: false,
    proofOfPayments: [{}, {}],
    lineItemCount: 2,

    lineItems: [
      {
        description: "Software Development",
        quantity: 2,
        unitPrice: money(4000),
        netTotalAmount: amount(8000),
      },
      {
        description: "Consulting",
        quantity: 1,
        unitPrice: money(2000),
        netTotalAmount: amount(2000),
      },
    ],

    costCenters: ["CC-100", "CC-200"],
    accountCodes: ["4000", "4100"],
    taxTypes: ["VAT", "EWT"],

    notes: "Payment due within 30 days.",
    tags: ["software", "consulting"],

    taxTotalByType: vi.fn((taxType: string) => {
      const values: Record<string, number> = {
        VAT: 1140,
        EWT: 0,
      };

      return values[taxType] ?? 0;
    }),

    withholdingTotalByType: vi.fn((taxType: string) => {
      const values: Record<string, number> = {
        VAT: 0,
        EWT: 200,
      };

      return values[taxType] ?? 0;
    }),

    ...overrides,
  }) as unknown as GeneralInvoice;

const createPublicSummary = (
  overrides: Record<string, unknown> = {},
): PublicInvoiceSummary =>
  ({
    invoiceNumber: "PUB-001",
    invoiceType: "invoice",
    status: "issued",
    paymentStatus: "unpaid",

    issuerName: "Public Issuer",
    recipientName: "Public Recipient",

    issuedAt: "2026-08-15T10:00:00.000Z",
    dueDate: "2026-09-15T10:00:00.000Z",

    currency: "PHP",

    totalAmount: 2500,
    formattedTotal: "₱2,500.00",

    ...overrides,
  }) as unknown as PublicInvoiceSummary;

const createContext = (
  overrides: Partial<CSVResolveContext> = {},
): CSVResolveContext => ({
  invoice: createInvoice(),
  public: createPublicSummary(),
  invoiceId: "majik_001",
  ...overrides,
});

const column = (key: string): CSVColumn => {
  const found = ALL_CSV_COLUMNS.find((item) => item.key === key);

  if (!found) {
    throw new Error(`Column not found: ${key}`);
  }

  return found;
};

const resolve = (key: string, ctx = createContext()) =>
  column(key).resolve(ctx);

// ---------------------------------------------------------------------------
// Catalog tests
// ---------------------------------------------------------------------------

describe("CSV column catalogs", () => {
  it("exports a non-empty complete static catalog", () => {
    expect(ALL_CSV_COLUMNS.length).toBeGreaterThan(0);
  });

  it("contains exactly the expected static column keys", () => {
    const expectedKeys = [
      "id",
      "invoiceNumber",
      "type",
      "status",
      "paymentStatus",

      "issuerName",
      "issuerTin",
      "issuerEmail",
      "issuerAddress",

      "recipientName",
      "recipientTin",
      "recipientEmail",
      "recipientAddress",

      "issueDate",
      "dueDate",
      "periodStart",
      "periodEnd",
      "paymentTerms",

      "currency",
      "subtotal",
      "discountTotal",
      "taxTotal",
      "withholdingTotal",
      "grandTotal",
      "netPayable",
      "effectiveTaxRate",
      "formattedTotal",

      "totalPaid",
      "amountDue",
      "isFullyPaid",
      "paymentCount",

      "lineItemCount",
      "lineItemDescriptions",
      "lineItemQuantities",
      "lineItemUnitPrices",
      "lineItemNetTotals",

      "costCenters",
      "accountCodes",
      "taxTypes",

      "notes",
      "tags",
    ];

    expect(ALL_CSV_COLUMNS.map((c) => c.key)).toEqual(expectedKeys);
  });

  it("contains no duplicate static column keys", () => {
    const keys = ALL_CSV_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("provides valid metadata for every static column", () => {
    const validGroups = new Set([
      "identity",
      "parties",
      "dates",
      "totals",
      "tax",
      "line_items",
      "payment",
      "accounting",
      "meta",
    ]);

    for (const col of ALL_CSV_COLUMNS) {
      expect(col.key).toEqual(expect.any(String));
      expect(col.key.length).toBeGreaterThan(0);

      expect(col.label).toEqual(expect.any(String));
      expect(col.label.length).toBeGreaterThan(0);

      expect(validGroups.has(col.group)).toBe(true);

      expect(col.resolve).toEqual(expect.any(Function));
    }
  });

  it("does not include dynamic tax columns in the static catalog", () => {
    expect(ALL_CSV_COLUMNS.some((c) => c.group === "tax")).toBe(false);
  });

  it("contains the expected default column selection", () => {
    expect(DEFAULT_CSV_COLUMNS.map((c) => c.key)).toEqual([
      "id",
      "invoiceNumber",
      "type",
      "status",
      "issuerName",
      "recipientName",
      "issueDate",
      "dueDate",
      "currency",
      "subtotal",
      "taxTotal",
      "grandTotal",
      "netPayable",
      "paymentStatus",
      "totalPaid",
      "amountDue",
    ]);
  });

  it("has no duplicate keys in DEFAULT_CSV_COLUMNS", () => {
    const keys = DEFAULT_CSV_COLUMNS.map((c) => c.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses only columns from ALL_CSV_COLUMNS for defaults", () => {
    const allKeys = new Set(ALL_CSV_COLUMNS.map((c) => c.key));

    for (const col of DEFAULT_CSV_COLUMNS) {
      expect(allKeys.has(col.key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Identity columns
// ---------------------------------------------------------------------------

describe("Identity column resolvers", () => {
  it("resolves invoice ID from the full invoice", () => {
    expect(resolve("id")).toBe("inv_001");
  });

  it("falls back to invoiceId when full invoice is unavailable", () => {
    expect(
      resolve("id", {
        invoice: undefined,
        public: undefined,
        invoiceId: "majik_fallback",
      }),
    ).toBe("majik_fallback");
  });

  it("uses invoiceNumber from full invoice before public summary", () => {
    expect(resolve("invoiceNumber")).toBe("INV-2026-001");
  });

  it("falls back to public invoiceNumber", () => {
    expect(
      resolve("invoiceNumber", {
        invoice: undefined,
        public: createPublicSummary({
          invoiceNumber: "PUBLIC-123",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("PUBLIC-123");
  });

  it("returns an empty invoiceNumber when neither source exists", () => {
    expect(
      resolve("invoiceNumber", {
        invoice: undefined,
        public: undefined,
        invoiceId: "majik_001",
      }),
    ).toBe("");
  });

  it("resolves type from the full invoice", () => {
    expect(resolve("type")).toBe("invoice");
  });

  it("falls back to public invoiceType", () => {
    expect(
      resolve("type", {
        invoice: undefined,
        public: createPublicSummary({
          invoiceType: "credit-note",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("credit-note");
  });

  it("resolves status from the full invoice", () => {
    expect(resolve("status")).toBe("issued");
  });

  it("falls back to public status", () => {
    expect(
      resolve("status", {
        invoice: undefined,
        public: createPublicSummary({
          status: "settled",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("settled");
  });

  it("resolves payment status from the full invoice", () => {
    expect(resolve("paymentStatus")).toBe("partial");
  });

  it("falls back to public payment status", () => {
    expect(
      resolve("paymentStatus", {
        invoice: undefined,
        public: createPublicSummary({
          paymentStatus: "paid",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// Party columns
// ---------------------------------------------------------------------------

describe("Party column resolvers", () => {
  it("resolves issuer name", () => {
    expect(resolve("issuerName")).toBe("Acme Corporation");
  });

  it("falls back to public issuer name", () => {
    expect(
      resolve("issuerName", {
        invoice: undefined,
        public: createPublicSummary({
          issuerName: "Public Issuer",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("Public Issuer");
  });

  it("resolves issuer TIN", () => {
    expect(resolve("issuerTin")).toBe("123-456-789");
  });

  it("returns empty issuer TIN without a full invoice", () => {
    expect(
      resolve("issuerTin", {
        invoice: undefined,
        public: createPublicSummary(),
        invoiceId: "majik_001",
      }),
    ).toBe("");
  });

  it("resolves issuer email", () => {
    expect(resolve("issuerEmail")).toBe("billing@acme.example");
  });

  it("returns empty issuer email without a full invoice", () => {
    expect(
      resolve("issuerEmail", {
        invoice: undefined,
        public: createPublicSummary(),
        invoiceId: "majik_001",
      }),
    ).toBe("");
  });

  it("resolves issuer address with all non-empty components", () => {
    expect(resolve("issuerAddress")).toBe(
      "100 Main Street, Suite 500, Manila, Metro Manila, 1000, Philippines",
    );
  });

  it("omits empty issuer address components", () => {
    const invoice = createInvoice({
      issuer: {
        legalName: "Issuer",
        tin: "123",
        email: "issuer@example.com",
        address: {
          line1: "100 Main",
          line2: "",
          city: "Manila",
          stateOrProvince: "",
          postalCode: "1000",
          country: "Philippines",
        },
      },
    });

    expect(resolve("issuerAddress", createContext({ invoice }))).toBe(
      "100 Main, Manila, 1000, Philippines",
    );
  });

  it("returns empty issuer address when address is unavailable", () => {
    const invoice = createInvoice({
      issuer: {
        legalName: "Issuer",
        tin: "123",
        email: "issuer@example.com",
        address: undefined,
      },
    });

    expect(resolve("issuerAddress", createContext({ invoice }))).toBe("");
  });

  it("resolves recipient name", () => {
    expect(resolve("recipientName")).toBe("Client Corporation");
  });

  it("falls back to public recipient name", () => {
    expect(
      resolve("recipientName", {
        invoice: undefined,
        public: createPublicSummary({
          recipientName: "Public Recipient",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("Public Recipient");
  });

  it("resolves recipient TIN", () => {
    expect(resolve("recipientTin")).toBe("987-654-321");
  });

  it("returns empty recipient TIN without a full invoice", () => {
    expect(
      resolve("recipientTin", {
        invoice: undefined,
        public: createPublicSummary(),
        invoiceId: "majik_001",
      }),
    ).toBe("");
  });

  it("resolves recipient email", () => {
    expect(resolve("recipientEmail")).toBe("accounts@client.example");
  });

  it("returns empty recipient email without a full invoice", () => {
    expect(
      resolve("recipientEmail", {
        invoice: undefined,
        public: createPublicSummary(),
        invoiceId: "majik_001",
      }),
    ).toBe("");
  });

  it("resolves recipient address", () => {
    expect(resolve("recipientAddress")).toBe(
      "200 Client Avenue, Floor 4, Makati, Metro Manila, 1200, Philippines",
    );
  });

  it("omits empty recipient address components", () => {
    const invoice = createInvoice({
      recipient: {
        legalName: "Recipient",
        tin: "123",
        email: "recipient@example.com",
        address: {
          line1: "",
          line2: "Floor 2",
          city: "Makati",
          stateOrProvince: "",
          postalCode: "",
          country: "Philippines",
        },
      },
    });

    expect(resolve("recipientAddress", createContext({ invoice }))).toBe(
      "Floor 2, Makati, Philippines",
    );
  });

  it("returns empty recipient address when unavailable", () => {
    const invoice = createInvoice({
      recipient: {
        legalName: "Recipient",
        tin: "123",
        email: "recipient@example.com",
        address: undefined,
      },
    });

    expect(resolve("recipientAddress", createContext({ invoice }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Date columns
// ---------------------------------------------------------------------------

describe("Date column resolvers", () => {
  it("normalizes Date objects to YYYY-MM-DD", () => {
    expect(resolve("issueDate")).toBe("2026-09-01");
  });

  it("normalizes public issuedAt when invoice is unavailable", () => {
    expect(
      resolve("issueDate", {
        invoice: undefined,
        public: createPublicSummary({
          issuedAt: "2026-08-15T10:00:00.000Z",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("2026-08-15");
  });

  it("normalizes due dates to YYYY-MM-DD", () => {
    expect(resolve("dueDate")).toBe("2026-10-01");
  });

  it("falls back to public dueDate", () => {
    expect(
      resolve("dueDate", {
        invoice: undefined,
        public: createPublicSummary({
          dueDate: "2026-09-15T10:00:00.000Z",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("2026-09-15");
  });

  it("normalizes date strings with timezone offsets using ISO output", () => {
    const invoice = createInvoice({
      issueDate: "2026-09-30T23:30:00-04:00",
    });

    expect(resolve("issueDate", createContext({ invoice }))).toBe("2026-10-01");
  });

  it("accepts numeric timestamps", () => {
    const invoice = createInvoice({
      issueDate: Date.parse("2026-01-20T00:00:00.000Z"),
    });

    expect(resolve("issueDate", createContext({ invoice }))).toBe("2026-01-20");
  });

  it("returns empty for invalid date strings", () => {
    const invoice = createInvoice({
      issueDate: "not-a-date",
    });

    expect(resolve("issueDate", createContext({ invoice }))).toBe("");
  });

  it("returns empty for unsupported date-like values", () => {
    const invoice = createInvoice({
      issueDate: {
        year: 2026,
        month: 1,
        day: 1,
      },
    });

    expect(resolve("issueDate", createContext({ invoice }))).toBe("");
  });

  it("falls back to public issuedAt when issue date is null", () => {
    const invoice = createInvoice({
      issueDate: null,
    });

    expect(resolve("issueDate", createContext({ invoice }))).toBe("2026-08-15");
  });

  it("falls back to public dueDate when due date is unavailable", () => {
    const invoice = createInvoice({
      dueDate: undefined,
    });

    expect(resolve("dueDate", createContext({ invoice }))).toBe("2026-09-15");
  });

  it("resolves period start", () => {
    expect(resolve("periodStart")).toBe("2026-09-01");
  });

  it("resolves period end", () => {
    expect(resolve("periodEnd")).toBe("2026-09-30");
  });

  it("returns empty when period is unavailable", () => {
    const invoice = createInvoice({
      period: undefined,
    });

    const ctx = createContext({ invoice });

    expect(resolve("periodStart", ctx)).toBe("");
    expect(resolve("periodEnd", ctx)).toBe("");
  });

  it("resolves payment terms", () => {
    expect(resolve("paymentTerms")).toBe("Net 30");
  });

  it("returns empty when payment terms are unavailable", () => {
    const invoice = createInvoice({
      paymentTerms: undefined,
    });

    expect(resolve("paymentTerms", createContext({ invoice }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

describe("Totals column resolvers", () => {
  it("resolves currency from invoice", () => {
    expect(resolve("currency")).toBe("PHP");
  });

  it("falls back to public currency", () => {
    expect(
      resolve("currency", {
        invoice: undefined,
        public: createPublicSummary({
          currency: "USD",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("USD");
  });

  it("formats subtotal to two decimal places", () => {
    expect(resolve("subtotal")).toBe("10000.00");
  });

  it("formats discount total to two decimal places", () => {
    expect(resolve("discountTotal")).toBe("500.00");
  });

  it("formats tax total to two decimal places", () => {
    expect(resolve("taxTotal")).toBe("1140.00");
  });

  it("formats withholding total to two decimal places", () => {
    expect(resolve("withholdingTotal")).toBe("200.00");
  });

  it("formats grand total from the full invoice", () => {
    expect(resolve("grandTotal")).toBe("10640.00");
  });

  it("falls back to public totalAmount", () => {
    expect(
      resolve("grandTotal", {
        invoice: undefined,
        public: createPublicSummary({
          totalAmount: 2500,
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("2500.00");
  });

  it("returns empty grand total when neither source has a total", () => {
    expect(
      resolve("grandTotal", {
        invoice: undefined,
        public: createPublicSummary({
          totalAmount: undefined,
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("");
  });

  it("formats net payable to two decimal places", () => {
    expect(resolve("netPayable")).toBe("10440.00");
  });

  it("formats effective tax rate as a percentage", () => {
    expect(resolve("effectiveTaxRate")).toBe("12.00%");
  });

  it("resolves formatted total from invoice", () => {
    expect(resolve("formattedTotal")).toBe("₱10,640.00");
  });

  it("falls back to public formatted total", () => {
    expect(
      resolve("formattedTotal", {
        invoice: undefined,
        public: createPublicSummary({
          formattedTotal: "$2,500.00",
        }),
        invoiceId: "majik_001",
      }),
    ).toBe("$2,500.00");
  });

  it("returns empty for full-invoice-only monetary values when invoice is unavailable", () => {
    const ctx: CSVResolveContext = {
      invoice: undefined,
      public: createPublicSummary(),
      invoiceId: "majik_001",
    };

    expect(resolve("subtotal", ctx)).toBe("");
    expect(resolve("discountTotal", ctx)).toBe("");
    expect(resolve("taxTotal", ctx)).toBe("");
    expect(resolve("withholdingTotal", ctx)).toBe("");
    expect(resolve("netPayable", ctx)).toBe("");
    expect(resolve("effectiveTaxRate", ctx)).toBe("");
  });

  it("preserves zero monetary values", () => {
    const invoice = createInvoice({
      subtotalAmount: 0,
      discountAmount: 0,
      taxAmount: 0,
      withholdingAmount: 0,
      totalAmount: 0,
      netPayableAmount: 0,
      effectiveTaxRate: 0,
    });

    const ctx = createContext({ invoice });

    expect(resolve("subtotal", ctx)).toBe("0.00");
    expect(resolve("discountTotal", ctx)).toBe("0.00");
    expect(resolve("taxTotal", ctx)).toBe("0.00");
    expect(resolve("withholdingTotal", ctx)).toBe("0.00");
    expect(resolve("grandTotal", ctx)).toBe("0.00");
    expect(resolve("netPayable", ctx)).toBe("0.00");
    expect(resolve("effectiveTaxRate", ctx)).toBe("0.00%");
  });
});

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

describe("Payment column resolvers", () => {
  it("formats total paid to two decimal places", () => {
    expect(resolve("totalPaid")).toBe("4000.00");
  });

  it("formats amount due to two decimal places", () => {
    expect(resolve("amountDue")).toBe("6440.00");
  });

  it("resolves fully-paid state", () => {
    expect(resolve("isFullyPaid")).toBe("false");
  });

  it("resolves fully-paid state when true", () => {
    const invoice = createInvoice({
      isFullyPaid: true,
    });

    expect(resolve("isFullyPaid", createContext({ invoice }))).toBe("true");
  });

  it("resolves payment count", () => {
    expect(resolve("paymentCount")).toBe("2");
  });

  it("returns empty payment fields when invoice is unavailable", () => {
    const ctx: CSVResolveContext = {
      invoice: undefined,
      public: createPublicSummary(),
      invoiceId: "majik_001",
    };

    expect(resolve("totalPaid", ctx)).toBe("");
    expect(resolve("amountDue", ctx)).toBe("");
    expect(resolve("isFullyPaid", ctx)).toBe("");
    expect(resolve("paymentCount", ctx)).toBe("");
  });

  it("handles zero recorded payments", () => {
    const invoice = createInvoice({
      totalPaid: money(0),
      amountDue: money(10640),
      isFullyPaid: false,
      proofOfPayments: [],
    });

    const ctx = createContext({ invoice });

    expect(resolve("totalPaid", ctx)).toBe("0.00");
    expect(resolve("amountDue", ctx)).toBe("10640.00");
    expect(resolve("paymentCount", ctx)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Line item columns
// ---------------------------------------------------------------------------

describe("Line-item column resolvers", () => {
  it("resolves line item count", () => {
    expect(resolve("lineItemCount")).toBe("2");
  });

  it("resolves all line item descriptions in order", () => {
    expect(resolve("lineItemDescriptions")).toBe(
      "Software Development | Consulting",
    );
  });

  it("resolves all line item quantities in order", () => {
    expect(resolve("lineItemQuantities")).toBe("2 | 1");
  });

  it("resolves all line item unit prices to two decimals", () => {
    expect(resolve("lineItemUnitPrices")).toBe("4000.00 | 2000.00");
  });

  it("resolves all line item net totals to two decimals", () => {
    expect(resolve("lineItemNetTotals")).toBe("8000.00 | 2000.00");
  });

  it("returns empty values when invoice is unavailable", () => {
    const ctx: CSVResolveContext = {
      invoice: undefined,
      public: createPublicSummary(),
      invoiceId: "majik_001",
    };

    expect(resolve("lineItemCount", ctx)).toBe("");
    expect(resolve("lineItemDescriptions", ctx)).toBe("");
    expect(resolve("lineItemQuantities", ctx)).toBe("");
    expect(resolve("lineItemUnitPrices", ctx)).toBe("");
    expect(resolve("lineItemNetTotals", ctx)).toBe("");
  });

  it("handles an invoice with no line items", () => {
    const invoice = createInvoice({
      lineItemCount: 0,
      lineItems: [],
    });

    const ctx = createContext({ invoice });

    expect(resolve("lineItemCount", ctx)).toBe("0");
    expect(resolve("lineItemDescriptions", ctx)).toBe("");
    expect(resolve("lineItemQuantities", ctx)).toBe("");
    expect(resolve("lineItemUnitPrices", ctx)).toBe("");
    expect(resolve("lineItemNetTotals", ctx)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Accounting and metadata
// ---------------------------------------------------------------------------

describe("Accounting and metadata column resolvers", () => {
  it("joins cost centers using the documented separator", () => {
    expect(resolve("costCenters")).toBe("CC-100 | CC-200");
  });

  it("joins account codes using the documented separator", () => {
    expect(resolve("accountCodes")).toBe("4000 | 4100");
  });

  it("joins tax types using the documented separator", () => {
    expect(resolve("taxTypes")).toBe("VAT | EWT");
  });

  it("resolves notes", () => {
    expect(resolve("notes")).toBe("Payment due within 30 days.");
  });

  it("joins tags using comma-space", () => {
    expect(resolve("tags")).toBe("software, consulting");
  });

  it("handles empty accounting arrays", () => {
    const invoice = createInvoice({
      costCenters: [],
      accountCodes: [],
      taxTypes: [],
    });

    const ctx = createContext({ invoice });

    expect(resolve("costCenters", ctx)).toBe("");
    expect(resolve("accountCodes", ctx)).toBe("");
    expect(resolve("taxTypes", ctx)).toBe("");
  });

  it("handles missing tags", () => {
    const invoice = createInvoice({
      tags: undefined,
    });

    expect(resolve("tags", createContext({ invoice }))).toBe("");
  });

  it("handles an empty tag list", () => {
    const invoice = createInvoice({
      tags: [],
    });

    expect(resolve("tags", createContext({ invoice }))).toBe("");
  });

  it("returns empty accounting/meta values without a full invoice", () => {
    const ctx: CSVResolveContext = {
      invoice: undefined,
      public: createPublicSummary(),
      invoiceId: "majik_001",
    };

    expect(resolve("costCenters", ctx)).toBe("");
    expect(resolve("accountCodes", ctx)).toBe("");
    expect(resolve("taxTypes", ctx)).toBe("");
    expect(resolve("notes", ctx)).toBe("");
    expect(resolve("tags", ctx)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Public-only / locked invoice behavior
// ---------------------------------------------------------------------------

describe("Public-only / locked invoice behavior", () => {
  const publicOnlyContext: CSVResolveContext = {
    invoice: undefined,
    public: createPublicSummary({
      invoiceNumber: "LOCKED-001",
      invoiceType: "invoice",
      status: "issued",
      paymentStatus: "unpaid",
      issuerName: "Locked Issuer",
      recipientName: "Locked Recipient",
      issuedAt: "2026-09-01T00:00:00.000Z",
      dueDate: "2026-10-01T00:00:00.000Z",
      currency: "PHP",
      totalAmount: 5000,
      formattedTotal: "₱5,000.00",
    }),
    invoiceId: "locked_001",
  };

  it("exports all public-fallback fields when invoice is locked", () => {
    expect(resolve("id", publicOnlyContext)).toBe("locked_001");
    expect(resolve("invoiceNumber", publicOnlyContext)).toBe("LOCKED-001");
    expect(resolve("type", publicOnlyContext)).toBe("invoice");
    expect(resolve("status", publicOnlyContext)).toBe("issued");
    expect(resolve("paymentStatus", publicOnlyContext)).toBe("unpaid");
    expect(resolve("issuerName", publicOnlyContext)).toBe("Locked Issuer");
    expect(resolve("recipientName", publicOnlyContext)).toBe(
      "Locked Recipient",
    );
    expect(resolve("issueDate", publicOnlyContext)).toBe("2026-09-01");
    expect(resolve("dueDate", publicOnlyContext)).toBe("2026-10-01");
    expect(resolve("currency", publicOnlyContext)).toBe("PHP");
    expect(resolve("grandTotal", publicOnlyContext)).toBe("5000.00");
    expect(resolve("formattedTotal", publicOnlyContext)).toBe("₱5,000.00");
  });

  it("returns blank values for full-invoice-only fields when locked", () => {
    const fullInvoiceOnlyKeys = [
      "issuerTin",
      "issuerEmail",
      "issuerAddress",
      "recipientTin",
      "recipientEmail",
      "recipientAddress",
      "periodStart",
      "periodEnd",
      "paymentTerms",
      "subtotal",
      "discountTotal",
      "taxTotal",
      "withholdingTotal",
      "netPayable",
      "effectiveTaxRate",
      "totalPaid",
      "amountDue",
      "isFullyPaid",
      "paymentCount",
      "lineItemCount",
      "lineItemDescriptions",
      "lineItemQuantities",
      "lineItemUnitPrices",
      "lineItemNetTotals",
      "costCenters",
      "accountCodes",
      "taxTypes",
      "notes",
      "tags",
    ];

    for (const key of fullInvoiceOnlyKeys) {
      expect(resolve(key, publicOnlyContext), key).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// CSV header
// ---------------------------------------------------------------------------

describe("buildCSVHeader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an empty header from an empty column list", () => {
    expect(buildCSVHeader([])).toBe("");
  });

  it("preserves column order", () => {
    const columns = [
      column("id"),
      column("invoiceNumber"),
      column("grandTotal"),
    ];

    expect(buildCSVHeader(columns)).toBe(
      "Invoice ID,Invoice Number,Grand Total",
    );
  });

  it("escapes commas in header labels", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Amount, Net",
        group: "meta",
        resolve: () => "",
      },
    ];

    expect(buildCSVHeader(columns)).toBe('"Amount, Net"');
  });

  it("escapes quotes in header labels", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: 'Amount "Net"',
        group: "meta",
        resolve: () => "",
      },
    ];

    expect(buildCSVHeader(columns)).toBe('"Amount ""Net"""');
  });

  it("flattens newlines in header labels by default", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Amount\nNet",
        group: "meta",
        resolve: () => "",
      },
    ];

    expect(buildCSVHeader(columns)).toBe("Amount Net");
  });
});

// ---------------------------------------------------------------------------
// CSV row
// ---------------------------------------------------------------------------

describe("buildCSVRow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an empty row from an empty column list", () => {
    expect(buildCSVRow(createContext(), [])).toBe("");
  });

  it("builds a row in column order", () => {
    const columns = [
      column("id"),
      column("invoiceNumber"),
      column("currency"),
      column("grandTotal"),
    ];

    expect(buildCSVRow(createContext(), columns)).toBe(
      "inv_001,INV-2026-001,PHP,10640.00",
    );
  });

  it("escapes commas inside cell values", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => "Hello, world",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe('"Hello, world"');
  });

  it("escapes embedded double quotes", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => 'He said "hello"',
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe('"He said ""hello"""');
  });

  it("flattens a single newline by default", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => "line one\nline two",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("line one line two");
  });

  it("flattens multiple consecutive newlines to the documented separator", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => "line one\n\nline two",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("line one || line two");
  });

  it("normalizes CRLF line endings", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => "line one\r\nline two",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("line one line two");
  });

  it("normalizes CR-only line endings", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => "line one\rline two",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("line one line two");
  });

  it("removes null bytes", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => "hello\0world",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("helloworld");
  });

  it("converts null resolver values to empty cells at runtime", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => null as unknown as string,
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("");
  });

  it("converts undefined resolver values to empty cells at runtime", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => undefined as unknown as string,
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("");
  });

  it("stringifies non-string runtime values returned by a resolver", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => 123.45 as unknown as string,
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("123.45");
  });

  it("keeps quoted multiline cells safe if a newline survives", () => {
    const columns: CSVColumn[] = [
      {
        key: "custom",
        label: "Custom",
        group: "meta",
        resolve: () => "a,b\nc",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe('"a,b c"');
  });

  it("does not abort the row when an individual resolver throws", () => {
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);

    const columns: CSVColumn[] = [
      {
        key: "first",
        label: "First",
        group: "meta",
        resolve: () => "A",
      },
      {
        key: "broken",
        label: "Broken",
        group: "meta",
        resolve: () => {
          throw new Error("boom");
        },
      },
      {
        key: "third",
        label: "Third",
        group: "meta",
        resolve: () => "C",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("A,,C");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      "Problem building row: ",
      expect.any(Error),
    );
  });

  it("isolates multiple failing resolvers independently", () => {
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);

    const columns: CSVColumn[] = [
      {
        key: "one",
        label: "One",
        group: "meta",
        resolve: () => {
          throw new Error("one");
        },
      },
      {
        key: "two",
        label: "Two",
        group: "meta",
        resolve: () => "ok",
      },
      {
        key: "three",
        label: "Three",
        group: "meta",
        resolve: () => {
          throw new Error("three");
        },
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe(",ok,");

    expect(debugSpy).toHaveBeenCalledTimes(2);
  });

  it("still generates a complete row when malformed invoice data makes a resolver throw", () => {
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);

    const malformedInvoice = {
      ...createInvoice(),
      issuer: undefined,
      recipient: undefined,
    } as unknown as GeneralInvoice;

    const columns = [
      column("id"),
      column("issuerName"),
      column("issuerTin"),
      column("recipientName"),
      column("recipientTin"),
      column("currency"),
    ];

    expect(
      buildCSVRow(
        createContext({
          invoice: malformedInvoice,
        }),
        columns,
      ),
    ).toBe("inv_001,,,,,PHP");

    expect(debugSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CSV escaping / injection regression coverage
// ---------------------------------------------------------------------------

describe("CSV escaping security behavior", () => {
  it("escapes a simple spreadsheet formula according to the documented behavior", () => {
    const columns: CSVColumn[] = [
      {
        key: "formula",
        label: "Formula",
        group: "meta",
        resolve: () => "=SUM(A1:A2)",
      },
    ];

    /*
     * This is the documented/intended behavior.
     *
     * With the current implementation's regex:
     *
     *   /^\\s\\*[=+\\-@]/
     *
     * this test exposes a bug because the regex requires a literal `*`
     * after whitespace. The intended regex is likely:
     *
     *   /^\\s*[=+\\-@]/
     */
    expect(buildCSVRow(createContext(), columns)).toBe("'=SUM(A1:A2)");
  });

  it("protects a plus-prefixed formula", () => {
    const columns: CSVColumn[] = [
      {
        key: "formula",
        label: "Formula",
        group: "meta",
        resolve: () => "+SUM(A1:A2)",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("'+SUM(A1:A2)");
  });

  it("protects a minus-prefixed formula", () => {
    const columns: CSVColumn[] = [
      {
        key: "formula",
        label: "Formula",
        group: "meta",
        resolve: () => "-1+2",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("'-1+2");
  });
  it("protects an @-prefixed formula", () => {
    const columns: CSVColumn[] = [
      {
        key: "formula",
        label: "Formula",
        group: "meta",
        resolve: () => "@SUM(A1:A2)",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("'@SUM(A1:A2)");
  });

  it("removes null bytes before security-sensitive processing", () => {
    const columns: CSVColumn[] = [
      {
        key: "value",
        label: "Value",
        group: "meta",
        resolve: () => "abc\0def",
      },
    ];

    expect(buildCSVRow(createContext(), columns)).toBe("abcdef");
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("dedupeColumns", () => {
  it("returns an empty array for empty input", () => {
    expect(dedupeColumns([])).toEqual([]);
  });

  it("returns the same logical columns when there are no duplicates", () => {
    const columns = [
      column("id"),
      column("invoiceNumber"),
      column("grandTotal"),
    ];

    expect(dedupeColumns(columns)).toEqual(columns);
  });

  it("removes duplicate keys", () => {
    const first = {
      key: "duplicate",
      label: "First",
      group: "meta" as const,
      resolve: () => "first",
    };

    const second = {
      key: "duplicate",
      label: "Second",
      group: "totals" as const,
      resolve: () => "second",
    };

    const result = dedupeColumns([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(first);
  });

  it("preserves the first occurrence when duplicates appear multiple times", () => {
    const first = {
      key: "x",
      label: "First",
      group: "meta" as const,
      resolve: () => "1",
    };

    const second = {
      key: "y",
      label: "Second",
      group: "meta" as const,
      resolve: () => "2",
    };

    const third = {
      key: "x",
      label: "Third",
      group: "meta" as const,
      resolve: () => "3",
    };

    const fourth = {
      key: "y",
      label: "Fourth",
      group: "meta" as const,
      resolve: () => "4",
    };

    expect(dedupeColumns([first, second, third, fourth])).toEqual([
      first,
      second,
    ]);
  });

  it("preserves first-occurrence order", () => {
    const columns = [
      column("grandTotal"),
      column("id"),
      column("status"),
      column("id"),
      column("grandTotal"),
    ];

    expect(dedupeColumns(columns).map((c) => c.key)).toEqual([
      "grandTotal",
      "id",
      "status",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dynamic tax columns
// ---------------------------------------------------------------------------

describe("buildTaxBreakdownColumns", () => {
  it("returns an empty array for no tax types", () => {
    expect(buildTaxBreakdownColumns([])).toEqual([]);
  });

  it("creates two columns per tax type", () => {
    const columns = buildTaxBreakdownColumns(["VAT", "EWT"]);

    expect(columns).toHaveLength(4);

    expect(columns.map((c) => c.key)).toEqual([
      "tax_VAT_additive",
      "tax_VAT_withholding",
      "tax_EWT_additive",
      "tax_EWT_withholding",
    ]);

    expect(columns.map((c) => c.label)).toEqual([
      "VAT Amount",
      "VAT Withholding",
      "EWT Amount",
      "EWT Withholding",
    ]);
  });

  it("assigns every dynamic tax column to the tax group", () => {
    const columns = buildTaxBreakdownColumns(["VAT", "EWT", "CGT"]);

    expect(columns.every((c) => c.group === "tax")).toBe(true);
  });

  it("normalizes tax types to uppercase in keys and labels", () => {
    const columns = buildTaxBreakdownColumns(["vat", "eWt", "cgt"]);

    expect(columns.map((c) => c.key)).toEqual([
      "tax_VAT_additive",
      "tax_VAT_withholding",
      "tax_EWT_additive",
      "tax_EWT_withholding",
      "tax_CGT_additive",
      "tax_CGT_withholding",
    ]);

    expect(columns.map((c) => c.label)).toEqual([
      "VAT Amount",
      "VAT Withholding",
      "EWT Amount",
      "EWT Withholding",
      "CGT Amount",
      "CGT Withholding",
    ]);
  });
  
  it("resolves additive tax totals using uppercase tax type", () => {
    const columns = buildTaxBreakdownColumns(["vat"]);

    const invoice = createInvoice();
    const ctx = createContext({ invoice });

    expect(columns[0].resolve(ctx)).toBe("1140.00");
    expect(invoice.taxTotalByType).toHaveBeenCalledWith("VAT");
  });

  it("resolves withholding totals using uppercase tax type", () => {
    const columns = buildTaxBreakdownColumns(["ewt"]);

    const invoice = createInvoice();
    const ctx = createContext({ invoice });

    expect(columns[1].resolve(ctx)).toBe("200.00");
    expect(invoice.withholdingTotalByType).toHaveBeenCalledWith("EWT");
  });

  it("returns zero when a tax type has no corresponding amount", () => {
    const columns = buildTaxBreakdownColumns(["UNKNOWN"]);
    const invoice = createInvoice();

    const ctx = createContext({ invoice });

    expect(columns[0].resolve(ctx)).toBe("0.00");
    expect(columns[1].resolve(ctx)).toBe("0.00");
  });

  it("returns empty strings when no full invoice is available", () => {
    const columns = buildTaxBreakdownColumns(["VAT", "EWT"]);

    const ctx: CSVResolveContext = {
      invoice: undefined,
      public: createPublicSummary(),
      invoiceId: "locked_001",
    };

    for (const col of columns) {
      expect(col.resolve(ctx)).toBe("");
    }
  });

  it("creates fresh arrays and column descriptors on each call", () => {
    const first = buildTaxBreakdownColumns(["VAT"]);
    const second = buildTaxBreakdownColumns(["VAT"]);

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[1]).not.toBe(second[1]);
  });

  it("does not mutate the supplied tax types array", () => {
    const taxTypes = ["vat", "ewt"];
    const original = [...taxTypes];

    buildTaxBreakdownColumns(taxTypes);

    expect(taxTypes).toEqual(original);
  });

  it("preserves duplicate tax types rather than deduplicating them", () => {
    const columns = buildTaxBreakdownColumns(["VAT", "VAT"]);

    expect(columns.map((c) => c.key)).toEqual([
      "tax_VAT_additive",
      "tax_VAT_withholding",
      "tax_VAT_additive",
      "tax_VAT_withholding",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Full export composition
// ---------------------------------------------------------------------------

describe("CSV export composition", () => {
  it("can construct a complete header and row from DEFAULT_CSV_COLUMNS", () => {
    const invoice = createInvoice();

    const ctx = createContext({
      invoice,
    });

    const header = buildCSVHeader(DEFAULT_CSV_COLUMNS);
    const row = buildCSVRow(ctx, DEFAULT_CSV_COLUMNS);

    expect(header).toBe(
      [
        "Invoice ID",
        "Invoice Number",
        "Invoice Type",
        "Invoice Status",
        "Issuer Name",
        "Recipient Name",
        "Issue Date",
        "Due Date",
        "Currency",
        "Subtotal",
        "Total Tax",
        "Grand Total",
        "Net Payable",
        "Payment Status",
        "Total Paid",
        "Amount Due",
      ].join(","),
    );

    expect(row).toBe(
      [
        "inv_001",
        "INV-2026-001",
        "invoice",
        "issued",
        "Acme Corporation",
        "Client Corporation",
        "2026-09-01",
        "2026-10-01",
        "PHP",
        "10000.00",
        "1140.00",
        "10640.00",
        "10440.00",
        "partial",
        "4000.00",
        "6440.00",
      ].join(","),
    );
  });

  it("can compose static and dynamic columns together", () => {
    const taxColumns = buildTaxBreakdownColumns(["VAT", "EWT"]);

    const columns = dedupeColumns([...DEFAULT_CSV_COLUMNS, ...taxColumns]);

    expect(columns.map((c) => c.key)).toEqual([
      ...DEFAULT_CSV_COLUMNS.map((c) => c.key),
      "tax_VAT_additive",
      "tax_VAT_withholding",
      "tax_EWT_additive",
      "tax_EWT_withholding",
    ]);

    const row = buildCSVRow(createContext(), columns);

    expect(row).toContain("1140.00,0.00,0.00,200.00");
  });

  it("supports custom columns with arbitrary user-defined resolvers", () => {
    const customColumns: CSVColumn[] = [
      {
        key: "customA",
        label: "Custom A",
        group: "meta",
        resolve: ({ invoice }) => invoice?.invoiceNumber ?? "",
      },
      {
        key: "customB",
        label: "Custom B",
        group: "meta",
        resolve: ({ invoiceId }) => invoiceId,
      },
    ];

    expect(buildCSVHeader(customColumns)).toBe("Custom A,Custom B");

    expect(buildCSVRow(createContext(), customColumns)).toBe(
      "INV-2026-001,majik_001",
    );
  });

  it("supports a fully public-only export without throwing", () => {
    const columns = DEFAULT_CSV_COLUMNS;

    const row = buildCSVRow(
      {
        invoice: undefined,
        public: createPublicSummary({
          invoiceNumber: "LOCKED-001",
          invoiceType: "invoice",
          status: "issued",
          issuerName: "Issuer",
          recipientName: "Recipient",
          issuedAt: "2026-09-01T00:00:00.000Z",
          dueDate: "2026-10-01T00:00:00.000Z",
          currency: "PHP",
          totalAmount: 1000,
          formattedTotal: "₱1,000.00",
        }),
        invoiceId: "locked_001",
      },
      columns,
    );

    expect(row).toBe(
      [
        "locked_001",
        "LOCKED-001",
        "invoice",
        "issued",
        "Issuer",
        "Recipient",
        "2026-09-01",
        "2026-10-01",
        "PHP",
        "",
        "",
        "1000.00",
        "",
        "unpaid",
        "",
        "",
      ].join(","),
    );
  });

  it("does not throw when every resolver receives an empty context", () => {
    const ctx: CSVResolveContext = {
      invoice: undefined,
      public: undefined,
      invoiceId: "",
    };

    expect(() => buildCSVRow(ctx, ALL_CSV_COLUMNS)).not.toThrow();
    expect(buildCSVRow(ctx, ALL_CSV_COLUMNS)).toBe(
      [
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ].join(","),
    );
  });
});

// ---------------------------------------------------------------------------
// Resolver contract tests
// ---------------------------------------------------------------------------

describe("CSV resolver contracts", () => {
  it("every static resolver returns a string for a valid full invoice context", () => {
    const ctx = createContext();

    for (const col of ALL_CSV_COLUMNS) {
      expect(typeof col.resolve(ctx), `${col.key} should return a string`).toBe(
        "string",
      );
    }
  });

  it("every static resolver can execute with no invoice and no public summary", () => {
    const ctx: CSVResolveContext = {
      invoice: undefined,
      public: undefined,
      invoiceId: "fallback-id",
    };

    for (const col of ALL_CSV_COLUMNS) {
      expect(
        () => col.resolve(ctx),
        `${col.key} should not throw`,
      ).not.toThrow();
    }
  });

  it("all static columns produce the expected groups", () => {
    const groupsByKey: Record<string, string> = {
      id: "identity",
      invoiceNumber: "identity",
      type: "identity",
      status: "identity",
      paymentStatus: "identity",

      issuerName: "parties",
      issuerTin: "parties",
      issuerEmail: "parties",
      issuerAddress: "parties",
      recipientName: "parties",
      recipientTin: "parties",
      recipientEmail: "parties",
      recipientAddress: "parties",

      issueDate: "dates",
      dueDate: "dates",
      periodStart: "dates",
      periodEnd: "dates",
      paymentTerms: "dates",

      currency: "totals",
      subtotal: "totals",
      discountTotal: "totals",
      taxTotal: "totals",
      withholdingTotal: "totals",
      grandTotal: "totals",
      netPayable: "totals",
      effectiveTaxRate: "totals",
      formattedTotal: "totals",

      totalPaid: "payment",
      amountDue: "payment",
      isFullyPaid: "payment",
      paymentCount: "payment",

      lineItemCount: "line_items",
      lineItemDescriptions: "line_items",
      lineItemQuantities: "line_items",
      lineItemUnitPrices: "line_items",
      lineItemNetTotals: "line_items",

      costCenters: "accounting",
      accountCodes: "accounting",
      taxTypes: "accounting",

      notes: "meta",
      tags: "meta",
    };

    for (const col of ALL_CSV_COLUMNS) {
      expect(col.group, col.key).toBe(groupsByKey[col.key]);
    }
  });
});
