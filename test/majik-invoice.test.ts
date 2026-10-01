/**
 * @file majik-invoice.test.ts
 *
 * Comprehensive unit/integration test suite for the MajikInvoice envelope.
 *
 * Coverage:
 * - factory/default construction
 * - MajikInvoice input validation
 * - signed-only and encrypted-and-signed creation
 * - public summary and integrity construction
 * - cryptographic signing, verification, allowlists and sealing
 * - encryption/decryption and runtime cache lifecycle
 * - mode conversion and reissue workflows
 * - payment/settlement propagation
 * - restart and duplication
 * - structural validation and JSON parsing
 * - JSON string, cloud JSON and binary serialization
 * - CSV export, batch CSV, dashboard statistics
 * - batch decryption / locking / overdue processing
 * - capability checks and signer state
 * - sent/retention helpers
 * - synchronization, diffing and conflict resolution
 * - positive and negative paths for the public API
 *
 * NOTE:
 * This suite intentionally contains a small number of contract/regression tests
 * that may fail against the current implementation when behavior documented by
 * the class differs from what the current implementation actually enforces.
 * Those tests are useful: they identify places where the orchestrator needs to
 * be corrected rather than weakening the test suite around the implementation.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  GeneralInvoice,
  MajikInvoice,
  MajikInvoiceEncryptionError,
  MajikInvoiceError,
  MajikInvoiceKeyError,
  MajikInvoiceSealError,
  MajikInvoiceSerializationError,
  MajikInvoiceSignatureError,
} from "../src/";

import type {
  GeneralInvoiceInput,
  Party,
  ProofOfPayment,
} from "../src/core/general-invoice";

import type {
  EncryptedPayload,
  MajikInvoiceInput,
  MajikInvoiceJSON,
  MajikahInvoiceJSON,
} from "../src/core/types";

import type { MajikKey } from "@majikah/majik-key";
import type { MajikRecipient } from "@majikah/majik-envelope";

import { MJKI_HEADER_SIZE, MJKI_MAGIC, MJKI_VERSION } from "../src/core/binary";
import { sha256Hex } from "../src/core/crypto-utils";
import { DEFAULT_CSV_COLUMNS, type CSVColumn } from "../src/core/csv-export";
import { getTestKey } from "./helpers/crypto";
import { ExpectedSigner } from "@majikah/majik-signature";
import { dedupeInvoices } from "../src/core/majik-invoice";

// ============================================================================
// Constants / Shared fixtures
// ============================================================================

const FIXED_NOW = "2026-10-01T12:00:00.000Z";
const FIXED_TODAY = "2026-10-01";

// ── SHARED KEY POOL ────────────────────────────────────────────────────────
//
// ML-KEM + ML-DSA key generation is intentionally performed once for the
// complete suite. The same unlocked key objects are safely reused by tests
// because signing and verification are observational with respect to key state.
//
// Roles:
//   keyA   — issuer / primary signer
//   keyB   — recipient / second signer
//   keyC   — third recipient / alternate signer
//   keyD   — unauthorized signer / intruder
//   tsaKey — structurally separate authority fixture for negative/semantic use
//
let keyA!: MajikKey;
let keyB!: MajikKey;
let keyC!: MajikKey;
let keyD!: MajikKey;
let tsaKey!: MajikKey;

// ============================================================================
// Suite
// ============================================================================

describe("MajikInvoice", () => {
  // ========================================================================
  // Fixtures
  // ========================================================================

  const makeIssuer = (overrides: Partial<Party> = {}): Party => ({
    legalName: "Majikah Solutions OPC",
    tin: "123-456-789-000",
    address: {
      country: "PH",
      city: "Mandaluyong",
      line1: "ABC 123",
    },
    ...overrides,
  });

  const makeRecipient = (overrides: Partial<Party> = {}): Party => ({
    legalName: "Example Client",
    tin: "987-654-321-000",
    address: {
      country: "US",
      city: "New York",
      line1: "XYZ 123",
    },
    ...overrides,
  });

  const makeBaseInput = (
    overrides: Partial<GeneralInvoiceInput> = {},
  ): GeneralInvoiceInput => ({
    id: "inv-test-001",
    invoiceNumber: "INV-2026-001",
    issuer: makeIssuer(),
    recipient: makeRecipient(),
    currency: "PHP",
    issueDate: FIXED_TODAY,
    lineItems: [
      {
        id: "li-1",
        description: "Software Development",
        quantity: 1,
        unitPrice: 1_000,
      },
    ],
    ...overrides,
  });

  const makePayment = (
    overrides: Partial<ProofOfPayment> = {},
  ): ProofOfPayment => ({
    id: "pay-1",
    amount: 100,
    currency: "PHP",
    settledAt: "2026-10-01T13:00:00.000Z",
    method: "Cash",
    reference: "REF-001",
    ...overrides,
  });

  const makeRecipientForKey = (key: MajikKey): MajikRecipient =>
    ({
      fingerprint: key.fingerprint,
      mlKemPublicKey: key.mlKemPublicKey,
      // Kept as an extra compatibility field for envelope versions that expose
      // recipient public addresses alongside ML-KEM material.
      publicKey: key.publicKeyBase64,
    }) as unknown as MajikRecipient;

  const makeExpectedSigners = (): ExpectedSigner[] => {
    const jsonKeyA = keyA.toJSON();
    const jsonKeyB = keyB.toJSON();

    return [
      {
        signerId: keyA.fingerprint,
        edPublicKey: jsonKeyA.edPublicKey!,
        mlDsaPublicKey: jsonKeyA.mlDsaPublicKey!,
      },
      {
        signerId: keyB.fingerprint,
        edPublicKey: jsonKeyB.edPublicKey!,
        mlDsaPublicKey: jsonKeyB.mlDsaPublicKey!,
      },
    ];
  };

  const createInvoice = async (
    overrides: Partial<MajikInvoiceInput> = {},
  ): Promise<MajikInvoice> => {
    return MajikInvoice.create({
      ...makeBaseInput(),
      mode: "signed-only",
      ...overrides,
    });
  };

  const createSignedInvoice = async (
    overrides: Partial<MajikInvoiceInput> = {},
  ): Promise<MajikInvoice> => {
    return MajikInvoice.create({
      ...makeBaseInput(),
      mode: "signed-only",
      signerKey: keyA,
      ...overrides,
    });
  };

  const createAllowlistedInvoice = async (
    overrides: Partial<MajikInvoiceInput> = {},
  ): Promise<MajikInvoice> => {
    return MajikInvoice.create({
      ...makeBaseInput(),
      mode: "signed-only",
      signerKey: keyA,
      expectedSigners: makeExpectedSigners(),
      ...overrides,
    });
  };

  const createEncryptedInvoice = async (
    overrides: Partial<MajikInvoiceInput> = {},
  ): Promise<MajikInvoice> => {
    return MajikInvoice.create({
      ...makeBaseInput(),
      mode: "encrypted-and-signed",
      signerKey: keyA,
      recipients: [makeRecipientForKey(keyB)],
      recipientPublicKeys: [keyB.publicKeyBase64],
      ...overrides,
    });
  };

  /**
   * Construct an intentionally malformed object without going through the
   * protected constructor so that the public validate()/integrityStatus paths
   * themselves can be tested for bad envelope shapes.
   */
  const makeUnsafeInvoice = (
    overrides: Record<string, unknown> = {},
  ): MajikInvoice => {
    const base = {
      id: "unsafe-invoice",
      version: "1.0.0",
      mode: "signed-only",
      public: {
        issuerName: "Issuer",
        recipientName: "Recipient",
        currency: "PHP",
        totalAmount: 1_000,
        formattedTotal: "₱1,000.00",
        invoiceType: "commercial",
        issuedAt: FIXED_TODAY,
        dueDate: undefined,
        invoiceNumber: "INV-001",
        status: "draft",
        paymentStatus: "pending",
      },
      payload: {
        kind: "signed-only",
        invoice: {},
      },
      integrity: {
        contentHash: "a".repeat(64),
        hashAlgorithm: "SHA-256",
        signatures: [],
        isSealed: false,
      },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      recipients: [],
    };

    return Object.assign(
      Object.create(MajikInvoice.prototype),
      base,
      overrides,
    ) as MajikInvoice;
  };

  const expectReject = async <T>(
    promise: Promise<T>,
    errorClass: new (...args: any[]) => Error,
    message?: string | RegExp,
  ) => {
    await expect(promise).rejects.toBeInstanceOf(errorClass);
    if (message) {
      await expect(promise).rejects.toThrow(message);
    }
  };

  const expectThrow = (
    fn: () => unknown,
    errorClass: new (...args: any[]) => Error,
    message?: string | RegExp,
  ) => {
    expect(fn).toThrow(errorClass);
    if (message) expect(fn).toThrow(message);
  };

  beforeAll(async () => {
    console.log(
      "[majik-invoice] Generating shared key pool (5 keys, parallel)...",
    );

    [keyA, keyB, keyC, keyD, tsaKey] = await Promise.all([
      getTestKey(),
      getTestKey(),
      getTestKey(),
      getTestKey(),
      getTestKey(),
    ]);

    console.log("[majik-invoice] Shared key pool ready.");
  }, 120_000);

  afterAll(() => {
    for (const key of [keyA, keyB, keyC, keyD, tsaKey]) {
      try {
        key?.lock();
      } catch {
        // Test cleanup must not mask test failures.
      }
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ========================================================================
  // Factory / construction
  // ========================================================================

  describe("Factory & Construction", () => {
    it("creates a MajikInvoice instance", async () => {
      const invoice = await createInvoice();
      expect(invoice).toBeInstanceOf(MajikInvoice);
    });

    it("defaults mode to signed-only", async () => {
      const invoice = await MajikInvoice.create(makeBaseInput());
      expect(invoice.mode).toBe("signed-only");
      expect(invoice.isSignedOnly).toBe(true);
      expect(invoice.isEncrypted).toBe(false);
    });

    it("preserves the source invoice ID", async () => {
      const invoice = await createInvoice({ id: "INV-ID" });
      expect(invoice.id).toBe("INV-ID");
      expect(invoice.invoice.id).toBe("INV-ID");
    });

    it("creates the expected signed-only payload shape", async () => {
      const invoice = await createInvoice();
      expect(invoice.payload.kind).toBe("signed-only");
      expect(invoice.payload).toHaveProperty("invoice");
    });

    it("creates an initial unsigned integrity block when no signer is supplied", async () => {
      const invoice = await createInvoice();

      expect(invoice.integrity.hashAlgorithm).toBe("SHA-256");
      expect(invoice.integrity.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(invoice.integrity.signatures).toEqual([]);
      expect(invoice.integrity.isSealed).toBe(false);
      expect(invoice.integrityStatus).toBe("unsigned");
    });

    it("creates a signed invoice when signerKey is supplied", async () => {
      const invoice = await createSignedInvoice();

      expect(invoice.isSigned).toBe(true);
      expect(invoice.signatureCount).toBe(1);
      expect(invoice.integrityStatus).toBe("fully-signed");
      expect(invoice.signerIds).toEqual([keyA.fingerprint]);
    });

    it("builds a complete public summary", async () => {
      const invoice = await createInvoice({
        invoiceNumber: "INV-100",
        dueDate: "2026-10-31",
        type: "tax",
      });

      expect(invoice.public).toEqual(
        expect.objectContaining({
          issuerName: "Majikah Solutions OPC",
          recipientName: "Example Client",
          currency: "PHP",
          totalAmount: 1_000,
          invoiceType: "tax",
          issuedAt: FIXED_TODAY,
          dueDate: "2026-10-31",
          invoiceNumber: "INV-100",
          status: "draft",
          paymentStatus: "pending",
        }),
      );
    });

    it("does not expose line items in the public summary", async () => {
      const invoice = await createInvoice();
      expect(invoice.public).not.toHaveProperty("lineItems");
      expect(invoice.public).not.toHaveProperty("proofOfPayments");
    });

    it("uses current timestamps for createdAt and updatedAt", async () => {
      const invoice = await createInvoice();
      expect(invoice.createdAt).toBe(FIXED_NOW);
      expect(invoice.updatedAt).toBe(FIXED_NOW);
    });

    it("preserves userId and accountId", async () => {
      const invoice = await createInvoice({
        userId: " user-1 ",
        accountId: " account-1 ",
      });

      // create() deliberately preserves raw values; trimming is done through
      // withUserId()/withAccountId().
      expect(invoice.userId).toBe(" user-1 ");
      expect(invoice.accountId).toBe(" account-1 ");
    });

    it("preserves recipient routing public keys", async () => {
      const invoice = await createInvoice({
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      expect(invoice.recipients).toEqual([keyB.publicKeyBase64]);
    });

    it("does not require a signer in signed-only mode", async () => {
      await expect(createInvoice()).resolves.toBeInstanceOf(MajikInvoice);
    });

    it("requires recipients for encrypted-and-signed mode", async () => {
      await expectReject(
        MajikInvoice.create({
          ...makeBaseInput(),
          mode: "encrypted-and-signed",
          signerKey: keyA,
        }),
        MajikInvoiceKeyError,
        /recipients are required/,
      );
    });

    it("creates encrypted-and-signed invoices with a valid recipient", async () => {
      const invoice = await createEncryptedInvoice();

      expect(invoice.isEncrypted).toBe(true);
      expect(invoice.isSigned).toBe(true);
      expect(invoice.payload.kind).toBe("encrypted-and-signed");
      expect(
        (invoice.payload as EncryptedPayload).recipientFingerprints,
      ).toContain(keyB.fingerprint);
      expect(invoice.integrityStatus).toBe("fully-signed");
    });

    it("locks encrypted invoices initially", async () => {
      const invoice = await createEncryptedInvoice();
      expect(invoice.isLocked).toBe(true);
      expect(invoice.hasDecryptedCache).toBe(false);
      expect(invoice.decryptedInvoice).toBeUndefined();
    });
  });

  // ========================================================================
  // Input validation
  // ========================================================================

  describe("Input Validation", () => {
    it.each(["invalid", "", "SIGNED-ONLY", "encrypted", "foo"])(
      "rejects unsupported mode %s",
      async (mode) => {
        await expectReject(
          MajikInvoice.create({
            ...makeBaseInput(),
            mode: mode as never,
          }),
          MajikInvoiceError,
          /Invalid mode/,
        );
      },
    );

    it("rejects encrypted mode with an empty recipient array", async () => {
      await expectReject(
        MajikInvoice.create({
          ...makeBaseInput(),
          mode: "encrypted-and-signed",
          recipients: [],
        }),
        MajikInvoiceKeyError,
      );
    });

    it("rejects a locked signer key", async () => {
      const lockedKey = {
        isLocked: true,
        hasSigningKeys: true,
      } as unknown as MajikKey;

      await expectReject(
        MajikInvoice.create({
          ...makeBaseInput(),
          signerKey: lockedKey,
        }),
        MajikInvoiceKeyError,
        /signerKey is locked/,
      );
    });

    it("rejects a signer without signing keys", async () => {
      const noSigningKey = {
        isLocked: false,
        hasSigningKeys: false,
      } as unknown as MajikKey;

      await expectReject(
        MajikInvoice.create({
          ...makeBaseInput(),
          signerKey: noSigningKey,
        }),
        MajikInvoiceKeyError,
        /no signing keys/,
      );
    });

    it("rejects expectedSigners without a signerKey", async () => {
      const keyJSON = keyA.toJSON();
      await expectReject(
        MajikInvoice.create({
          ...makeBaseInput(),
          expectedSigners: [
            {
              signerId: keyA.fingerprint,
              edPublicKey: keyJSON.edPublicKey!,
              mlDsaPublicKey: keyJSON.mlDsaPublicKey!,
            },
          ],
        }),
        MajikInvoiceKeyError,
        /signerKey is required/,
      );
    });

    it("rejects an empty expectedSigners array", async () => {
      await expectReject(
        MajikInvoice.create({
          ...makeBaseInput(),
          signerKey: keyA,
          expectedSigners: [],
        }),
        MajikInvoiceError,
        /non-empty array/,
      );
    });

    it("rejects non-array expectedSigners input", async () => {
      // Regression/contract test: the documented shape is an array.
      await expectReject(
        MajikInvoice.create({
          ...makeBaseInput(),
          signerKey: keyA,
          expectedSigners: { signerId: keyA.fingerprint } as never,
        }),
        MajikInvoiceError,
      );
    });

    it("allows expectedSigners when the signer is supplied", async () => {
      const invoice = await createAllowlistedInvoice();

      expect(invoice.integrity.expectedSigners).toHaveLength(2);
      expect(invoice.integrity.allowlistSignerId).toBe(keyA.fingerprint);
      expect(invoice.pendingSigners).toEqual([
        expect.objectContaining({ signerId: keyB.fingerprint }),
      ]);
    });

    it("delegates general invoice validation to GeneralInvoice", async () => {
      await expectReject(
        MajikInvoice.create({
          ...makeBaseInput({ currency: "US" as never }),
        }),
        Error,
        /currency/i,
      );
    });

    it("rejects invalid nested line items", async () => {
      await expectReject(
        MajikInvoice.create({
          ...makeBaseInput({
            lineItems: [
              {
                id: "bad",
                description: "",
                quantity: 0,
                unitPrice: -1,
              },
            ],
          }),
        }),
        Error,
      );
    });
  });

  // ========================================================================
  // Basic getters / state
  // ========================================================================

  describe("Getters & State", () => {
    it("exposes the inner GeneralInvoice in signed-only mode", async () => {
      const invoice = await createInvoice();
      expect(invoice.invoice).toBeInstanceOf(GeneralInvoice);
    });

    it("returns summary as an alias of public", async () => {
      const invoice = await createInvoice();
      expect(invoice.summary).toBe(invoice.public);
    });

    it("reports signed-only mode correctly", async () => {
      const invoice = await createInvoice();
      expect(invoice.isSignedOnly).toBe(true);
      expect(invoice.isEncrypted).toBe(false);
      expect(invoice.isLocked).toBe(false);
    });

    it("reports encrypted mode correctly", async () => {
      const invoice = await createEncryptedInvoice();
      expect(invoice.isEncrypted).toBe(true);
      expect(invoice.isSignedOnly).toBe(false);
      expect(invoice.isLocked).toBe(true);
    });

    it("exposes the public issue date as Date", async () => {
      const invoice = await createInvoice({ issueDate: "2026-09-15" });
      expect(invoice.issueDate).toEqual(new Date("2026-09-15"));
    });

    it("exposes a public due date as Date", async () => {
      const invoice = await createInvoice({ dueDate: "2026-10-15" });
      expect(invoice.dueDate).toEqual(new Date("2026-10-15"));
    });

    it("returns null when no due date exists", async () => {
      const invoice = await createInvoice();
      expect(invoice.dueDate).toBeNull();
    });

    it("returns the underlying hash through hash", async () => {
      const invoice = await createInvoice();
      expect(invoice.hash).toBe(invoice.integrity.contentHash);
    });

    it("reports unsigned state correctly", async () => {
      const invoice = await createInvoice();
      expect(invoice.isSigned).toBe(false);
      expect(invoice.signatureCount).toBe(0);
      expect(invoice.isSealed).toBe(false);
      expect(invoice.signerIds).toEqual([]);
    });

    it("reports signed state correctly", async () => {
      const invoice = await createSignedInvoice();
      expect(invoice.isSigned).toBe(true);
      expect(invoice.signatureCount).toBe(1);
      expect(invoice.hasSigned(keyA)).toBe(true);
    });
  });

  // ========================================================================
  // Mutation / metadata
  // ========================================================================

  describe("Envelope Mutations", () => {
    it("withUserId trims and rebuilds", async () => {
      const invoice = await createInvoice();
      vi.advanceTimersByTime(1000);

      const updated = invoice.withUserId("  user-123  ");

      expect(updated).not.toBe(invoice);
      expect(updated.userId).toBe("user-123");
      expect(updated.updatedAt).not.toBe(invoice.updatedAt);
      expect(invoice.userId).toBeUndefined();
    });

    it.each(["", "   ", "\t"])("withUserId rejects %j", async (value) => {
      const invoice = await createInvoice();
      expectThrow(() => invoice.withUserId(value), MajikInvoiceError, /userId/);
    });

    it("withAccountId trims and rebuilds", async () => {
      const invoice = await createInvoice();
      const updated = invoice.withAccountId("  acct-123  ");
      expect(updated.accountId).toBe("acct-123");
      expect(updated).not.toBe(invoice);
    });

    it.each(["", "   ", "\n"])("withAccountId rejects %j", async (value) => {
      const invoice = await createInvoice();
      expectThrow(
        () => invoice.withAccountId(value),
        MajikInvoiceError,
        /accountId/,
      );
    });

    it("does not mutate the original envelope through metadata changes", async () => {
      const invoice = await createInvoice({ userId: "u1" });
      const updated = invoice.withUserId("u2");
      expect(invoice.userId).toBe("u1");
      expect(updated.userId).toBe("u2");
    });

    it("secureLock is a no-op for signed-only invoices", async () => {
      const invoice = await createInvoice();
      expect(invoice.secureLock()).toBe(invoice);
      expect(invoice.isLocked).toBe(false);
    });
  });

  // ========================================================================
  // Payment / settlement propagation
  // ========================================================================

  describe("Payment & Settlement", () => {
    it("adds a payment to a signed-only invoice", async () => {
      const invoice = await createInvoice();
      const updated = invoice.addPayment(makePayment({ amount: 400 }));

      expect(updated.payments).toEqual([
        expect.objectContaining({ id: "pay-1", amount: 400 }),
      ]);
      expect(updated.totalPaid?.toMajor()).toBe(400);
      expect(updated.isFullyPaid).toBe(false);
      expect(updated.paymentStatus).toBe("partially_paid");
    });

    it("fully settles when payment matches net payable", async () => {
      const invoice = await createInvoice();
      const updated = invoice.addPayment(makePayment({ amount: 1_000 }));

      expect(updated.totalPaid?.toMajor()).toBe(1_000);
      expect(updated.isFullyPaid).toBe(true);
      expect(updated.paymentStatus).toBe("settled");
      expect(updated.status).toBe("paid");
    });

    it("preserves content hash across payment-only mutations", async () => {
      const invoice = await createSignedInvoice();
      const updated = invoice.addPayment(makePayment({ amount: 100 }));

      expect(updated.hash).toBe(invoice.hash);
      expect(updated.signatureCount).toBe(invoice.signatureCount);
      expect(updated.hasSigned(keyA)).toBe(true);
    });

    it("removes a payment", async () => {
      const invoice = await createInvoice();
      const paid = invoice.addPayment(makePayment({ amount: 100 }));
      const cleared = paid.removePayment("pay-1");

      expect(cleared.payments).toEqual([]);
      expect(cleared.paymentStatus).toBe("pending");
    });

    it("clearPayments removes all payments", async () => {
      const invoice = await createInvoice();
      const updated = invoice
        .addPayment(makePayment({ id: "p1", amount: 100 }))
        .addPayment(
          makePayment({
            id: "p2",
            amount: 200,
            settledAt: "2026-10-01T14:00:00Z",
          }),
        )
        .clearPayments();

      expect(updated.payments).toEqual([]);
      expect(updated.paymentStatus).toBe("pending");
    });

    it("rejects adding payments to a locked encrypted invoice", async () => {
      const invoice = await createEncryptedInvoice();

      expectThrow(
        () => invoice.addPayment(makePayment({ amount: 100 })),
        MajikInvoiceError,
        /encrypted and has not been decrypted/,
      );
    });

    it("rejects encrypted payment mutation even after decryption when re-encryption context is absent", async () => {
      const encrypted = await createEncryptedInvoice();
      const { instance } = await encrypted.decrypt(keyB);

      expectThrow(
        () => instance.addPayment(makePayment({ amount: 100 })),
        MajikInvoiceError,
        /without re-encryption context/,
      );
    });
  });

  // ========================================================================
  // Signing
  // ========================================================================

  describe("Signing", () => {
    it("signs an unsigned invoice", async () => {
      const invoice = await createInvoice();
      const signed = await invoice.sign(keyA);

      expect(signed).not.toBe(invoice);
      expect(signed.signatureCount).toBe(1);
      expect(signed.signerIds).toContain(keyA.fingerprint);
      expect(signed.integrityStatus).toBe("fully-signed");
      expect(invoice.signatureCount).toBe(0);
    });

    it("replaces an existing signature from the same signer", async () => {
      const first = await createSignedInvoice({
        // Deterministic timestamp so the replacement still changes the JSON.
        signerKey: keyA,
      });

      const second = await first.sign(keyA, {
        timestamp: "2026-10-01T12:01:00.000Z",
      });

      expect(second.signatureCount).toBe(1);
      expect(second.signerIds).toEqual([keyA.fingerprint]);
      expect(second.integrity.signatures[0]).not.toEqual(
        first.integrity.signatures[0],
      );
    });

    it("rejects signing with a locked key", async () => {
      const invoice = await createInvoice();
      const lockedKey = {
        isLocked: true,
        hasSigningKeys: true,
        fingerprint: "locked",
      } as unknown as MajikKey;

      await expectReject(
        invoice.sign(lockedKey),
        MajikInvoiceKeyError,
        /locked/,
      );
    });

    it("rejects signing with a key without signing material", async () => {
      const invoice = await createInvoice();
      const noSigningKey = {
        isLocked: false,
        hasSigningKeys: false,
        fingerprint: "no-signing",
      } as unknown as MajikKey;

      await expectReject(
        invoice.sign(noSigningKey),
        MajikInvoiceKeyError,
        /no signing keys/,
      );
    });

    it("enforces an existing allowlist", async () => {
      const invoice = await createAllowlistedInvoice();

      await expectReject(
        invoice.sign(keyC),
        MajikInvoiceSignatureError,
        /not on the allowlist/,
      );
    });

    it("supports multi-signature completion", async () => {
      const invoice = await createAllowlistedInvoice();
      expect(invoice.isFullySigned).toBe(false);
      expect(invoice.pendingSigners.map((s) => s.signerId)).toEqual([
        keyB.fingerprint,
      ]);

      const countersigned = await invoice.sign(keyB);

      expect(countersigned.signatureCount).toBe(2);
      expect(countersigned.isFullySigned).toBe(true);
      expect(countersigned.integrityStatus).toBe("fully-signed");
      expect(countersigned.pendingSigners).toEqual([]);
    });

    it("supports signing without an explicit allowlist", async () => {
      const invoice = await createInvoice();
      const signed = await invoice.sign(keyB);

      expect(signed.isFullySigned).toBe(true);
      expect(signed.pendingSigners).toEqual([]);
    });
  });

  // ========================================================================
  // Signature verification
  // ========================================================================

  describe("Signature Verification", () => {
    it("verifies every attached signature", async () => {
      const invoice = await createAllowlistedInvoice();
      const signed = await invoice.sign(keyB);

      const results = await signed.verifySignatures();

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.valid)).toBe(true);
      expect(results.map((r) => r.signerId)).toEqual([
        keyA.fingerprint,
        keyB.fingerprint,
      ]);
    });

    it("verifies one specific signer", async () => {
      const invoice = await createSignedInvoice();
      const result = await invoice.verifySignature(keyA.fingerprint);

      expect(result.valid).toBe(true);
      expect(result.signerId).toBe(keyA.fingerprint);
    });

    it("rejects verification when there are no signatures", async () => {
      const invoice = await createInvoice();
      await expectReject(
        invoice.verifySignatures(),
        MajikInvoiceSignatureError,
        /No signatures/,
      );
    });

    it("rejects verification for an unknown signer", async () => {
      const invoice = await createSignedInvoice();
      await expectReject(
        invoice.verifySignature(keyB.fingerprint),
        MajikInvoiceSignatureError,
        /No signature from signer/,
      );
    });

    it("detects a tampered content hash", async () => {
      const original = await createSignedInvoice();
      const tamperedJSON = original.toJSON();
      tamperedJSON.integrity = {
        ...tamperedJSON.integrity,
        contentHash: "f".repeat(64),
      };

      const tampered = MajikInvoice.fromJSON(tamperedJSON);
      const results = await tampered.verifySignatures();

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(false);
    });
  });

  // ========================================================================
  // Sealing / allowlist security
  // ========================================================================

  describe("Sealing", () => {
    it("rejects sealing an unsigned invoice", async () => {
      const invoice = await createInvoice();
      await expectReject(
        invoice.seal(keyA),
        MajikInvoiceSignatureError,
        /unsigned invoice/,
      );
    });

    it("seals a signed invoice", async () => {
      const invoice = await createSignedInvoice();
      const sealed = await invoice.seal(keyA, {
        timestamp: "2026-10-01T12:05:00.000Z",
      });

      expect(sealed.isSealed).toBe(true);
      expect(sealed.integrityStatus).toBe("sealed");
      expect(sealed.integrity.sealInfo?.sealedBy).toBe(keyA.fingerprint);
      expect(sealed.integrity.sealInfo?.sealTimestamp).toBe(
        "2026-10-01T12:05:00.000Z",
      );
      expect(sealed.integrity.sealInfo?.sealHash).toMatch(/^[0-9a-f]+$/);
    });

    it("rejects sealing by a non-signer when no issuer allowlist exists", async () => {
      const invoice = await createSignedInvoice();
      await expectReject(
        invoice.seal(keyB),
        MajikInvoiceSealError,
        /has not signed this invoice/,
      );
    });

    it("allows only the allowlist issuer to seal", async () => {
      const invoice = await createAllowlistedInvoice();
      const signed = await invoice.sign(keyB);

      await expectReject(
        signed.seal(keyB),
        MajikInvoiceSealError,
        /Only the issuer/,
      );

      await expect(signed.seal(keyA)).resolves.toBeInstanceOf(MajikInvoice);
    });

    it("rejects sealing with a locked key", async () => {
      const invoice = await createSignedInvoice();
      const lockedKey = {
        isLocked: true,
        fingerprint: keyA.fingerprint,
      } as unknown as MajikKey;

      await expectReject(
        invoice.seal(lockedKey),
        MajikInvoiceKeyError,
        /locked/,
      );
    });

    it("rejects sealing an already sealed invoice", async () => {
      const sealed = await (await createSignedInvoice()).seal(keyA);

      await expectReject(
        sealed.seal(keyA),
        MajikInvoiceSealError,
        /already sealed/,
      );
    });

    it("rejects signing a sealed invoice", async () => {
      const sealed = await (await createSignedInvoice()).seal(keyA);
      await expectReject(
        sealed.sign(keyA),
        MajikInvoiceSealError,
        /Cannot sign a sealed invoice/,
      );
    });

    it("verifies a valid seal", async () => {
      const sealed = await (await createSignedInvoice()).seal(keyA);
      const result = await sealed.verifySeal();

      expect(result.valid).toBe(true);
      expect(result.sealedBy).toBe(keyA.fingerprint);
    });

    it("returns invalid for an unsealed invoice", async () => {
      const invoice = await createSignedInvoice();
      const result = await invoice.verifySeal();

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("Invoice is not sealed.");
    });

    it("detects tampering with sealInfo.sealHash", async () => {
      const sealed = await (await createSignedInvoice()).seal(keyA);
      const tampered = MajikInvoice.fromJSON({
        ...sealed.toJSON(),
        integrity: {
          ...sealed.integrity,
          sealInfo: {
            ...sealed.integrity.sealInfo!,
            sealHash: "0".repeat(128),
          },
        },
      });

      const result = await tampered.verifySeal();
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Seal hash mismatch");
    });
  });

  // ========================================================================
  // Capability checks / integrity status
  // ========================================================================

  describe("Capabilities & Integrity State", () => {
    it("canSign permits a valid signer on an unsigned invoice", async () => {
      const invoice = await createInvoice();
      expect(invoice.canSign(keyA)).toEqual({ permitted: true });
    });

    it("canSign rejects a locked key", async () => {
      const invoice = await createInvoice();
      const key = {
        isLocked: true,
        hasSigningKeys: true,
        fingerprint: "locked",
      } as unknown as MajikKey;

      const result = invoice.canSign(key);
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain("locked");
    });

    it("canSign rejects a key without signing keys", async () => {
      const invoice = await createInvoice();
      const key = {
        isLocked: false,
        hasSigningKeys: false,
        fingerprint: "bad",
      } as unknown as MajikKey;

      const result = invoice.canSign(key);
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain("no signing keys");
    });

    it("canSign rejects a non-allowlisted signer", async () => {
      const invoice = await createAllowlistedInvoice();
      const result = invoice.canSign(keyC);

      expect(result.permitted).toBe(false);
      expect(result.reason).toContain("not on the allowlist");
    });

    it("canSign rejects further signing after sealing", async () => {
      const sealed = await (await createSignedInvoice()).seal(keyA);
      const result = sealed.canSign(keyA);

      expect(result.permitted).toBe(false);
      expect(result.reason).toContain("sealed");
    });

    it("canSeal rejects an unsigned invoice", async () => {
      const invoice = await createInvoice();
      expect(invoice.canSeal(keyA)).toEqual({
        permitted: false,
        reason: "Invoice has no signatures to seal.",
      });
    });

    it("canSeal permits the signing key when no issuer allowlist exists", async () => {
      const invoice = await createSignedInvoice();
      expect(invoice.canSeal(keyA)).toEqual({ permitted: true });
    });

    it("canSeal rejects an unsigned/unknown sealer", async () => {
      const invoice = await createSignedInvoice();
      const result = invoice.canSeal(keyB);

      expect(result.permitted).toBe(false);
      expect(result.reason).toContain("has not signed this invoice");
    });

    it("reports invalid integrity for a malformed envelope", () => {
      const invoice = makeUnsafeInvoice({ id: "" });
      expect(invoice.integrityStatus).toBe("invalid");
      expect(invoice.validate().valid).toBe(false);
    });

    it("reports unsigned integrity correctly", async () => {
      expect((await createInvoice()).integrityStatus).toBe("unsigned");
    });

    it("reports partially-signed integrity correctly", async () => {
      const invoice = await createAllowlistedInvoice();
      expect(invoice.integrityStatus).toBe("partially-signed");
    });

    it("reports fully-signed integrity correctly", async () => {
      const invoice = await createAllowlistedInvoice();
      const signed = await invoice.sign(keyB);
      expect(signed.integrityStatus).toBe("fully-signed");
    });

    it("reports sealed integrity correctly", async () => {
      const invoice = await createSignedInvoice();
      const sealed = await invoice.seal(keyA);
      expect(sealed.integrityStatus).toBe("sealed");
    });

    it("produces expected display labels", async () => {
      const unsigned = await createInvoice();
      const signed = await createSignedInvoice();
      const sealed = await signed.seal(keyA);

      expect(unsigned.displayStatus).toBe("Unsigned");
      expect(signed.displayStatus).toBe("Fully Signed");
      expect(sealed.displayStatus).toBe("Sealed");
    });

    it("produces encrypted display labels", async () => {
      const encrypted = await createEncryptedInvoice();
      expect(encrypted.displayStatus).toBe("Fully Signed (Encrypted)");
    });

    it("tracks a completed allowlist", async () => {
      const invoice = await createAllowlistedInvoice();
      const completed = await invoice.sign(keyB);
      expect(completed.pendingSigners).toEqual([]);
      expect(completed.isFullySigned).toBe(true);
    });
  });

  // ========================================================================
  // Encryption / decryption
  // ========================================================================

  describe("Encryption & Decryption", () => {
    it("creates a valid encrypted payload", async () => {
      const invoice = await createEncryptedInvoice();
      expect(invoice.payload.kind).toBe("encrypted-and-signed");
      expect((invoice.payload as EncryptedPayload).envelopeString).toMatch(
        /^~\*\$MJKMSG:/,
      );
      expect((invoice.payload as EncryptedPayload).algorithm).toContain(
        "ML-KEM-768",
      );
      expect(
        (invoice.payload as EncryptedPayload).recipientFingerprints,
      ).toEqual([keyB.fingerprint]);
    });

    it("keeps public summary accessible while encrypted", async () => {
      const invoice = await createEncryptedInvoice({
        invoiceNumber: "INV-ENC-1",
      });

      expect(invoice.public.invoiceNumber).toBe("INV-ENC-1");
      expect(invoice.public.totalAmount).toBe(1_000);
      expect(invoice.summary).toBe(invoice.public);
    });

    it("does not expose the private invoice while locked", async () => {
      const invoice = await createEncryptedInvoice();
      expectThrow(
        () => invoice.invoice,
        MajikInvoiceError,
        /Invoice payload is encrypted/,
      );
    });

    it("returns null for locked payment getters", async () => {
      const invoice = await createEncryptedInvoice();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(invoice.totalPaid).toBeNull();
      expect(invoice.isFullyPaid).toBeNull();
      expect(invoice.paymentStatus).toBeNull();
      expect(invoice.payments).toBeNull();
      expect(warn).toHaveBeenCalled();
    });

    it("canDecrypt recognizes an authorized recipient by fingerprint", async () => {
      const invoice = await createEncryptedInvoice();
      expect(invoice.canDecrypt(keyB)).toBe(true);
    });

    it("canDecrypt rejects a non-recipient fingerprint", async () => {
      const invoice = await createEncryptedInvoice();
      expect(invoice.canDecrypt(keyC)).toBe(false);
    });

    it("signed-only invoices cannot be decrypted", async () => {
      const invoice = await createInvoice();
      expect(invoice.canDecrypt(keyB)).toBe(false);
      await expectReject(
        invoice.decrypt(keyB),
        MajikInvoiceError,
        /not encrypted/,
      );
    });

    it("decrypts an encrypted invoice for an authorized recipient", async () => {
      const encrypted = await createEncryptedInvoice();
      const result = await encrypted.decrypt(keyB);

      expect(result.invoice).toBeInstanceOf(GeneralInvoice);
      expect(result.invoice.id).toBe(encrypted.id);
      expect(result.invoice.totalAmount).toBe(1_000);
      expect(result.instance.hasDecryptedCache).toBe(true);
      expect(result.instance.decryptedInvoice).toBe(result.invoice);
      expect(result.instance.decryptedCache?.decryptedBy).toBe(
        keyB.fingerprint,
      );
      expect(result.instance.isLocked).toBe(false);
    });

    it("returns the same cached instance when the same key decrypts again", async () => {
      const encrypted = await createEncryptedInvoice();
      const first = await encrypted.decrypt(keyB);
      const second = await first.instance.decrypt(keyB);

      expect(second.instance).toBe(first.instance);
      expect(second.invoice).toBe(first.invoice);
    });

    it("wrong recipient keys fail decryption", async () => {
      const encrypted = await createEncryptedInvoice();

      await expectReject(encrypted.decrypt(keyC), MajikInvoiceEncryptionError);
    });

    it("rejects decryption with a locked key", async () => {
      const encrypted = await createEncryptedInvoice();
      const lockedKey = {
        isLocked: true,
        hasMlKem: true,
        fingerprint: keyB.fingerprint,
      } as unknown as MajikKey;

      await expectReject(
        encrypted.decrypt(lockedKey),
        MajikInvoiceKeyError,
        /locked/,
      );
    });

    it("rejects decryption with a key lacking ML-KEM", async () => {
      const encrypted = await createEncryptedInvoice();
      const noKem = {
        isLocked: false,
        hasMlKem: false,
        fingerprint: keyB.fingerprint,
      } as unknown as MajikKey;

      await expectReject(
        encrypted.decrypt(noKem),
        MajikInvoiceKeyError,
        /ML-KEM/,
      );
    });

    it("clearDecryptedCache returns an encrypted invoice to locked state", async () => {
      const encrypted = await createEncryptedInvoice();
      const decrypted = await encrypted.decrypt(keyB);

      decrypted.instance.clearDecryptedCache();

      expect(decrypted.instance.hasDecryptedCache).toBe(false);
      expect(decrypted.instance.isLocked).toBe(true);
      expect(decrypted.instance.decryptedInvoice).toBeUndefined();
    });

    it("secureLock clears encrypted runtime plaintext", async () => {
      const encrypted = await createEncryptedInvoice();
      const decrypted = await encrypted.decrypt(keyB);

      expect(decrypted.instance.hasDecryptedCache).toBe(true);
      expect(decrypted.instance.secureLock()).toBe(decrypted.instance);
      expect(decrypted.instance.hasDecryptedCache).toBe(false);
    });
  });

  // ========================================================================
  // Mode conversion
  // ========================================================================

  describe("Mode Conversion", () => {
    it("converts signed-only to encrypted-and-signed with toEncrypted()", async () => {
      const plain = await createSignedInvoice();
      const encrypted = await plain.toEncrypted(
        [makeRecipientForKey(keyB)],
        [keyB.publicKeyBase64],
      );

      expect(plain.mode).toBe("signed-only");
      expect(encrypted.mode).toBe("encrypted-and-signed");
      expect(encrypted.hash).toBe(plain.hash);
      expect(encrypted.signatureCount).toBe(plain.signatureCount);
      expect(encrypted.canDecrypt(keyB)).toBe(true);
    });

    it("rejects toEncrypted() when already encrypted", async () => {
      const encrypted = await createEncryptedInvoice();
      await expectReject(
        encrypted.toEncrypted([makeRecipientForKey(keyB)]),
        MajikInvoiceError,
        /already in 'encrypted-and-signed'/,
      );
    });

    it("requires dropSignatures when overriding the allowlist", async () => {
      const plain = await createAllowlistedInvoice();

      const jsonKeyA = keyA.toJSON();

      await expectReject(
        plain.toEncrypted(
          [makeRecipientForKey(keyB)],
          [keyB.publicKeyBase64],
          undefined,
          {
            expectedSigners: [
              {
                signerId: keyA.fingerprint,
                edPublicKey: jsonKeyA.edPublicKey!,
                mlDsaPublicKey: jsonKeyA.mlDsaPublicKey!,
              },
            ],
          },
        ),
        MajikInvoiceError,
        /requires dropSignatures: true/,
      );
    });

    it("dropSignatures clears signatures and sealing state during toEncrypted()", async () => {
      const sealed = await (await createSignedInvoice()).seal(keyA);
      const converted = await sealed.toEncrypted(
        [makeRecipientForKey(keyB)],
        [keyB.publicKeyBase64],
        undefined,
        { dropSignatures: true },
      );

      expect(converted.signatureCount).toBe(0);
      expect(converted.isSealed).toBe(false);
      expect(converted.integrity.sealInfo).toBeUndefined();
      expect(converted.integrityStatus).toBe("unsigned");
    });

    it("can sign immediately during toEncrypted()", async () => {
      const plain = await createInvoice();
      const converted = await plain.toEncrypted(
        [makeRecipientForKey(keyB)],
        [keyB.publicKeyBase64],
        keyA,
      );

      expect(converted.signatureCount).toBe(1);
      expect(converted.hasSigned(keyA)).toBe(true);
    });

    it("does not add a redundant replacement signature for an existing signer", async () => {
      const signed = await createSignedInvoice();
      const converted = await signed.toEncrypted(
        [makeRecipientForKey(keyB)],
        [keyB.publicKeyBase64],
        keyA,
      );

      expect(converted.signatureCount).toBe(1);
      expect(converted.integrity.signatures[0]).toEqual(
        signed.integrity.signatures[0],
      );
    });

    it("toSignedOnly() requires an encrypted source", async () => {
      const plain = await createInvoice();
      await expectReject(
        plain.toSignedOnly(keyB),
        MajikInvoiceError,
        /already in 'signed-only'/,
      );
    });

    it("converts encrypted-and-signed to signed-only", async () => {
      const encrypted = await createEncryptedInvoice();
      const converted = await encrypted.toSignedOnly(keyB);

      expect(converted.mode).toBe("signed-only");
      expect(converted.invoice.totalAmount).toBe(1_000);
      expect(converted.hash).toBe(encrypted.hash);
      expect(encrypted.hasDecryptedCache).toBe(false);
    });

    it("dropSignatures clears the signature set during toSignedOnly()", async () => {
      const encrypted = await createEncryptedInvoice();
      const converted = await encrypted.toSignedOnly(keyB, undefined, {
        dropSignatures: true,
      });

      expect(converted.signatureCount).toBe(0);
      expect(converted.isSealed).toBe(false);
    });

    it("toSignedOnly supports immediate signing", async () => {
      const encrypted = await createEncryptedInvoice();
      const converted = await encrypted.toSignedOnly(keyB, keyB);

      expect(converted.mode).toBe("signed-only");
      expect(converted.hasSigned(keyA)).toBe(true);
      expect(converted.hasSigned(keyB)).toBe(true);
    });

    it("setMode rejects a no-op target mode", async () => {
      const plain = await createInvoice();
      await expectReject(
        plain.setMode("signed-only"),
        MajikInvoiceError,
        /already in/,
      );
    });

    it("setMode requires encrypted recipients and routing keys", async () => {
      const plain = await createInvoice();

      await expectReject(
        plain.setMode("encrypted-and-signed", {
          recipientPublicKeys: [keyB.publicKeyBase64],
        }),
        MajikInvoiceKeyError,
        /recipients are required/,
      );

      await expectReject(
        plain.setMode("encrypted-and-signed", {
          recipients: [makeRecipientForKey(keyB)],
        }),
        MajikInvoiceKeyError,
        /recipientPublicKeys are required/,
      );
    });

    it("setMode converts to encrypted-and-signed when all prerequisites exist", async () => {
      const plain = await createInvoice();
      const encrypted = await plain.setMode("encrypted-and-signed", {
        recipients: [makeRecipientForKey(keyB)],
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      expect(encrypted.mode).toBe("encrypted-and-signed");
    });

    it("setMode converting to signed-only requires decryptKey", async () => {
      const encrypted = await createEncryptedInvoice();

      await expectReject(
        encrypted.setMode("signed-only"),
        MajikInvoiceKeyError,
        /decryptKey is required/,
      );
    });

    it("setMode converts encrypted to signed-only with decryptKey", async () => {
      const encrypted = await createEncryptedInvoice();
      const plain = await encrypted.setMode("signed-only", {
        decryptKey: keyB,
      });

      expect(plain.mode).toBe("signed-only");
    });

    it("encrypt() convenience wrapper converts a signed-only invoice", async () => {
      const plain = await createInvoice();

      // Contract regression test: encrypt() is documented as the convenience
      // wrapper for toEncrypted() and should not require callers to provide
      // an otherwise-unused recipientPublicKeys argument.
      const encrypted = await plain.encrypt([makeRecipientForKey(keyB)]);

      expect(encrypted.mode).toBe("encrypted-and-signed");
      expect(encrypted.canDecrypt(keyB)).toBe(true);
    });

    it("decrypt_mode() is the signed-only conversion counterpart", async () => {
      const encrypted = await createEncryptedInvoice();
      const plain = await encrypted.decrypt_mode(keyB);
      expect(plain.mode).toBe("signed-only");
    });
  });

  // ========================================================================
  // Reissue / recipient workflows
  // ========================================================================

  describe("Reissue & Recipient Workflows", () => {
    it("reissues a signed-only invoice after source changes", async () => {
      const original = await createSignedInvoice();
      const updatedGeneral = original.invoice.withInvoiceNumber("INV-002");

      const reissued = await original.reissue(updatedGeneral);

      expect(reissued.id).toBe(updatedGeneral.id);
      expect(reissued.public.invoiceNumber).toBe("INV-002");
      expect(reissued.hash).not.toBe(original.hash);
      expect(reissued.signatureCount).toBe(0);
      expect(reissued.isSealed).toBe(false);
    });

    it("reissues a signed-only invoice with immediate signing", async () => {
      const original = await createSignedInvoice();
      const updatedGeneral = original.invoice.withDueDate("2026-10-30");
      const reissued = await original.reissue(updatedGeneral, {
        signerKey: keyA,
      });

      expect(reissued.hash).not.toBe(original.hash);
      expect(reissued.signatureCount).toBe(1);
      expect(reissued.hasSigned(keyA)).toBe(true);
    });

    it("rejects encrypted reissue without recipients", async () => {
      const encrypted = await createEncryptedInvoice();
      const { invoice } = await encrypted.decrypt(keyB);
      const updated = invoice.withDueDate("2026-10-30");

      await expectReject(
        encrypted.reissue(updated),
        MajikInvoiceKeyError,
        /recipients are required/,
      );
    });

    it("rejects encrypted reissue without recipientPublicKeys", async () => {
      const encrypted = await createEncryptedInvoice();
      const { invoice } = await encrypted.decrypt(keyB);
      const updated = invoice.withDueDate("2026-10-30");

      await expectReject(
        encrypted.reissue(updated, {
          recipients: [makeRecipientForKey(keyB)],
        }),
        MajikInvoiceKeyError,
        /recipientPublicKeys are required/,
      );
    });

    it("successfully reissues an encrypted invoice", async () => {
      const encrypted = await createEncryptedInvoice();
      const { invoice } = await encrypted.decrypt(keyB);
      const updated = invoice.withDueDate("2026-10-30");

      const reissued = await encrypted.reissue(updated, {
        recipients: [makeRecipientForKey(keyB)],
        recipientPublicKeys: [keyB.publicKeyBase64],
        signerKey: keyA,
      });

      expect(reissued.mode).toBe("encrypted-and-signed");
      expect(reissued.hash).not.toBe(encrypted.hash);
      expect(reissued.isLocked).toBe(true);
      expect(reissued.signatureCount).toBe(1);
    });

    it("countersigns an allowlisted signed-only invoice", async () => {
      const original = await createAllowlistedInvoice();
      const updated = original.invoice.withNotes("Recipient reviewed");
      const countersigned = await original.countersign(updated, keyB);

      expect(countersigned.signatureCount).toBe(2);
      expect(countersigned.hasSigned(keyB)).toBe(true);
      expect(countersigned.hash).toBe(original.hash);
    });

    it("rejects countersign() on an encrypted invoice", async () => {
      const encrypted = await createEncryptedInvoice({
        expectedSigners: makeExpectedSigners(),
      });
      const { invoice } = await encrypted.decrypt(keyB);
      const updated = invoice.withNotes("Review");

      await expectReject(
        encrypted.countersign(updated, keyB),
        MajikInvoiceError,
        /requires a \"signed-only\" invoice/,
      );
    });

    it("rejects receive() on signed-only invoices", async () => {
      const signed = await createSignedInvoice();
      await expectReject(
        signed.receive(signed.invoice, {
          signerKey: keyB,
          recipients: [makeRecipientForKey(keyB)],
        }),
        MajikInvoiceError,
        /requires an \"encrypted-and-signed\" invoice/,
      );
    });

    it("rejects receive() without an allowlist", async () => {
      const encrypted = await createEncryptedInvoice();
      const { invoice } = await encrypted.decrypt(keyB);

      await expectReject(
        encrypted.receive(invoice.withNotes("Review"), {
          signerKey: keyB,
          recipients: [makeRecipientForKey(keyB)],
        }),
        MajikInvoiceSignatureError,
        /expectedSigners allowlist/,
      );
    });

    it("rejects recipient receive() when the key is the issuer", async () => {
      const encrypted = await createEncryptedInvoice({
        expectedSigners: makeExpectedSigners(),
      });
      const { invoice } = await encrypted.decrypt(keyB);

      await expectReject(
        encrypted.receive(invoice.withNotes("Review"), {
          signerKey: keyA,
          recipients: [makeRecipientForKey(keyB)],
        }),
        MajikInvoiceSignatureError,
        /issuer of this invoice/,
      );
    });

    it("rejects recipient receive() for an unauthorized signer", async () => {
      const encrypted = await createEncryptedInvoice({
        expectedSigners: makeExpectedSigners(),
      });
      const { invoice } = await encrypted.decrypt(keyB);

      await expectReject(
        encrypted.receive(invoice.withNotes("Review"), {
          signerKey: keyC,
          recipients: [makeRecipientForKey(keyB)],
        }),
        MajikInvoiceSignatureError,
        /not on the allowlist/,
      );
    });

    it("rejects recipient receive() for a mismatched invoice ID", async () => {
      const encrypted = await createEncryptedInvoice({
        expectedSigners: makeExpectedSigners(),
      });
      const { invoice } = await encrypted.decrypt(keyB);
      const mismatched = GeneralInvoice.create({
        ...makeBaseInput({ id: "different-id" }),
      });

      await expectReject(
        encrypted.receive(mismatched, {
          signerKey: keyB,
          recipients: [makeRecipientForKey(keyB)],
        }),
        MajikInvoiceError,
        /does not match/,
      );
    });

    it("rejects recipient receive() without re-encryption recipients", async () => {
      const encrypted = await createEncryptedInvoice({
        expectedSigners: makeExpectedSigners(),
      });
      const { invoice } = await encrypted.decrypt(keyB);

      await expectReject(
        encrypted.receive(invoice.withNotes("Review"), {
          signerKey: keyB,
          recipients: [],
        }),
        MajikInvoiceKeyError,
        /recipients are required/,
      );
    });

    it("successfully processes an encrypted recipient mutation for operational content", async () => {
      const encrypted = await createEncryptedInvoice({
        expectedSigners: makeExpectedSigners(),
      });
      const { invoice } = await encrypted.decrypt(keyB);
      const updated = invoice.withNotes("Recipient reviewed");

      const received = await encrypted.receive(updated, {
        signerKey: keyB,
        recipients: [makeRecipientForKey(keyB)],
      });

      expect(received.mode).toBe("encrypted-and-signed");
      expect(received.signatureCount).toBe(2);
      expect(received.hasSigned(keyB)).toBe(true);
      expect(received.hash).toBe(encrypted.hash);
    });
  });

  // ========================================================================
  // Restart / duplication
  // ========================================================================

  describe("Restart & Duplication", () => {
    it("restarts a signed-only invoice as draft", async () => {
      const original = await createSignedInvoice({
        dueDate: "2026-10-31",
      });
      const paid = original.addPayment(makePayment({ amount: 1_000 }));
      const restarted = await paid.restartInvoice();

      expect(restarted.status).toBe("draft");
      expect(restarted.payments).toEqual([]);
      expect(restarted.signatureCount).toBe(0);
      expect(restarted.isSealed).toBe(false);
      expect(restarted.hash).toBe(original.hash);
      expect(restarted.public.dueDate).toBe("2026-10-31");
    });

    it("requires decryptKey to restart an encrypted invoice", async () => {
      const encrypted = await createEncryptedInvoice();
      await expectReject(
        encrypted.restartInvoice(),
        MajikInvoiceError,
        /decryptKey is required/,
      );
    });

    it("restarts an encrypted invoice into signed-only mode", async () => {
      const encrypted = await createEncryptedInvoice();
      const restarted = await encrypted.restartInvoice(keyB);

      expect(restarted.mode).toBe("signed-only");
      expect(restarted.status).toBe("draft");
      expect(restarted.signatureCount).toBe(0);
      expect(restarted.payments).toEqual([]);
      expect(restarted.hash).toBe(encrypted.hash);
    });

    it("duplicates a signed-only invoice with a fresh ID", async () => {
      const original = await createSignedInvoice({
        invoiceNumber: "INV-2026-001",
      });
      const duplicate = await original.duplicate();

      expect(duplicate.id).not.toBe(original.id);
      expect(duplicate.mode).toBe("signed-only");
      expect(duplicate.status).toBe("draft");
      expect(duplicate.signatureCount).toBe(0);
      expect(duplicate.isSealed).toBe(false);
      expect(duplicate.payments).toEqual([]);
      expect(duplicate.public.invoiceNumber).toBe("INV-2026-002");
      expect(duplicate.public.totalAmount).toBe(original.public.totalAmount);
    });

    it("duplicates an invoice without an invoice number", async () => {
      const original = await createInvoice({ invoiceNumber: undefined });
      const duplicate = await original.duplicate();

      expect(duplicate.public.invoiceNumber).toBeUndefined();
      expect(duplicate.id).not.toBe(original.id);
    });

    it("duplicates an encrypted invoice with decrypt access", async () => {
      const encrypted = await createEncryptedInvoice({
        invoiceNumber: "INV-010",
      });
      const duplicate = await encrypted.duplicate(keyB);

      expect(duplicate.mode).toBe("signed-only");
      expect(duplicate.status).toBe("draft");
      expect(duplicate.signatureCount).toBe(0);
      expect(duplicate.public.totalAmount).toBe(encrypted.public.totalAmount);
      expect(duplicate.id).not.toBe(encrypted.id);
      expect(duplicate.public.invoiceNumber).toBe("INV-011");
    });

    it("rejects encrypted duplication without a decrypt key when locked", async () => {
      const encrypted = await createEncryptedInvoice();
      await expectReject(
        encrypted.duplicate(),
        MajikInvoiceError,
        /decryptKey is required/,
      );
    });
  });

  // ========================================================================
  // Structural validation
  // ========================================================================

  describe("validate()", () => {
    it("accepts a valid signed-only invoice", async () => {
      const invoice = await createInvoice();
      expect(invoice.validate()).toEqual({ valid: true, errors: [] });
    });

    it("accepts a valid encrypted invoice", async () => {
      const invoice = await createEncryptedInvoice();
      expect(invoice.validate()).toEqual({ valid: true, errors: [] });
    });

    it("rejects a missing ID", () => {
      const invoice = makeUnsafeInvoice({ id: "" });
      const result = invoice.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "id" })]),
      );
    });

    it("rejects an unsupported mode", () => {
      const invoice = makeUnsafeInvoice({ mode: "invalid-mode" });
      const result = invoice.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "mode" })]),
      );
    });

    it("rejects a missing public issuer name", () => {
      const invoice = makeUnsafeInvoice({
        public: {
          ...makeUnsafeInvoice().public,
          issuerName: " ",
        },
      });
      const result = invoice.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "public.issuerName" }),
        ]),
      );
    });

    it("rejects a missing public recipient name", () => {
      const invoice = makeUnsafeInvoice({
        public: {
          ...makeUnsafeInvoice().public,
          recipientName: "",
        },
      });
      const result = invoice.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "public.recipientName" }),
        ]),
      );
    });

    it("rejects a non-finite public total", () => {
      const invoice = makeUnsafeInvoice({
        public: {
          ...makeUnsafeInvoice().public,
          totalAmount: Number.NaN,
        },
      });

      const result = invoice.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "public.totalAmount" }),
        ]),
      );
    });

    it("rejects a missing payload", () => {
      const invoice = makeUnsafeInvoice({ payload: undefined });
      expect(invoice.validate().valid).toBe(false);
    });

    it("rejects a missing signed-only invoice payload", () => {
      const invoice = makeUnsafeInvoice({
        payload: { kind: "signed-only", invoice: undefined },
      });
      const result = invoice.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "payload.invoice" }),
        ]),
      );
    });

    it("rejects a missing encrypted envelope string", () => {
      const invoice = makeUnsafeInvoice({
        mode: "encrypted-and-signed",
        payload: {
          kind: "encrypted-and-signed",
          envelopeString: "",
          algorithm: "ML-KEM-768 + AES-256-GCM",
          recipientFingerprints: [keyB.fingerprint],
        },
      });

      const result = invoice.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "payload.envelopeString" }),
        ]),
      );
    });

    it("rejects an encrypted payload with no recipients", () => {
      const invoice = makeUnsafeInvoice({
        mode: "encrypted-and-signed",
        payload: {
          kind: "encrypted-and-signed",
          envelopeString: "~*$MJKMSG:foo",
          algorithm: "ML-KEM-768 + AES-256-GCM",
          recipientFingerprints: [],
        },
      });

      const result = invoice.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "payload.recipientFingerprints" }),
        ]),
      );
    });

    it("rejects a missing integrity content hash", () => {
      const invoice = makeUnsafeInvoice({
        integrity: {
          ...makeUnsafeInvoice().integrity,
          contentHash: "",
        },
      });
      expect(invoice.validate().valid).toBe(false);
    });

    it("rejects an unsupported hash algorithm", () => {
      const invoice = makeUnsafeInvoice({
        integrity: {
          ...makeUnsafeInvoice().integrity,
          hashAlgorithm: "SHA-512",
        },
      });
      const result = invoice.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "integrity.hashAlgorithm" }),
        ]),
      );
    });

    it("rejects a sealed invoice without sealInfo", () => {
      const invoice = makeUnsafeInvoice({
        integrity: {
          ...makeUnsafeInvoice().integrity,
          isSealed: true,
          sealInfo: undefined,
        },
      });

      const result = invoice.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "integrity.sealInfo" }),
        ]),
      );
    });

    it("rejects a mode/payload mismatch", () => {
      // Contract regression: mode should agree with payload kind.
      const invoice = makeUnsafeInvoice({
        mode: "encrypted-and-signed",
        payload: {
          kind: "signed-only",
          invoice: {},
        },
      });

      expect(invoice.validate().valid).toBe(false);
    });

    it("rejects an unknown payload kind", () => {
      // Contract regression: payload discriminants should be closed.
      const invoice = makeUnsafeInvoice({
        payload: {
          kind: "unknown",
        },
      });

      expect(invoice.validate().valid).toBe(false);
    });
  });

  // ========================================================================
  // JSON serialization / parsing
  // ========================================================================

  describe("JSON Serialization", () => {
    it("serializes to a JSON-safe object", async () => {
      const invoice = await createInvoice();
      const json = invoice.toJSON();

      expect(json.version).toBeDefined();
      expect(json.id).toBe(invoice.id);
      expect(json.mode).toBe(invoice.mode);
      expect(json.public).toEqual(invoice.public);
      expect(json.payload).toEqual(invoice.payload);
      expect(json.integrity).toEqual(invoice.integrity);
    });

    it("includes recipients as an array", async () => {
      const invoice = await createInvoice({
        recipientPublicKeys: [keyB.publicKeyBase64],
      });
      expect(invoice.toJSON().recipients).toEqual([keyB.publicKeyBase64]);
    });

    it("uses an empty recipient array when none is configured", async () => {
      const invoice = await createInvoice();
      expect(invoice.toJSON().recipients).toEqual([]);
    });

    it("round-trips a signed-only invoice", async () => {
      const original = await createSignedInvoice({
        userId: "user-1",
        accountId: "acct-1",
      });
      const restored = MajikInvoice.fromJSON(original.toJSON());

      expect(restored).toBeInstanceOf(MajikInvoice);
      expect(restored.toJSON()).toEqual(original.toJSON());
      expect(restored.id).toBe(original.id);
      expect(restored.hash).toBe(original.hash);
      expect(restored.signatureCount).toBe(original.signatureCount);
    });

    it("round-trips encrypted invoice shell state", async () => {
      const original = await createEncryptedInvoice({
        recipientPublicKeys: [keyB.publicKeyBase64],
      });
      const restored = MajikInvoice.fromJSON(original.toJSON());

      expect(restored.mode).toBe("encrypted-and-signed");
      expect(restored.payload).toEqual(original.payload);
      expect(restored.integrity).toEqual(original.integrity);
      expect(restored.isLocked).toBe(true);
    });

    it("does not persist decrypted runtime cache", async () => {
      const encrypted = await createEncryptedInvoice();
      const decrypted = await encrypted.decrypt(keyB);
      const json = decrypted.instance.toJSON() as unknown as Record<
        string,
        unknown
      >;

      expect(decrypted.instance.hasDecryptedCache).toBe(true);
      expect(json).not.toHaveProperty("decrypted");
    });

    it("supports JSON string input to fromJSON", async () => {
      const original = await createInvoice();
      const restored = MajikInvoice.fromJSON(original.toString());

      expect(restored.toJSON()).toEqual(original.toJSON());
    });

    it("rejects malformed JSON strings", async () => {
      expectThrow(
        () => MajikInvoice.fromJSON("{bad-json"),
        MajikInvoiceSerializationError,
        /Failed to deserialize/,
      );
    });

    it("rejects missing required top-level JSON fields", async () => {
      const original = await createInvoice();
      const json = original.toJSON();
      delete (json as Partial<MajikInvoiceJSON>).payload;

      expectThrow(
        () => MajikInvoice.fromJSON(json),
        MajikInvoiceSerializationError,
        /missing required fields/,
      );
    });

    it("rejects invalid structural data during fromJSON", async () => {
      const original = await createInvoice();
      const json = original.toJSON();
      json.public = {
        ...json.public,
        issuerName: "",
      };

      expectThrow(
        () => MajikInvoice.fromJSON(json),
        MajikInvoiceSerializationError,
        /failed validation/i,
      );
    });

    it("rejects an invalid mode fromJSON", async () => {
      const json = (await createInvoice()).toJSON();
      const invalid = {
        ...json,
        mode: "invalid-mode",
      } as never;

      expectThrow(
        () => MajikInvoice.fromJSON(invalid),
        MajikInvoiceSerializationError,
      );
    });

    it("accepts a cloud-routing JSON object", async () => {
      const original = await createEncryptedInvoice({
        userId: "user-1",
        accountId: "acct-1",
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      const cloud = original.toMajikahInvoiceJSON(keyA.publicKeyBase64);
      const restored = MajikInvoice.fromJSON(cloud);

      expect(restored.userId).toBe("user-1");
      expect(restored.accountId).toBe("acct-1");
      expect(restored.sentAt).toBe(cloud.sent_at);
      expect(restored.id).toBe(original.id);
    });

    it("preserves the schema version during serialization", async () => {
      const invoice = await createInvoice();
      expect(invoice.toJSON().version).toBe(invoice.version);
    });

    it("toString(false) returns compact JSON", async () => {
      const invoice = await createInvoice();
      const text = invoice.toString(false);

      expect(text).toBe(JSON.stringify(invoice.toJSON(), null, 0));
      expect(text.includes("\n")).toBe(false);
    });

    it("toString(true) returns pretty JSON", async () => {
      const invoice = await createInvoice();
      const text = invoice.toString(true);

      expect(text).toContain("\n");
      expect(JSON.parse(text)).toEqual(invoice.toJSON());
    });
  });

  // ========================================================================
  // Cloud JSON
  // ========================================================================

  describe("toMajikahInvoiceJSON()", () => {
    it("serializes an encrypted invoice for cloud routing", async () => {
      const invoice = await createEncryptedInvoice({
        userId: "user-1",
        accountId: "acct-1",
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      const cloud = invoice.toMajikahInvoiceJSON(keyA.publicKeyBase64);

      expect(cloud.user_id).toBe("user-1");
      expect(cloud.account_id).toBe("acct-1");
      expect(cloud.recipients).toEqual([keyB.publicKeyBase64]);
      expect(cloud.public_key).toBe(keyA.publicKeyBase64);
      expect(cloud.sent_at).toBe(FIXED_NOW);
      expect(cloud.status).toBe(invoice.public.status);
    });

    it("falls back accountId to userId", async () => {
      const invoice = await createEncryptedInvoice({
        userId: "user-1",
        accountId: undefined,
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      const cloud = invoice.toMajikahInvoiceJSON(keyA.publicKeyBase64);
      expect(cloud.account_id).toBe("user-1");
    });

    it("allows routing overrides", async () => {
      const invoice = await createEncryptedInvoice({
        userId: "original-user",
        accountId: "original-account",
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      const cloud = invoice.toMajikahInvoiceJSON(keyA.publicKeyBase64, {
        userId: "override-user",
        accountId: "override-account",
        recipients: [keyC.publicKeyBase64],
      });

      expect(cloud.user_id).toBe("override-user");
      expect(cloud.account_id).toBe("override-account");
      expect(cloud.recipients).toEqual([keyC.publicKeyBase64]);
    });

    it("requires userId", async () => {
      const invoice = await createEncryptedInvoice({
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      expectThrow(
        () => invoice.toMajikahInvoiceJSON(keyA.publicKeyBase64),
        MajikInvoiceError,
        /userId is required/,
      );
    });

    it("requires recipients", async () => {
      const invoice = await createEncryptedInvoice({
        userId: "user-1",
        recipientPublicKeys: undefined,
      });

      expectThrow(
        () => invoice.toMajikahInvoiceJSON(keyA.publicKeyBase64),
        MajikInvoiceError,
        /At least 1 recipient/,
      );
    });

    it("requires a sender public key", async () => {
      const invoice = await createEncryptedInvoice({
        userId: "user-1",
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      expectThrow(
        () => invoice.toMajikahInvoiceJSON("" as never),
        MajikInvoiceError,
        /Sender Public Key is required/,
      );
    });

    it("requires encrypted mode unless forceSignedOnly is set", async () => {
      const invoice = await createInvoice({
        userId: "user-1",
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      expectThrow(
        () => invoice.toMajikahInvoiceJSON(keyA.publicKeyBase64),
        MajikInvoiceError,
        /encrypted invoice is required/,
      );
    });

    it("allows signed-only cloud serialization when forceSignedOnly is true", async () => {
      const invoice = await createInvoice({
        userId: "user-1",
      });

      const cloud = invoice.toMajikahInvoiceJSON(keyA.publicKeyBase64, {
        recipients: [keyB.publicKeyBase64],
        forceSignedOnly: true,
      });

      expect(cloud.mode).toBe("signed-only");
      expect(cloud.user_id).toBe("user-1");
    });

    it("locks encrypted runtime plaintext before serialization", async () => {
      const encrypted = await createEncryptedInvoice({
        userId: "user-1",
        recipientPublicKeys: [keyB.publicKeyBase64],
      });

      const decrypted = await encrypted.decrypt(keyB);
      expect(decrypted.instance.hasDecryptedCache).toBe(true);

      decrypted.instance.toMajikahInvoiceJSON(keyA.publicKeyBase64);
      expect(decrypted.instance.hasDecryptedCache).toBe(false);
    });
  });

  // ========================================================================
  // Binary
  // ========================================================================

  describe("Binary Serialization", () => {
    it("creates an MJKI binary envelope", async () => {
      const invoice = await createInvoice();
      const binary = invoice.toBinary();
      const bytes = new Uint8Array(binary);

      expect(binary).toBeInstanceOf(ArrayBuffer);
      expect(bytes.length).toBeGreaterThan(MJKI_HEADER_SIZE);
      expect([...bytes.slice(0, 4)]).toEqual([...MJKI_MAGIC]);
      expect(bytes[4]).toBe(MJKI_VERSION);
      expect(bytes[5]).toBe(0);
    });

    it("sets the encrypted flag for encrypted invoices", async () => {
      const invoice = await createEncryptedInvoice();
      const bytes = new Uint8Array(invoice.toBinary());

      expect(bytes[4]).toBe(MJKI_VERSION);
      expect(bytes[5]).toBe(1);
    });

    it("writes the JSON payload length as big-endian uint32", async () => {
      const invoice = await createInvoice();
      const binary = invoice.toBinary();
      const bytes = new Uint8Array(binary);
      const view = new DataView(binary);
      const declaredLength = view.getUint32(8, false);

      expect(declaredLength).toBe(bytes.length - MJKI_HEADER_SIZE);
    });

    it("round-trips signed-only invoices through binary serialization", async () => {
      const original = await createSignedInvoice();
      const restored = MajikInvoice.fromBinary(original.toBinary());

      expect(restored.toJSON()).toEqual(original.toJSON());
      expect(restored.hash).toBe(original.hash);
    });

    it("round-trips encrypted invoice shells through binary serialization", async () => {
      const original = await createEncryptedInvoice();
      const restored = MajikInvoice.fromBinary(original.toBinary());

      expect(restored.mode).toBe("encrypted-and-signed");
      expect(restored.payload).toEqual(original.payload);
      expect(restored.integrity).toEqual(original.integrity);
      expect(restored.isLocked).toBe(true);
    });

    it("rejects a binary that is too small", () => {
      expectThrow(
        () => MajikInvoice.fromBinary(new ArrayBuffer(MJKI_HEADER_SIZE - 1)),
        MajikInvoiceSerializationError,
        /Binary too small/,
      );
    });

    it("rejects an invalid magic number", async () => {
      const binary = (await createInvoice()).toBinary();
      const bytes = new Uint8Array(binary);
      bytes[0] ^= 0xff;

      expectThrow(
        () => MajikInvoice.fromBinary(bytes.buffer),
        MajikInvoiceSerializationError,
        /Invalid magic number/,
      );
    });

    it("rejects an unsupported binary version", async () => {
      const binary = (await createInvoice()).toBinary();
      const bytes = new Uint8Array(binary);
      bytes[4] = MJKI_VERSION + 1;

      expectThrow(
        () => MajikInvoice.fromBinary(bytes.buffer),
        MajikInvoiceSerializationError,
        /Unsupported MJKI version/,
      );
    });

    it("rejects a truncated binary payload", async () => {
      const binary = (await createInvoice()).toBinary();
      const view = new DataView(binary);
      const declaredLength = view.getUint32(8, false);
      const expectedSize = MJKI_HEADER_SIZE + declaredLength;
      const truncated = binary.slice(0, expectedSize - 1);

      expectThrow(
        () => MajikInvoice.fromBinary(truncated),
        MajikInvoiceSerializationError,
        /Truncated MJKI payload/,
      );
    });

    it("rejects invalid JSON embedded in the binary payload", async () => {
      const binary = (await createInvoice()).toBinary();
      const bytes = new Uint8Array(binary);
      const view = new DataView(binary);
      const badJson = new TextEncoder().encode("{");

      // Rewrite declared length to match the invalid payload and overwrite it.
      view.setUint32(8, badJson.length, false);
      bytes.set(badJson, MJKI_HEADER_SIZE);
      const trimmed = bytes.slice(0, MJKI_HEADER_SIZE + badJson.length);

      expectThrow(
        () => MajikInvoice.fromBinary(trimmed.buffer),
        MajikInvoiceSerializationError,
      );
    });
  });

  // ========================================================================
  // CSV
  // ========================================================================

  describe("CSV Export", () => {
    it("exports multiple signed-only invoices", async () => {
      const a = await createInvoice({ id: "a", invoiceNumber: "INV-A" });
      const b = await createInvoice({ id: "b", invoiceNumber: "INV-B" });

      const result = await MajikInvoice.batchExportToCSV([a, b]);

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.partialExports).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.csv.split("\n")).toHaveLength(3);
      expect(result.csv).toContain("INV-A");
      expect(result.csv).toContain("INV-B");
    });

    it("emits a header for an empty collection", async () => {
      const result = await MajikInvoice.batchExportToCSV([]);

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.csv.split("\n")).toHaveLength(1);
      expect(result.csv).toBe(
        DEFAULT_CSV_COLUMNS.map((column) => column.label).join(","),
      );
    });

    it("deduplicates duplicate invoice IDs before exporting", async () => {
      const first = await createInvoice({ id: "dup", invoiceNumber: "INV-1" });
      const second = await createInvoice({ id: "dup", invoiceNumber: "INV-2" });

      const result = await MajikInvoice.batchExportToCSV([first, second]);

      // count intentionally reflects original input length in the implementation
      // while the actual rows are built from deduplicated invoices.
      expect(result.count).toBe(2);
      expect(result.csv).toContain("INV-1");
      expect(result.csv).not.toContain("INV-2");
    });

    it("deduplicates duplicate CSV columns", async () => {
      const invoice = await createInvoice();
      const columns = [...DEFAULT_CSV_COLUMNS, ...DEFAULT_CSV_COLUMNS];

      const result = await MajikInvoice.batchExportToCSV([invoice], {
        columns,
      });

      expect(result.success).toBe(true);
      expect(result.csv.split("\n")).toHaveLength(2);
    });

    it("exports an encrypted invoice partially while locked", async () => {
      const encrypted = await createEncryptedInvoice();
      const result = await MajikInvoice.batchExportToCSV([encrypted]);

      expect(result.success).toBe(false);
      expect(result.partialExports).toHaveLength(1);
      expect(result.partialExports[0].invoiceId).toBe(encrypted.id);
      expect(result.partialExports[0].reason).toBe("encrypted-no-cache");
      expect(result.csv).toContain(encrypted.public.issuerName);
    });

    it("exports an encrypted invoice fully when decryptKey is supplied", async () => {
      const encrypted = await createEncryptedInvoice({
        invoiceNumber: "INV-ENC",
      });
      const result = await MajikInvoice.batchExportToCSV([encrypted], {
        decryptKey: keyB,
      });

      expect(result.success).toBe(true);
      expect(result.partialExports).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.csv).toContain("INV-ENC");
    });

    it("keeps inaccessible encrypted invoices as partial exports with the wrong key", async () => {
      const encrypted = await createEncryptedInvoice();
      const result = await MajikInvoice.batchExportToCSV([encrypted], {
        decryptKey: keyC,
      });

      expect(result.success).toBe(false);
      expect(result.partialExports[0].invoiceId).toBe(encrypted.id);
      expect(result.partialExports[0].reason).toBe("encrypted-no-cache");
    });

    it("supports a custom CSV column set", async () => {
      const invoice = await createInvoice({
        invoiceNumber: "INV-CUSTOM",
      });

      const customColumn: CSVColumn = {
        key: "custom-id",
        label: "Custom ID",
        group: "identity",
        resolve: ({ invoiceId }) => invoiceId,
      };

      const result = await MajikInvoice.batchExportToCSV([invoice], {
        columns: [customColumn],
      });

      expect(result.success).toBe(true);
      expect(result.csv).toContain("Custom ID");
      expect(result.csv).toContain(invoice.id);
    });
  });

  // ========================================================================
  // Dashboard statistics
  // ========================================================================

  describe("computeDashboardStats()", () => {
    it("returns zeros for an empty collection", () => {
      const stats = MajikInvoice.computeDashboardStats([]);

      expect(stats.total).toBe(0);
      expect(stats.totalAmount).toBe(0);
      expect(stats.paidCount).toBe(0);
      expect(stats.partialCount).toBe(0);
      expect(stats.overdueCount).toBe(0);
      expect(stats.avgInvoiceValue).toBe(0);
      expect(stats.largestInvoice).toBe(0);
      expect(stats.smallestInvoice).toBe(0);
      expect(stats.medianInvoiceValue).toBe(0);
      expect(stats.avgDaysToPayment).toBeNull();
      expect(stats.oldestInvoiceDate).toBeNull();
      expect(stats.newestInvoiceDate).toBeNull();
      expect(stats.dueSoonCount).toBe(0);
    });

    it("aggregates counts by lifecycle status", async () => {
      const draft = await createInvoice({
        id: "draft",
        lineItems: [{ id: "1", description: "A", quantity: 1, unitPrice: 100 }],
      });

      const prepaid = await createInvoice({
        id: "paid",
        lineItems: [{ id: "2", description: "B", quantity: 1, unitPrice: 200 }],
      });

      const midpaid = await prepaid.reissue(prepaid.invoice.issue());

      const paid = midpaid.addPayment(
        makePayment({ id: "paid-p", amount: 200 }),
      );

      const prepartial = await createInvoice({
        id: "partial",
        lineItems: [{ id: "3", description: "C", quantity: 1, unitPrice: 300 }],
      });

      const midpartial = await prepartial.reissue(prepartial.invoice.issue());

      const partial = midpartial.addPayment(
        makePayment({ id: "partial-p", amount: 100 }),
      );

      const preoverdue = await createInvoice({
        id: "overdue",
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
        lineItems: [{ id: "4", description: "D", quantity: 1, unitPrice: 400 }],
      });

      const overdue = await preoverdue.reissue(preoverdue.invoice.issue());

      const prevoid = await createInvoice({
        id: "void",
        lineItems: [{ id: "5", description: "E", quantity: 1, unitPrice: 50 }],
      });

      const voided = await prevoid.reissue(prevoid.invoice.voidInvoice());

      const dueSoon = await createInvoice({
        id: "due-soon",
        dueDate: "2026-10-05",
        lineItems: [{ id: "6", description: "F", quantity: 1, unitPrice: 600 }],
      });

      const stats = MajikInvoice.computeDashboardStats([
        draft,
        paid,
        partial,
        overdue,
        voided,
        dueSoon,
      ]);

      expect(stats.total).toBe(6);
      expect(stats.paidCount).toBe(1);
      expect(stats.partialCount).toBe(1);
      expect(stats.overdueCount).toBe(1);
      expect(stats.draftCount).toBe(2);
      expect(stats.voidCount).toBe(1);
      expect(stats.totalAmount).toBe(1_650);
      expect(stats.paidAmount).toBe(200);
      expect(stats.partialAmount).toBe(300);
      expect(stats.overdueAmount).toBe(400);
      expect(stats.unpaidAmount).toBe(1_150);
      expect(stats.totalCollected).toBe(300);
      expect(stats.totalOutstanding).toBe(1_350);
      expect(stats.avgInvoiceValue).toBe(275);
      expect(stats.largestInvoice).toBe(600);
      expect(stats.smallestInvoice).toBe(50);
      expect(stats.medianInvoiceValue).toBe(250);
      expect(stats.dueSoonCount).toBe(1);
      expect(stats.oldestInvoiceDate).toBe("2026-09-01");
      expect(stats.newestInvoiceDate).toBe(FIXED_TODAY);
      expect(stats.byStatus).toEqual({
        draft: 2,
        paid: 1,
        partial: 1,
        overdue: 1,
        void: 1,
      });
    });

    it("includes accessible tax, withholding, discount and net-payable totals", async () => {
      const a = await createInvoice({
        id: "tax-a",
        lineItems: [
          {
            id: "a",
            description: "A",
            quantity: 1,
            unitPrice: 1_000,
            taxes: [{ taxType: "VAT", rate: 0.1, behaviour: "additive" }],
          },
        ],
      });

      const b = await createInvoice({
        id: "tax-b",
        lineItems: [
          {
            id: "b",
            description: "B",
            quantity: 1,
            unitPrice: 2_000,
            taxes: [
              { taxType: "VAT", rate: 0.2, behaviour: "additive" },
              { taxType: "EWT", rate: 0.05, behaviour: "withholding" },
            ],
            discount: { type: "fixed", value: 100 },
          },
        ],
      });

      const stats = MajikInvoice.computeDashboardStats([a, b]);

      expect(stats.taxCollected).toBe(480);
      expect(stats.withholdingTotal).toBe(95);
      expect(stats.netPayable).toBe(3_285);
      expect(stats.discountGiven).toBe(100);
      expect(stats.effectiveTaxRate).toBeCloseTo(480 / 3_000, 10);
      expect(stats.taxBreakdown).toHaveLength(1);
      expect(stats.taxBreakdown[0]).toEqual(
        expect.objectContaining({
          taxType: "VAT",
          amount: 480,
        }),
      );
      expect(stats.taxBreakdown[0].rate).toBeCloseTo(0.15, 10);
    });

    it("calculates average days to first payment", async () => {
      const prepaid = await createInvoice({
        issueDate: "2026-09-20",
        lineItems: [
          { id: "p", description: "Paid", quantity: 1, unitPrice: 1_000 },
        ],
      });

      const midpaid = await prepaid.reissue(prepaid.invoice.issue());

      const paid = midpaid.addPayment(
        makePayment({
          id: "payment",
          amount: 1_000,
          settledAt: "2026-09-22T12:00:00.000Z",
        }),
      );

      const stats = MajikInvoice.computeDashboardStats([paid]);
      expect(stats.avgDaysToPayment).toBeCloseTo(2.5, 10);
    });

    it("sorts top recipients by total amount", async () => {
      const a = await createInvoice({
        id: "r1",
        recipient: makeRecipient({ legalName: "Small Client" }),
        lineItems: [{ id: "1", description: "A", quantity: 1, unitPrice: 100 }],
      });
      const b = await createInvoice({
        id: "r2",
        recipient: makeRecipient({ legalName: "Large Client" }),
        lineItems: [
          { id: "2", description: "B", quantity: 1, unitPrice: 1_000 },
        ],
      });

      const stats = MajikInvoice.computeDashboardStats([a, b]);

      expect(stats.topRecipients[0]).toEqual(
        expect.objectContaining({ name: "Large Client", totalAmount: 1_000 }),
      );
      expect(stats.uniqueRecipientCount).toBe(2);
      expect(stats.uniqueIssuerCount).toBe(1);
    });

    it("counts locked encrypted invoices while still using public summary metrics", async () => {
      const encrypted = await createEncryptedInvoice({
        id: "encrypted",
        lineItems: [
          { id: "1", description: "Secret", quantity: 1, unitPrice: 750 },
        ],
      });

      const stats = MajikInvoice.computeDashboardStats([encrypted]);

      expect(stats.total).toBe(1);
      expect(stats.totalAmount).toBe(750);
      expect(stats.encryptedCount).toBe(1);
      expect(stats.totalCollected).toBe(0);
      expect(stats.netPayable).toBe(0);
    });

    it("uses detailed status after an encrypted invoice has been decrypted", async () => {
      const encrypted = await createEncryptedInvoice({
        id: "enc-paid",
        lineItems: [
          { id: "1", description: "Secret", quantity: 1, unitPrice: 1_000 },
        ],
      });

      const { instance } = await encrypted.decrypt(keyB);
      // Encrypted payment mutation is intentionally unsupported by the current
      // reissue pipeline, so this test verifies public/detailed availability
      // rather than attempting a financial mutation.
      const stats = MajikInvoice.computeDashboardStats([instance]);

      expect(stats.encryptedCount).toBe(0);
      expect(stats.totalAmount).toBe(1_000);
      expect(stats.totalOutstanding).toBe(1_000);
    });
  });

  // ========================================================================
  // Batch decryption / lock
  // ========================================================================

  describe("Batch Decryption & Locking", () => {
    it("passes signed-only invoices through batchDecrypt", async () => {
      const plain = await createInvoice({ id: "plain" });
      const result = await MajikInvoice.batchDecrypt([plain], keyB);

      expect(result.success).toBe(true);
      expect(result.decrypted).toEqual([plain]);
      expect(result.errors).toEqual([]);
    });

    it("decrypts authorized encrypted invoices and collects unauthorized failures", async () => {
      const plain = await createInvoice({ id: "plain" });
      const forB = await createEncryptedInvoice({ id: "for-b" });
      const forC = await createEncryptedInvoice({
        id: "for-c",
        recipients: [makeRecipientForKey(keyC)],
        recipientPublicKeys: [keyC.publicKeyBase64],
      });

      const result = await MajikInvoice.batchDecrypt([plain, forB, forC], keyB);

      expect(result.success).toBe(false);
      expect(result.decrypted).toHaveLength(2);
      expect(result.decrypted.map((x) => x.id)).toEqual(["plain", "for-b"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].invoiceId).toBe("for-c");
    });

    it("uses an existing decrypted cache without re-decrypting", async () => {
      const encrypted = await createEncryptedInvoice();
      const decrypted = await encrypted.decrypt(keyB);

      const result = await MajikInvoice.batchDecrypt(
        [decrypted.instance],
        keyC,
      );

      expect(result.success).toBe(true);
      expect(result.decrypted[0]).toBe(decrypted.instance);
      expect(result.errors).toEqual([]);
    });

    it("returns successful empty batch results", async () => {
      const result = await MajikInvoice.batchDecrypt([], keyB);
      expect(result).toEqual({ success: true, decrypted: [], errors: [] });
    });

    it("batchLock locks encrypted invoices and skips signed-only ones", async () => {
      const plain = await createInvoice();
      const encrypted = await createEncryptedInvoice();
      const decrypted = await encrypted.decrypt(keyB);

      const result = MajikInvoice.batchLock([plain, decrypted.instance]);

      expect(result).toEqual({ locked: 1, skipped: 1 });
      expect(plain.isLocked).toBe(false);
      expect(decrypted.instance.isLocked).toBe(true);
    });

    it("batchLock is safe on an already locked encrypted invoice", async () => {
      const encrypted = await createEncryptedInvoice();
      const result = MajikInvoice.batchLock([encrypted]);

      expect(result).toEqual({ locked: 1, skipped: 0 });
      expect(encrypted.isLocked).toBe(true);
    });

    it("batchLock handles an empty collection", () => {
      expect(MajikInvoice.batchLock([])).toEqual({ locked: 0, skipped: 0 });
    });
  });

  // ========================================================================
  // Automatic overdue marking
  // ========================================================================

  describe("autoMarkOverdue()", () => {
    it("skips invoices whose due date has not passed", async () => {
      const invoice = await createInvoice({
        dueDate: "2026-10-02",
      });

      const result = await MajikInvoice.autoMarkOverdue([invoice]);

      expect(result.marked).toEqual([]);
      expect(result.skipped).toEqual([
        { invoiceId: invoice.id, reason: "not-overdue" },
      ]);
    });

    it("skips invoices due today", async () => {
      const invoice = await createInvoice({ dueDate: FIXED_TODAY });
      const result = await MajikInvoice.autoMarkOverdue([invoice]);

      expect(result.marked).toEqual([]);
      expect(result.skipped).toEqual([
        { invoiceId: invoice.id, reason: "not-overdue" },
      ]);
    });

    it("marks a signed-only overdue invoice", async () => {
      // Contract regression test. The documented method promises to transition
      // genuinely overdue invoices. This exposes an inconsistency if the
      // GeneralInvoice transition table does not include "overdue".
      const preissue = await createInvoice({
        id: "overdue-positive",
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
      });

      const invoice = await preissue.reissue(preissue.invoice.issue());

      const result = await MajikInvoice.autoMarkOverdue([invoice]);

      expect(result.marked).toHaveLength(1);
      expect(result.marked[0].status).toBe("overdue");
      expect(result.marked[0].hash).toBe(invoice.hash);
    });

    it("reports wrong-status for a due invoice whose lifecycle cannot transition", async () => {
      const prevoid = await createInvoice({
        id: "wrong-status",
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
      });
      const invoice = await prevoid.reissue(prevoid.invoice.voidInvoice());

      const result = await MajikInvoice.autoMarkOverdue([invoice]);

      expect(result.marked).toEqual([]);
      expect(result.skipped).toEqual([
        { invoiceId: invoice.id, reason: "wrong-status" },
      ]);
    });

    it("skips locked encrypted invoices when no decrypt key is provided", async () => {
      const invoice = await createEncryptedInvoice({
        dueDate: "2026-09-30",
        issueDate: "2026-09-01",
      });

      const result = await MajikInvoice.autoMarkOverdue([invoice]);

      expect(result.marked).toEqual([]);
      expect(result.skipped).toEqual([
        { invoiceId: invoice.id, reason: "encrypted" },
      ]);
    });

    it("strict mode rejects an encrypted invoice without a decrypt key", async () => {
      const invoice = await createEncryptedInvoice({
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
      });

      await expectReject(
        MajikInvoice.autoMarkOverdue([invoice], { strict: true }),
        MajikInvoiceError,
        /encrypted and no decryptKey/,
      );
    });

    it("skips encrypted invoices when decryptKey is unauthorized in non-strict mode", async () => {
      const invoice = await createEncryptedInvoice({
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
      });

      const result = await MajikInvoice.autoMarkOverdue([invoice], {
        decryptKey: keyC,
      });

      expect(result.marked).toEqual([]);
      expect(result.skipped).toEqual([
        { invoiceId: invoice.id, reason: "encrypted" },
      ]);
    });

    it("strict mode rejects an unauthorized decrypt key", async () => {
      const invoice = await createEncryptedInvoice({
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
      });

      await expectReject(
        MajikInvoice.autoMarkOverdue([invoice], {
          decryptKey: keyC,
          strict: true,
        }),
        MajikInvoiceKeyError,
        /not a recipient/,
      );
    });

    it("can inspect a decrypted encrypted invoice", async () => {
      const encrypted = await createEncryptedInvoice({
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
      });
      const { instance } = await encrypted.decrypt(keyB);

      const result = await MajikInvoice.autoMarkOverdue([instance]);

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].invoiceId).toBe(instance.id);
    });
  });

  // ========================================================================
  // Retention / sent helpers
  // ========================================================================

  describe("Sent & Retention Helpers", () => {
    it("reports missing sentAt as invalid", async () => {
      const invoice = await createInvoice();
      expect(invoice.hasValidSentAt()).toBe(false);
      expect(invoice.sentDate).toEqual(invoice.issueDate);
      expect(invoice.isPastDeletionWindow(30)).toBe(false);
    });

    it("recognizes a valid sentAt timestamp", async () => {
      const invoice = await createInvoice();
      const json = invoice.toJSON();
      const withSentAt = {
        ...json,
        sent_at: "2026-09-01T12:00:00.000Z",
        user_id: "user-1",
        account_id: "acct-1",
        public_key: keyA.publicKeyBase64,
        status: json.public.status,
      } as MajikahInvoiceJSON;

      const restored = MajikInvoice.fromJSON(withSentAt);

      expect(restored.hasValidSentAt()).toBe(true);
      expect(restored.sentDate).toEqual(new Date("2026-09-01T12:00:00.000Z"));
    });

    it("returns false for an invalid sentAt timestamp", async () => {
      const invoice = await createInvoice();
      const invalid = {
        ...invoice.toJSON(),
        sent_at: "not-a-date",
        user_id: "user-1",
        account_id: "acct-1",
        public_key: keyA.publicKeyBase64,
        status: invoice.public.status,
      } as MajikahInvoiceJSON;

      const restored = MajikInvoice.fromJSON(invalid);

      expect(restored.hasValidSentAt()).toBe(false);
      expect(restored.sentDate).toEqual(restored.issueDate);
      expect(restored.isPastDeletionWindow(30)).toBe(false);
    });

    it("recognizes a timestamp older than the deletion window", async () => {
      const invoice = await createInvoice();
      const old = {
        ...invoice.toJSON(),
        sent_at: "2026-08-01T12:00:00.000Z",
        user_id: "user-1",
        account_id: "acct-1",
        public_key: keyA.publicKeyBase64,
        status: invoice.public.status,
      } as MajikahInvoiceJSON;

      const restored = MajikInvoice.fromJSON(old);

      expect(restored.isPastDeletionWindow(30)).toBe(true);
      expect(restored.isPastDeletionWindow(100)).toBe(false);
    });

    it("uses a strict greater-than comparison at the deletion boundary", async () => {
      const invoice = await createInvoice();
      const exactly30DaysAgo = new Date(
        new Date(FIXED_NOW).getTime() - 30 * 86_400_000,
      ).toISOString();
      const json = {
        ...invoice.toJSON(),
        sent_at: exactly30DaysAgo,
        user_id: "user-1",
        account_id: "acct-1",
        public_key: keyA.publicKeyBase64,
        status: invoice.public.status,
      } as MajikahInvoiceJSON;

      const restored = MajikInvoice.fromJSON(json);
      expect(restored.isPastDeletionWindow(30)).toBe(false);
    });

    it("isIssuer identifies the first signer", async () => {
      const signed = await createSignedInvoice();
      expect(signed.isIssuer(keyA)).toBe(true);
      expect(signed.isIssuer(keyB)).toBe(false);
    });

    it("isIssuer returns false when there are no signatures", async () => {
      const invoice = await createInvoice();
      expect(invoice.isIssuer(keyA)).toBe(false);
    });

    it("isIssuer requires a fingerprint-bearing key", async () => {
      const invoice = await createInvoice();
      expectThrow(
        () => invoice.isIssuer({ fingerprint: "" } as MajikKey),
        MajikInvoiceKeyError,
        /valid Majik Key/,
      );
    });
  });

  // ========================================================================
  // Batch duplication
  // ========================================================================

  describe("batchDuplicate()", () => {
    it("duplicates all accessible signed-only invoices", async () => {
      const a = await createInvoice({ id: "a", invoiceNumber: "INV-001" });
      const b = await createInvoice({ id: "b", invoiceNumber: "INV-010" });

      const result = await MajikInvoice.batchDuplicate([a, b]);

      expect(result.errors).toEqual([]);
      expect(result.duplicated).toHaveLength(2);
      expect(result.duplicated.every((inv) => inv.status === "draft")).toBe(
        true,
      );
      expect(result.duplicated.every((inv) => inv.signatureCount === 0)).toBe(
        true,
      );
      expect(result.duplicated[0].id).not.toBe(a.id);
      expect(result.duplicated[1].id).not.toBe(b.id);
    });

    it("collects encrypted duplication failures without aborting other invoices", async () => {
      const plain = await createInvoice({ id: "plain" });
      const encrypted = await createEncryptedInvoice({ id: "encrypted" });

      const result = await MajikInvoice.batchDuplicate([plain, encrypted]);

      expect(result.duplicated).toHaveLength(1);
      expect(result.duplicated[0].id).not.toBe(plain.id);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].invoiceId).toBe(encrypted.id);
    });

    it("duplicates encrypted invoices when a valid decrypt key is supplied", async () => {
      const encrypted = await createEncryptedInvoice({ id: "encrypted" });
      const result = await MajikInvoice.batchDuplicate([encrypted], keyB);

      expect(result.errors).toEqual([]);
      expect(result.duplicated).toHaveLength(1);
      expect(result.duplicated[0].mode).toBe("signed-only");
      expect(result.duplicated[0].signatureCount).toBe(0);
    });

    it("handles an empty duplication batch", async () => {
      const result = await MajikInvoice.batchDuplicate([]);
      expect(result).toEqual({ duplicated: [], errors: [] });
    });
  });

  // ========================================================================
  // Synchronization
  // ========================================================================

  describe("Synchronization", () => {
    it("isSameContent returns true for identical content hashes", async () => {
      const a = await createInvoice({ id: "same" });
      const b = await createInvoice({ id: "same" });

      expect(MajikInvoice.isSameContent(a, b)).toBe(true);
    });

    it("isSameContent returns false after committed content changes", async () => {
      const a = await createInvoice({ id: "same" });
      const b = await createInvoice({
        id: "same",
        dueDate: "2026-10-31",
      });

      expect(a.hash).not.toBe(b.hash);
      expect(MajikInvoice.isSameContent(a, b)).toBe(false);
    });

    it("isSynced requires matching ID, invoice number and content hash", async () => {
      const a = await createInvoice({ id: "sync", invoiceNumber: "INV-1" });
      const b = await createInvoice({ id: "sync", invoiceNumber: "INV-1" });

      expect(MajikInvoice.isSynced(a, b)).toBe(true);
    });

    it("isSynced rejects a different invoice ID", async () => {
      const a = await createInvoice({ id: "a" });
      const b = await createInvoice({ id: "b" });
      expect(MajikInvoice.isSynced(a, b)).toBe(false);
    });

    it("isSynced rejects a different invoice number", async () => {
      const a = await createInvoice({ id: "same", invoiceNumber: "INV-1" });
      const b = await createInvoice({ id: "same", invoiceNumber: "INV-2" });
      expect(MajikInvoice.isSynced(a, b)).toBe(false);
    });

    it("latest returns the invoice with the newer updatedAt", async () => {
      const a = await createInvoice({ id: "same" });
      vi.advanceTimersByTime(1_000);
      const b = a.withUserId("new");

      expect(MajikInvoice.latest(a, b)).toBe(b);
      expect(MajikInvoice.latest(b, a)).toBe(b);
    });

    it("latest returns the first invoice when timestamps tie", async () => {
      const a = await createInvoice({ id: "a" });
      const b = await createInvoice({ id: "b" });
      expect(a.updatedAt).toBe(b.updatedAt);
      expect(MajikInvoice.latest(a, b)).toBe(a);
    });

    it("diff reports matching content and structural state", async () => {
      const a = await createInvoice({ id: "same", invoiceNumber: "INV-1" });
      const b = await createInvoice({ id: "same", invoiceNumber: "INV-1" });

      const diff = MajikInvoice.diff(a, b);

      expect(diff.sameContent).toBe(true);
      expect(diff.sameInvoiceNumber).toBe(true);
      expect(diff.sameMode).toBe(true);
      expect(diff.sameStatus).toBe(true);
      expect(diff.updatedAtDeltaMs).toBe(0);
      expect(diff.contentHashChanged).toBe(false);
    });

    it("diff detects content and timestamp differences", async () => {
      const a = await createInvoice({ id: "same", invoiceNumber: "INV-1" });
      vi.advanceTimersByTime(1_000);
      const b = await createInvoice({
        id: "same",
        invoiceNumber: "INV-2",
      });

      const diff = MajikInvoice.diff(b, a);

      expect(diff.sameContent).toBe(false);
      expect(diff.sameInvoiceNumber).toBe(false);
      expect(diff.sameMode).toBe(true);
      expect(diff.sameStatus).toBe(true);
      expect(diff.updatedAtDeltaMs).toBe(1_000);
      expect(diff.contentHashChanged).toBe(true);
    });

    it("batchSyncStatus classifies synced, conflict, local-only and remote-only invoices", async () => {
      const syncedLocal = await createInvoice({
        id: "synced",
        invoiceNumber: "S",
      });
      const syncedRemote = await createInvoice({
        id: "synced",
        invoiceNumber: "S",
      });

      const conflictLocal = await createInvoice({
        id: "conflict",
        invoiceNumber: "C",
      });
      const conflictRemote = await createInvoice({
        id: "conflict",
        invoiceNumber: "C-2",
      });

      const localOnly = await createInvoice({ id: "local-only" });
      const remoteOnly = await createInvoice({ id: "remote-only" });

      const result = MajikInvoice.batchSyncStatus(
        [syncedLocal, conflictLocal, localOnly],
        [syncedRemote, conflictRemote, remoteOnly],
      );

      expect(result.synced.map((x) => x.id)).toEqual(["synced"]);
      expect(result.conflicts.map((x) => x.id)).toEqual(["conflict"]);
      expect(result.localOnly.map((x) => x.id)).toEqual(["local-only"]);
      expect(result.remoteOnly.map((x) => x.id)).toEqual(["remote-only"]);
      expect(result.conflicts[0].diff.contentHashChanged).toBe(true);
    });

    it("batchSyncStatus preserves local ordering", async () => {
      const a = await createInvoice({ id: "a" });
      const b = await createInvoice({ id: "b" });
      const c = await createInvoice({ id: "c" });

      const result = MajikInvoice.batchSyncStatus([c, a, b], [b, c, a]);
      expect(result.synced.map((x) => x.id)).toEqual(["c", "a", "b"]);
    });

    it("resolveConflict local-wins returns local as winner", async () => {
      const local = await createInvoice({ id: "same" });
      const remote = await createInvoice({ id: "same" });

      const result = MajikInvoice.resolveConflict(local, remote, "local-wins");
      expect(result).toEqual({
        winner: local,
        loser: remote,
        strategy: "local-wins",
      });
    });

    it("resolveConflict remote-wins returns remote as winner", async () => {
      const local = await createInvoice({ id: "same" });
      const remote = await createInvoice({ id: "same" });

      const result = MajikInvoice.resolveConflict(local, remote, "remote-wins");
      expect(result).toEqual({
        winner: remote,
        loser: local,
        strategy: "remote-wins",
      });
    });

    it("resolveConflict latest-wins picks the newer updatedAt", async () => {
      const local = await createInvoice({ id: "same" });
      vi.advanceTimersByTime(1_000);
      const remote = local.withUserId("remote");

      const result = MajikInvoice.resolveConflict(local, remote, "latest-wins");
      expect(result.winner).toBe(remote);
      expect(result.loser).toBe(local);
    });

    it("resolveConflict latest-wins uses local on a timestamp tie", async () => {
      const local = await createInvoice({ id: "same" });
      const remote = await createInvoice({ id: "same" });

      const result = MajikInvoice.resolveConflict(local, remote, "latest-wins");
      expect(result.winner).toBe(local);
      expect(result.loser).toBe(remote);
    });

    it("resolveConflict defaults to latest-wins", async () => {
      const local = await createInvoice({ id: "same" });
      vi.advanceTimersByTime(1_000);
      const remote = local.withAccountId("remote");

      const result = MajikInvoice.resolveConflict(local, remote);
      expect(result.strategy).toBe("latest-wins");
      expect(result.winner).toBe(remote);
    });

    it("resolveConflict rejects different invoice IDs", async () => {
      const local = await createInvoice({ id: "a" });
      const remote = await createInvoice({ id: "b" });

      expectThrow(
        () => MajikInvoice.resolveConflict(local, remote),
        MajikInvoiceError,
        /must match/,
      );
    });
  });

  // ========================================================================
  // Deduplication helper
  // ========================================================================

  describe("dedupeInvoices()", () => {
    it("keeps the first invoice for each ID", async () => {
      const first = await createInvoice({ id: "same", invoiceNumber: "FIRST" });
      const second = await createInvoice({
        id: "same",
        invoiceNumber: "SECOND",
      });
      const other = await createInvoice({ id: "other" });

      const result = dedupeInvoices([first, second, other]);

      expect(result).toEqual([first, other]);
    });

    it("preserves input order for unique IDs", async () => {
      const a = await createInvoice({ id: "a" });
      const b = await createInvoice({ id: "b" });
      const c = await createInvoice({ id: "c" });

      expect(dedupeInvoices([c, a, b]).map((x) => x.id)).toEqual([
        "c",
        "a",
        "b",
      ]);
    });

    it("handles an empty collection", () => {
      expect(dedupeInvoices([])).toEqual([]);
    });
  });

  // ========================================================================
  // Cryptographic content invariants
  // ========================================================================

  describe("Cryptographic Invariants", () => {
    it("contentHash commits to canonical GeneralInvoice bytes", async () => {
      const invoice = await createInvoice();
      const expected = sha256Hex(invoice.invoice.toCanonicalBytes());

      expect(invoice.hash).toBe(expected);
    });

    it("reissued content receives a new content hash", async () => {
      const invoice = await createInvoice();
      const updated = invoice.invoice.withInvoiceNumber("INV-NEW");
      const reissued = await invoice.reissue(updated);

      expect(reissued.hash).not.toBe(invoice.hash);
    });

    it("operational payment mutations preserve the content commitment", async () => {
      const invoice = await createSignedInvoice();
      const paid = invoice.addPayment(makePayment({ amount: 100 }));

      expect(paid.hash).toBe(invoice.hash);
      expect(paid.verifySignatures).toBeTypeOf("function");
    });
  });

  // ========================================================================
  // Final contract sanity checks
  // ========================================================================

  describe("API Surface Sanity", () => {
    it("exposes the major public APIs expected from the orchestrator", () => {
      const expectedMethods = [
        "restartInvoice",
        "withUserId",
        "withAccountId",
        "addPayment",
        "removePayment",
        "clearPayments",
        "toEncrypted",
        "toSignedOnly",
        "setMode",
        "encrypt",
        "decrypt_mode",
        "withDecryptedCache",
        "decrypt",
        "clearDecryptedCache",
        "canDecrypt",
        "sign",
        "seal",
        "verifySignatures",
        "verifySignature",
        "verifySeal",
        "canSign",
        "canSeal",
        "hasSigned",
        "reissue",
        "receive",
        "countersign",
        "validate",
        "secureLock",
        "toBinary",
        "toMajikahInvoiceJSON",
        "toString",
        "duplicate",
        "hasValidSentAt",
        "isPastDeletionWindow",
        "isIssuer",
      ];

      for (const name of expectedMethods) {
        expect(
          typeof (MajikInvoice.prototype as unknown as Record<string, unknown>)[
            name
          ],
          name,
        ).toBe("function");
      }

      expect(typeof MajikInvoice.create).toBe("function");
      expect(typeof MajikInvoice.fromJSON).toBe("function");
      expect(typeof MajikInvoice.fromBinary).toBe("function");
      expect(typeof MajikInvoice.batchDecrypt).toBe("function");
      expect(typeof MajikInvoice.batchLock).toBe("function");
      expect(typeof MajikInvoice.autoMarkOverdue).toBe("function");
      expect(typeof MajikInvoice.computeDashboardStats).toBe("function");
      expect(typeof MajikInvoice.batchExportToCSV).toBe("function");
      expect(typeof MajikInvoice.batchDuplicate).toBe("function");
      expect(typeof MajikInvoice.isSameContent).toBe("function");
      expect(typeof MajikInvoice.isSynced).toBe("function");
      expect(typeof MajikInvoice.latest).toBe("function");
      expect(typeof MajikInvoice.diff).toBe("function");
      expect(typeof MajikInvoice.batchSyncStatus).toBe("function");
      expect(typeof MajikInvoice.resolveConflict).toBe("function");
    });

    it("freezes the constructor and prototype static surfaces", () => {
      expect(Object.isFrozen(MajikInvoice)).toBe(true);
      expect(Object.isFrozen(MajikInvoice.prototype)).toBe(true);
    });
  });

  // ========================================================================
  // End-to-end real-world workflows
  // ========================================================================

  describe("Real-World End-to-End Workflows", () => {
    it("completes a full invoice lifecycle from creation through settlement and sealing", async () => {
      // --------------------------------------------------------------------
      // 1. Create draft invoice
      // --------------------------------------------------------------------
      let invoice = await createAllowlistedInvoice({
        id: "workflow-full-001",
        invoiceNumber: "INV-2026-100",
        userId: "user-workflow",
        accountId: "acct-workflow",
        issueDate: "2026-10-01",
        dueDate: "2026-10-15",
        lineItems: [
          {
            id: "service-1",
            description: "Enterprise Software Development",
            quantity: 1,
            unitPrice: 2_500,
          },
        ],
      });

      expect(invoice.status).toBe("draft");
      expect(invoice.invoice.effectiveStatus).toBe("draft");
      expect(invoice.invoice.totalAmount).toBe(2_500);
      expect(invoice.totalPaid?.toMajor()).toBe(0);
      expect(invoice.paymentStatus).toBe("pending");

      const originalHash = invoice.hash;
      const originalCreatedAt = invoice.createdAt;

      // Initial issuer signature.
      expect(invoice.signatureCount).toBe(1);
      expect(invoice.hasSigned(keyA)).toBe(true);
      expect(invoice.pendingSigners.map((s) => s.signerId)).toEqual([
        keyB.fingerprint,
      ]);

      // --------------------------------------------------------------------
      // 2. Issue
      //
      // Lifecycle-only mutation: canonical content/signature remain intact.
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      invoice = await invoice.reissue(invoice.invoice.issue(), {
        signerKey: keyA,
      });

      expect(invoice.status).toBe("issued");
      expect(invoice.hash).toBe(originalHash);
      expect(invoice.signatureCount).toBe(1);
      expect(invoice.hasSigned(keyA)).toBe(true);
      expect(invoice.createdAt).toBe(originalCreatedAt);
      expect(invoice.updatedAt).not.toBe(originalCreatedAt);

      // --------------------------------------------------------------------
      // 3. Send
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      invoice = await invoice.reissue(invoice.invoice.send(), {
        signerKey: keyA,
      });

      expect(invoice.status).toBe("sent");
      expect(invoice.hash).toBe(originalHash);
      expect(invoice.signatureCount).toBe(1);

      // --------------------------------------------------------------------
      // 4. Recipient views the invoice
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      invoice = await invoice.reissue(invoice.invoice.view(), {
        signerKey: keyA,
      });

      expect(invoice.status).toBe("viewed");
      expect(invoice.invoice.effectiveStatus).toBe("viewed");
      expect(invoice.hash).toBe(originalHash);
      expect(invoice.signatureCount).toBe(1);

      // --------------------------------------------------------------------
      // 5. Encrypt for recipient
      // --------------------------------------------------------------------
      const encrypted = await invoice.toEncrypted(
        [makeRecipientForKey(keyB)],
        [keyB.publicKeyBase64],
      );

      expect(encrypted.mode).toBe("encrypted-and-signed");
      expect(encrypted.isLocked).toBe(true);
      expect(encrypted.hash).toBe(originalHash);
      expect(encrypted.signatureCount).toBe(1);
      expect(encrypted.canDecrypt(keyB)).toBe(true);

      // Encrypted payload must not be accessible through plaintext projection.
      expectThrow(
        () => encrypted.invoice,
        MajikInvoiceError,
        /Invoice payload is encrypted/,
      );

      // --------------------------------------------------------------------
      // 6. Produce cloud delivery envelope
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      const expectedSentAt = new Date().toISOString();

      const cloudEnvelope = encrypted.toMajikahInvoiceJSON(
        keyA.publicKeyBase64,
        {
          userId: "user-workflow",
          accountId: "acct-workflow",
        },
      );

      expect(cloudEnvelope.user_id).toBe("user-workflow");
      expect(cloudEnvelope.account_id).toBe("acct-workflow");
      expect(cloudEnvelope.status).toBe("viewed");
      expect(cloudEnvelope.public_key).toBe(keyA.publicKeyBase64);
      expect(cloudEnvelope.sent_at).toBe(expectedSentAt);

      // --------------------------------------------------------------------
      // 7. Recipient receives and decrypts
      // --------------------------------------------------------------------
      const delivered = MajikInvoice.fromJSON(cloudEnvelope);

      expect(delivered.mode).toBe("encrypted-and-signed");
      expect(delivered.isLocked).toBe(true);
      expect(delivered.sentAt).toBe(cloudEnvelope.sent_at);

      const decrypted = await delivered.decrypt(keyB);

      expect(decrypted.instance.isLocked).toBe(false);
      expect(decrypted.invoice.totalAmount).toBe(2_500);

      // --------------------------------------------------------------------
      // 8. Recipient reviews and countersigns
      //
      // Notes are operational and therefore remain outside the canonical hash.
      // --------------------------------------------------------------------
      const reviewedInvoice = decrypted.invoice.withNotes(
        "Recipient reviewed the invoice and approved the scope.",
      );

      vi.advanceTimersByTime(60_000);

      const approved = await delivered.receive(reviewedInvoice, {
        signerKey: keyB,
        recipients: [makeRecipientForKey(keyB)],
      });

      expect(approved.mode).toBe("encrypted-and-signed");
      expect(approved.signatureCount).toBe(2);
      expect(approved.hasSigned(keyA)).toBe(true);
      expect(approved.hasSigned(keyB)).toBe(true);
      expect(approved.pendingSigners).toEqual([]);
      expect(approved.isFullySigned).toBe(true);
      expect(approved.hash).toBe(originalHash);

      // --------------------------------------------------------------------
      // 9. Convert back to signed-only for settlement/accounting
      // --------------------------------------------------------------------
      const plaintext = await approved.toSignedOnly(keyB);

      expect(plaintext.mode).toBe("signed-only");
      expect(plaintext.isLocked).toBe(false);
      expect(plaintext.signatureCount).toBe(2);
      expect(plaintext.isFullySigned).toBe(true);
      expect(plaintext.invoice.totalAmount).toBe(2_500);

      // --------------------------------------------------------------------
      // 10. Record partial payment
      // --------------------------------------------------------------------
      const partial = plaintext.addPayment(
        makePayment({
          id: "workflow-payment-001",
          amount: 1_000,
          settledAt: "2026-10-05T10:00:00.000Z",
          method: "Bank Transfer",
          reference: "BANK-TRX-20261005-001",
        }),
      );

      expect(partial.totalPaid?.toMajor()).toBe(1_000);
      expect(partial.invoice.amountDue.toMajor()).toBe(1_500);
      expect(partial.isFullyPaid).toBe(false);
      expect(partial.paymentStatus).toBe("partially_paid");
      expect(partial.status).toBe("partial");

      // Payment is operational state and does not change signed content.
      expect(partial.hash).toBe(originalHash);
      expect(partial.signatureCount).toBe(2);
      expect(partial.isFullySigned).toBe(true);

      // --------------------------------------------------------------------
      // 11. Record final payment
      // --------------------------------------------------------------------
      const paid = partial.addPayment(
        makePayment({
          id: "workflow-payment-002",
          amount: 1_500,
          settledAt: "2026-10-10T10:00:00.000Z",
          method: "Bank Transfer",
          reference: "BANK-TRX-20261010-001",
        }),
      );

      expect(paid.totalPaid?.toMajor()).toBe(2_500);
      expect(paid.invoice.amountDue.toMajor()).toBe(0);
      expect(paid.isFullyPaid).toBe(true);
      expect(paid.paymentStatus).toBe("settled");
      expect(paid.status).toBe("paid");
      expect(paid.hash).toBe(originalHash);
      expect(paid.signatureCount).toBe(2);
      expect(paid.isSealed).toBe(false);

      // --------------------------------------------------------------------
      // 12. Issuer seals the fully signed and settled invoice
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      const sealed = await paid.seal(keyA, {
        timestamp: "2026-10-10T10:30:00.000Z",
      });

      expect(sealed.status).toBe("paid");
      expect(sealed.isFullySigned).toBe(true);
      expect(sealed.isSealed).toBe(true);
      expect(sealed.integrityStatus).toBe("sealed");
      expect(sealed.signatureCount).toBe(2);
      expect(sealed.integrity.sealInfo?.sealedBy).toBe(keyA.fingerprint);

      // --------------------------------------------------------------------
      // 13. Cryptographic verification
      // --------------------------------------------------------------------
      const signatures = await sealed.verifySignatures();
      const seal = await sealed.verifySeal();

      expect(signatures).toHaveLength(2);
      expect(signatures.every((result) => result.valid)).toBe(true);
      expect(seal.valid).toBe(true);

      // Final invariants.
      expect(sealed.hash).toBe(originalHash);
      expect(sealed.status).toBe("paid");
      expect(sealed.paymentStatus).toBe("settled");
      expect(sealed.isFullyPaid).toBe(true);
      expect(sealed.isFullySigned).toBe(true);
      expect(sealed.isSealed).toBe(true);
    });

    it("models a real-world refund through a credit note referencing the original invoice", async () => {
      // --------------------------------------------------------------------
      // 1. Original invoice
      // --------------------------------------------------------------------
      let invoice = await createSignedInvoice({
        id: "workflow-refund-001",
        invoiceNumber: "INV-2026-200",
        issueDate: "2026-10-01",
        dueDate: "2026-10-15",
        lineItems: [
          {
            id: "refund-service",
            description: "Annual Support Plan",
            quantity: 1,
            unitPrice: 1_000,
          },
        ],
      });

      const originalHash = invoice.hash;

      invoice = await invoice.reissue(invoice.invoice.issue(), {
        signerKey: keyA,
      });

      expect(invoice.status).toBe("issued");
      expect(invoice.totalPaid?.toMajor()).toBe(0);
      expect(invoice.paymentStatus).toBe("pending");

      // --------------------------------------------------------------------
      // 2. Customer fully pays the original invoice
      // --------------------------------------------------------------------
      const paid = invoice.addPayment(
        makePayment({
          id: "refund-original-payment",
          amount: 1_000,
          settledAt: "2026-10-03T10:00:00.000Z",
          method: "Card",
          reference: "CARD-ORIGINAL-001",
        }),
      );

      expect(paid.status).toBe("paid");
      expect(paid.totalPaid?.toMajor()).toBe(1_000);
      expect(paid.paymentStatus).toBe("settled");
      expect(paid.hash).toBe(originalHash);
      expect(paid.signatureCount).toBe(1);

      // --------------------------------------------------------------------
      // 3. Business determines that 250 must be refunded.
      //
      // A refund should not delete the historical payment proof.
      // Instead, issue a credit note against the original invoice.
      // --------------------------------------------------------------------
      const refundAmount = 250;

      const creditNote = await MajikInvoice.create({
        id: "workflow-refund-credit-001",
        invoiceNumber: "CN-2026-001",
        type: "credit",
        issuer: makeIssuer(),
        recipient: makeRecipient(),
        currency: "PHP",
        issueDate: "2026-10-04",
        lineItems: [
          {
            id: "refund-credit-line",
            description: "Refund — Annual Support Plan",
            quantity: 1,
            unitPrice: refundAmount,
          },
        ],
        references: [
          {
            type: "invoice",
            number: paid.public.invoiceNumber!,
          },
        ],
        mode: "signed-only",
        signerKey: keyA,
      });

      expect(creditNote.mode).toBe("signed-only");
      expect(creditNote.invoice.isCreditNote).toBe(true);
      expect(creditNote.invoice.totalAmount).toBe(250);
      expect(creditNote.invoice.references).toEqual([
        {
          type: "invoice",
          number: "INV-2026-200",
        },
      ]);
      expect(creditNote.signatureCount).toBe(1);
      expect(creditNote.hasSigned(keyA)).toBe(true);

      // The original invoice remains historically intact.
      expect(paid.invoice.proofOfPayments).toHaveLength(1);
      expect(paid.totalPaid?.toMajor()).toBe(1_000);
      expect(paid.status).toBe("paid");
      expect(paid.hash).toBe(originalHash);

      // --------------------------------------------------------------------
      // 4. Credit note accounting projection must reverse invoice direction
      // --------------------------------------------------------------------
      const journal = creditNote.invoice.toJournalEntry();

      expect(journal.sourceDocument.id).toBe(creditNote.id);
      expect(journal.lines.length).toBeGreaterThan(0);

      const totalDebits = journal.lines.reduce(
        (sum, line) => sum + (line.debit ?? 0),
        0,
      );
      const totalCredits = journal.lines.reduce(
        (sum, line) => sum + (line.credit ?? 0),
        0,
      );

      expect(totalDebits).toBe(totalCredits);
      expect(totalDebits).toBe(250);

      // --------------------------------------------------------------------
      // 5. Verify the original payment and credit note independently
      // --------------------------------------------------------------------
      const originalVerification = await paid.verifySignatures();
      const creditVerification = await creditNote.verifySignatures();

      expect(originalVerification).toHaveLength(1);
      expect(originalVerification[0].valid).toBe(true);

      expect(creditVerification).toHaveLength(1);
      expect(creditVerification[0].valid).toBe(true);
    });

    it("handles multiple document revisions, a formal dispute, administrative conflict selection, and final re-approval", async () => {
      // --------------------------------------------------------------------
      // 1. Create and issue the original invoice
      // --------------------------------------------------------------------
      let invoice = await createAllowlistedInvoice({
        id: "workflow-dispute-001",
        invoiceNumber: "INV-2026-300",
        issueDate: "2026-10-01",
        dueDate: "2026-10-15",
        lineItems: [
          {
            id: "dispute-item",
            description: "Professional Services",
            quantity: 1,
            unitPrice: 5_000,
          },
        ],
      });

      const initialHash = invoice.hash;

      invoice = await invoice.reissue(invoice.invoice.issue(), {
        signerKey: keyA,
      });

      expect(invoice.status).toBe("issued");
      expect(invoice.hash).toBe(initialHash);
      expect(invoice.signatureCount).toBe(1);
      expect(invoice.hasSigned(keyA)).toBe(true);

      // --------------------------------------------------------------------
      // 2. Revision #1 — change due date
      //
      // dueDate is part of canonical signing data, so this is a true revision.
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      const revision1General = invoice.invoice.withDueDate("2026-10-31");
      const revision1 = await invoice.reissue(revision1General, {
        signerKey: keyA,
      });

      expect(revision1.public.dueDate).toBe("2026-10-31");
      expect(revision1.hash).not.toBe(initialHash);

      // Reissue starts a new signature commitment.
      expect(revision1.signatureCount).toBe(1);
      expect(revision1.hasSigned(keyA)).toBe(true);
      expect(revision1.hasSigned(keyB)).toBe(false);
      expect(revision1.isSealed).toBe(false);

      // Original instance remains untouched.
      expect(invoice.public.dueDate).toBe("2026-10-15");
      expect(invoice.hash).toBe(initialHash);

      // --------------------------------------------------------------------
      // 3. Revision #2 — change invoice number
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      const revision2General =
        revision1.invoice.withInvoiceNumber("INV-2026-300-R2");

      const revision2 = await revision1.reissue(revision2General, {
        signerKey: keyA,
      });

      expect(revision2.public.invoiceNumber).toBe("INV-2026-300-R2");
      expect(revision2.hash).not.toBe(revision1.hash);
      expect(revision2.hash).not.toBe(initialHash);
      expect(revision2.signatureCount).toBe(1);
      expect(revision2.hasSigned(keyA)).toBe(true);
      expect(revision2.hasSigned(keyB)).toBe(false);

      // --------------------------------------------------------------------
      // 4. Formal dispute
      //
      // Dispute is lifecycle/operational state. The canonical financial
      // commitment does not change merely because the invoice is disputed.
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      const disputedGeneral = revision2.invoice.dispute(
        "Recipient disputes the scope and pricing of the professional services.",
      );

      const disputed = await revision2.reissue(disputedGeneral, {
        signerKey: keyA,
      });

      expect(disputed.status).toBe("disputed");
      expect(disputed.integrityStatus).toBe("partially-signed");
      expect(disputed.hash).toBe(revision2.hash);
      expect(disputed.signatureCount).toBe(1);
      expect(disputed.hasSigned(keyA)).toBe(true);
      expect(disputed.isSealed).toBe(false);

      expect(disputed.invoice.notes).toContain(
        "DISPUTE REASON: Recipient disputes the scope and pricing",
      );

      // --------------------------------------------------------------------
      // 5. Recipient countersigns the disputed document
      //
      // This is still the same signed financial commitment.
      // --------------------------------------------------------------------
      const disputedApproved = await disputed.sign(keyB);

      expect(disputedApproved.status).toBe("disputed");
      expect(disputedApproved.hash).toBe(revision2.hash);
      expect(disputedApproved.signatureCount).toBe(2);
      expect(disputedApproved.hasSigned(keyA)).toBe(true);
      expect(disputedApproved.hasSigned(keyB)).toBe(true);
      expect(disputedApproved.isFullySigned).toBe(true);

      // --------------------------------------------------------------------
      // 6. Resolve the dispute through the actual lifecycle API
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      const resolvedGeneral = disputedApproved.invoice.resolveDispute(
        "Scope clarified and revised payment terms accepted by both parties.",
      );

      const resolved = await disputedApproved.reissue(resolvedGeneral, {
        signerKey: keyA,
      });

      expect(resolved.status).toBe("issued");
      expect(resolved.hash).toBe(revision2.hash);

      // Reissue creates a new envelope. The canonical financial commitment
      // remains unchanged, but prior envelope signatures are not carried forward.
      expect(resolved.signatureCount).toBe(1);
      expect(resolved.isFullySigned).toBe(false);
      expect(resolved.hasSigned(keyA)).toBe(true);
      expect(resolved.hasSigned(keyB)).toBe(false);
      expect(resolved.pendingSigners.map((s) => s.signerId)).toContain(
        keyB.fingerprint,
      );

      expect(resolved.invoice.notes).toContain(
        "RESOLUTION: Scope clarified and revised payment terms accepted",
      );

      // --------------------------------------------------------------------
      // 7. Two independent revisions are created from the same resolved base
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      const localBranch = await resolved.reissue(
        resolved.invoice.withDueDate("2026-11-05"),
        { signerKey: keyA },
      );

      vi.advanceTimersByTime(60_000);

      const remoteBranch = await resolved.reissue(
        resolved.invoice.withDueDate("2026-11-15"),
        { signerKey: keyA },
      );

      expect(localBranch.id).toBe(remoteBranch.id);
      expect(localBranch.hash).not.toBe(remoteBranch.hash);

      expect(localBranch.public.dueDate).toBe("2026-11-05");
      expect(remoteBranch.public.dueDate).toBe("2026-11-15");

      // Each branch is independently signed.
      expect(localBranch.signatureCount).toBe(1);
      expect(remoteBranch.signatureCount).toBe(1);

      // --------------------------------------------------------------------
      // 8. Synchronization detects a content conflict
      // --------------------------------------------------------------------
      const syncResult = MajikInvoice.batchSyncStatus(
        [localBranch],
        [remoteBranch],
      );

      expect(syncResult.synced).toEqual([]);
      expect(syncResult.localOnly).toEqual([]);
      expect(syncResult.remoteOnly).toEqual([]);
      expect(syncResult.conflicts).toHaveLength(1);

      expect(syncResult.conflicts[0].id).toBe(resolved.id);
      expect(syncResult.conflicts[0].diff.sameContent).toBe(false);
      expect(syncResult.conflicts[0].diff.contentHashChanged).toBe(true);

      // --------------------------------------------------------------------
      // 9. Administrative conflict selection
      //
      // "latest-wins" selects the newer branch; it does not merge content.
      // --------------------------------------------------------------------
      const resolution = MajikInvoice.resolveConflict(
        localBranch,
        remoteBranch,
        "latest-wins",
      );

      expect(resolution.strategy).toBe("latest-wins");
      expect(resolution.winner).toBe(remoteBranch);
      expect(resolution.loser).toBe(localBranch);

      // --------------------------------------------------------------------
      // 10. Recipient reviews and signs the selected final revision
      // --------------------------------------------------------------------
      const finalApproved = await resolution.winner.sign(keyB);

      expect(finalApproved.public.dueDate).toBe("2026-11-15");
      expect(finalApproved.hash).toBe(remoteBranch.hash);
      expect(finalApproved.signatureCount).toBe(2);
      expect(finalApproved.hasSigned(keyA)).toBe(true);
      expect(finalApproved.hasSigned(keyB)).toBe(true);
      expect(finalApproved.isFullySigned).toBe(true);
      expect(finalApproved.isSealed).toBe(false);

      // --------------------------------------------------------------------
      // 11. Issuer seals the final authoritative revision
      // --------------------------------------------------------------------
      vi.advanceTimersByTime(60_000);

      const finalSealed = await finalApproved.seal(keyA, {
        timestamp: "2026-10-01T13:00:00.000Z",
      });

      expect(finalSealed.status).toBe("issued");
      expect(finalSealed.public.dueDate).toBe("2026-11-15");
      expect(finalSealed.hash).toBe(remoteBranch.hash);
      expect(finalSealed.signatureCount).toBe(2);
      expect(finalSealed.isFullySigned).toBe(true);
      expect(finalSealed.isSealed).toBe(true);
      expect(finalSealed.integrityStatus).toBe("sealed");

      // --------------------------------------------------------------------
      // 12. Verify final cryptographic state
      // --------------------------------------------------------------------
      const signatureResults = await finalSealed.verifySignatures();
      const sealResult = await finalSealed.verifySeal();

      expect(signatureResults).toHaveLength(2);
      expect(signatureResults.every((result) => result.valid)).toBe(true);
      expect(sealResult.valid).toBe(true);
      expect(sealResult.sealedBy).toBe(keyA.fingerprint);

      // --------------------------------------------------------------------
      // 13. Historical instances remain immutable snapshots
      // --------------------------------------------------------------------
      expect(invoice.hash).toBe(initialHash);
      expect(invoice.public.dueDate).toBe("2026-10-15");

      expect(revision1.public.dueDate).toBe("2026-10-31");
      expect(revision1.hash).not.toBe(initialHash);

      expect(revision2.public.invoiceNumber).toBe("INV-2026-300-R2");
      expect(revision2.hash).not.toBe(revision1.hash);

      expect(disputed.status).toBe("disputed");
      expect(disputed.hash).toBe(revision2.hash);

      expect(resolved.status).toBe("issued");
      expect(resolved.hash).toBe(revision2.hash);

      expect(localBranch.public.dueDate).toBe("2026-11-05");
      expect(remoteBranch.public.dueDate).toBe("2026-11-15");

      expect(finalSealed.public.dueDate).toBe("2026-11-15");
      expect(finalSealed.hash).toBe(remoteBranch.hash);
      expect(finalSealed.isSealed).toBe(true);
    });
  });
});
