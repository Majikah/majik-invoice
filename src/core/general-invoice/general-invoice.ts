/**
 * @file general-invoice.ts
 * @description GeneralInvoice — the pure accounting base domain object.
 *
 * No crypto. No Majik-specific dependencies.
 * MajikInvoice wraps this via composition.
 *
 * Design principles:
 *  - Private constructor — always use GeneralInvoice.create()
 *  - Totals are auto-computed from line items — never manually set
 *  - Mutation returns new instances (with* pattern) — originals are untouched
 *  - Lifecycle guards prevent illegal status transitions
 *  - Structural mutations (line items, tax) require draft status
 *  - Supplementary mutations (notes, tags, metadata) require non-void status
 *  - toJSON() serializes all MajikMoney via serializeMoney()
 *  - fromJSON() rehydrates all MajikMoneyJSON back to MajikMoney
 *  - toCanonicalBytes() is deterministic — safe for signing
 *  - Projection methods always return status: "draft"
 */

import {
  MajikMoney,
  serializeMoney,
  deserializeMoney,
} from "@thezelijah/majik-money";
import { LineItem } from "./line-item";
import { InvoiceTotals } from "./invoice-totals";
import type {
  Party,
  TaxDetail,
  DocumentReference,
  Period,
  PaymentTerms,
  InvoiceType,
  InvoiceStatus,
  CurrencyCode,
  ISODateString,
  ISODateTimeString,
  AccountingContext,
  JournalEntry,
  JournalLine,
  SubLedgerEntry,
  LineItemInput,
  GeneralInvoiceJSON,
  GeneralInvoiceInput,
  ValidationResult,
  TaxBreakdownEntry,
  LineItemsByAccount,
  DiscountSummary,
  FxTotals,
  InvoiceInternalState,
} from "./types";
import { generateUUID } from "./utils";
import {
  InvoiceLifecycleError,
  InvoiceMutationError,
  InvoiceProjectionError,
  InvoiceValidationError,
} from "./errors";
import {
  ALLOWED_TRANSITIONS,
  DEFAULT_ACCOUNTS,
  SCHEMA_VERSION,
} from "./constants";
import { MajikInvoiceInput } from "../types";

// ---------------------------------------------------------------------------
// GeneralInvoice
// ---------------------------------------------------------------------------

/**
 * General Invoice
 * ---
 * The base invoice domain object — accounting-branch-neutral.
 * All money is represented as MajikMoney.
 * Totals are always derived from line items — never stale.
 *
 * Mutation methods follow the `with*` pattern — they return new instances.
 * The original invoice is never modified.
 *
 * @example
 * ```ts
 * const invoice = GeneralInvoice.create({
 *   issuer: { legalName: "Acme Corp", tin: "123-456-789-000" },
 *   recipient: { legalName: "Beta Inc" },
 *   currency: "PHP",
 *   defaultTax: { taxType: "VAT", rate: 0.12 },
 *   lineItems: [
 *     { description: "Web Development", quantity: 1, unitPrice: 50000 }
 *   ]
 * });
 *
 * const issued = invoice
 *   .withLineItem({ description: "Hosting", quantity: 1, unitPrice: 5000 })
 *   .withInvoiceNumber("INV-2025-001")
 *   .withStatus("issued");
 *
 * console.log(issued.totals.grandTotal.format()); // "₱61,600.00"
 * const entry = issued.toJournalEntry();
 * ```
 */
export class GeneralInvoice {
  // ── Identity ──────────────────────────────────────────────────────────────
  readonly id: string;
  readonly invoiceNumber?: string;
  readonly type: InvoiceType;
  readonly status: InvoiceStatus;
  readonly version: string;

  // ── Parties ───────────────────────────────────────────────────────────────
  readonly issuer: Party;
  readonly recipient: Party;

  // ── Dates & Currency ─────────────────────────────────────────────────────
  readonly currency: CurrencyCode;
  readonly issueDate: ISODateString;
  readonly dueDate?: ISODateString;
  readonly period?: Period;
  readonly paymentTerms?: PaymentTerms;

  // ── Line Items & Totals ───────────────────────────────────────────────────
  readonly lineItems: readonly LineItem[];
  readonly totals: InvoiceTotals;
  readonly defaultTax?: TaxDetail;

  // ── Supplementary ─────────────────────────────────────────────────────────
  readonly references?: readonly DocumentReference[];
  readonly notes?: string;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;

  // ── Timestamps ────────────────────────────────────────────────────────────
  readonly createdAt: ISODateTimeString;
  readonly updatedAt: ISODateTimeString;

  // ── Private constructor ───────────────────────────────────────────────────

  private constructor(
    input: InvoiceInternalState,
    lineItems: LineItem[],
    totals: InvoiceTotals,
  ) {
    this.version = SCHEMA_VERSION;
    this.id = input.id;
    this.invoiceNumber = input.invoiceNumber;
    this.type = input.type;
    this.status = input.status;
    this.issuer = input.issuer;
    this.recipient = input.recipient;
    this.currency = input.currency;
    this.issueDate = input.issueDate;
    this.dueDate = input.dueDate;
    this.period = input.period;
    this.paymentTerms = input.paymentTerms;
    this.lineItems = Object.freeze(lineItems);
    this.totals = totals;
    this.defaultTax = input.defaultTax;
    this.references = input.references
      ? Object.freeze([...input.references])
      : undefined;
    this.notes = input.notes;
    this.tags = input.tags ? [...input.tags] : undefined;
    this.metadata = input.metadata;
    this.createdAt = input.createdAt;
    this.updatedAt = input.updatedAt;
  }

  // ── Internal rebuild ──────────────────────────────────────────────────────

  /**
   * Rebuilds a new GeneralInvoice from the current state with selected
   * fields overridden. Recomputes totals from line items.
   * Always stamps a fresh updatedAt.
   */
  private rebuild(
    overrides: Partial<InvoiceInternalState>,
    lineItems?: LineItem[],
  ): GeneralInvoice {
    const items = lineItems ?? [...this.lineItems];
    const totals = InvoiceTotals.fromLineItems(items, this.currency);

    return new GeneralInvoice(
      {
        id: this.id,
        invoiceNumber: this.invoiceNumber,
        type: this.type,
        status: this.status,
        issuer: this.issuer,
        recipient: this.recipient,
        currency: this.currency,
        issueDate: this.issueDate,
        dueDate: this.dueDate,
        period: this.period,
        paymentTerms: this.paymentTerms,
        defaultTax: this.defaultTax,
        references: this.references ? [...this.references] : undefined,
        notes: this.notes,
        tags: this.tags,
        metadata: this.metadata,
        createdAt: this.createdAt,
        updatedAt: new Date().toISOString(),
        ...overrides,
      },
      items,
      totals,
    );
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  /**
   * Assert the invoice is not void. Voided invoices are terminal.
   * @throws {InvoiceMutationError}
   */
  private assertEditable(operation: string): void {
    if (this.status === "void") {
      throw new InvoiceMutationError(
        `Cannot ${operation} on a voided invoice (id: ${this.id}). ` +
          `Voided invoices are immutable.`,
      );
    }
  }

  /**
   * Assert the invoice is in draft status.
   * Structural mutations (line items, tax, dates) require draft.
   * @throws {InvoiceMutationError}
   */
  private assertDraft(operation: string): void {
    if (this.status !== "draft") {
      throw new InvoiceMutationError(
        `Cannot ${operation} on an invoice with status "${this.status}". ` +
          `Structural changes are only allowed on draft invoices. ` +
          `Transition back to "draft" first if permitted (use canTransitionTo("draft")).`,
      );
    }
  }

  // ── Static factory ────────────────────────────────────────────────────────

  /**
   * Create a validated, immutable GeneralInvoice.
   *
   * Totals are auto-computed from line items.
   * Line items with no explicit tax inherit from defaultTax.
   *
   * @throws {InvoiceValidationError} if input is invalid
   * @throws {LineItemValidationError} if any line item is invalid
   */
  static create(input: GeneralInvoiceInput): GeneralInvoice {
    GeneralInvoice.assertValid(input);

    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    const resolvedLineItemInputs = input.lineItems.map((li) => ({
      ...li,
      tax: li.tax ?? input.defaultTax,
    }));

    const lineItems = resolvedLineItemInputs.map((li) =>
      LineItem.create(li, input.currency),
    );

    const totals = InvoiceTotals.fromLineItems(lineItems, input.currency);

    return new GeneralInvoice(
      {
        ...input,
        id: input.id ?? generateUUID(),
        type: input.type ?? "commercial",
        status: input.status ?? "draft",
        issueDate: input.issueDate ?? today,
        createdAt: now,
        updatedAt: now,
      },
      lineItems,
      totals,
    );
  }

  // ==========================================================================
  // ── WITH* MUTATION METHODS ─────────────────────────────────────────────────
  // Every method returns a NEW GeneralInvoice. The original is untouched.
  //
  // Rules:
  //   assertEditable  — required for supplementary changes (notes, tags, etc.)
  //   assertDraft     — required for structural changes (line items, tax, dates)
  // ==========================================================================

  // ── Identity & metadata ───────────────────────────────────────────────────

  /**
   * Set or replace the human-readable invoice number.
   *
   * @throws {InvoiceMutationError} if invoice is void
   * @throws {InvoiceValidationError} if number is empty
   */
  withInvoiceNumber(invoiceNumber: string): GeneralInvoice {
    this.assertEditable("set invoice number");

    if (!invoiceNumber || invoiceNumber.trim().length === 0) {
      throw new InvoiceValidationError(
        "Invoice number cannot be empty",
        "invoiceNumber",
      );
    }

    return this.rebuild({ invoiceNumber: invoiceNumber.trim() });
  }

  /**
   * Transition to a new lifecycle status.
   *
   * Allowed transitions:
   *   draft    → draft | issued | void
   *   issued   → sent | viewed | partial | paid | disputed | void
   *   sent     → viewed | partial | paid | disputed | void
   *   viewed   → partial | paid | disputed | void
   *   partial  → paid | disputed | void
   *   paid     → void
   *   overdue  → paid | partial | disputed | void
   *   disputed → issued | void
   *   void     → (terminal)
   *
   * @throws {InvoiceLifecycleError} if transition is not permitted
   */
  withStatus(status: InvoiceStatus): GeneralInvoice {
    if (this.status === status) return this;

    const allowed = ALLOWED_TRANSITIONS[this.status];
    if (!allowed.includes(status)) {
      throw new InvoiceLifecycleError(
        `Invalid status transition: "${this.status}" → "${status}". ` +
          `Allowed from "${this.status}": [${allowed.join(", ") || "none"}].`,
        this.status,
        status,
      );
    }

    return this.rebuild({ status });
  }

  /**
   * Set or replace free-form notes.
   *
   * @throws {InvoiceMutationError} if invoice is void
   */
  withNotes(notes: string): GeneralInvoice {
    this.assertEditable("set notes");

    if (typeof notes !== "string") {
      throw new InvoiceValidationError("Notes must be a string", "notes");
    }

    return this.rebuild({ notes: notes.trim() });
  }

  /**
   * Clear notes.
   *
   * @throws {InvoiceMutationError} if invoice is void
   */
  withoutNotes(): GeneralInvoice {
    this.assertEditable("clear notes");
    return this.rebuild({ notes: undefined });
  }

  /**
   * Replace all tags. Duplicates are removed automatically.
   *
   * @throws {InvoiceMutationError} if invoice is void
   * @throws {InvoiceValidationError} if any tag is empty
   */
  withTags(tags: string[]): GeneralInvoice {
    this.assertEditable("set tags");

    if (!Array.isArray(tags)) {
      throw new InvoiceValidationError("Tags must be an array", "tags");
    }

    const cleaned = tags.map((t, i) => {
      if (typeof t !== "string" || t.trim().length === 0) {
        throw new InvoiceValidationError(
          `Tag at index ${i} is empty or invalid`,
          `tags[${i}]`,
        );
      }
      return t.trim();
    });

    return this.rebuild({ tags: [...new Set(cleaned)] });
  }

  /**
   * Append a single tag. No-op if already present.
   *
   * @throws {InvoiceMutationError} if invoice is void
   * @throws {InvoiceValidationError} if tag is empty
   */
  withTag(tag: string): GeneralInvoice {
    this.assertEditable("add tag");

    if (!tag || tag.trim().length === 0) {
      throw new InvoiceValidationError("Tag cannot be empty", "tag");
    }

    const existing = this.tags ?? [];
    const trimmed = tag.trim();
    if (existing.includes(trimmed)) return this;

    return this.rebuild({ tags: [...existing, trimmed] });
  }

  /**
   * Remove a specific tag by value.
   *
   * @throws {InvoiceMutationError} if invoice is void
   */
  withoutTag(tag: string): GeneralInvoice {
    this.assertEditable("remove tag");
    return this.rebuild({
      tags: (this.tags ?? []).filter((t) => t !== tag.trim()),
    });
  }

  /**
   * Deep-merge metadata. Existing keys are overwritten; pass `null` to remove a key.
   *
   * @example invoice.withMetadata({ projectId: "abc", region: null })
   * @throws {InvoiceMutationError} if invoice is void
   * @throws {InvoiceValidationError} if patch is not a plain object
   */
  withMetadata(patch: Record<string, unknown>): GeneralInvoice {
    this.assertEditable("update metadata");

    if (typeof patch !== "object" || Array.isArray(patch) || patch === null) {
      throw new InvoiceValidationError(
        "Metadata patch must be a plain object",
        "metadata",
      );
    }

    const merged: Record<string, unknown> = { ...(this.metadata ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    return this.rebuild({ metadata: merged });
  }

  /**
   * Replace all metadata entirely.
   *
   * @throws {InvoiceMutationError} if invoice is void
   * @throws {InvoiceValidationError} if value is not a plain object
   */
  withMetadataReplaced(metadata: Record<string, unknown>): GeneralInvoice {
    this.assertEditable("replace metadata");

    if (
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      metadata === null
    ) {
      throw new InvoiceValidationError(
        "Metadata must be a plain object",
        "metadata",
      );
    }

    return this.rebuild({ metadata: { ...metadata } });
  }

  /**
   * Clear all metadata.
   *
   * @throws {InvoiceMutationError} if invoice is void
   */
  withoutMetadata(): GeneralInvoice {
    this.assertEditable("clear metadata");
    return this.rebuild({ metadata: undefined });
  }

  // ── Dates & terms ─────────────────────────────────────────────────────────

  /**
   * Set the issue date.
   *
   * @param date - ISO 8601 (YYYY-MM-DD)
   * @throws {InvoiceMutationError} if not draft
   * @throws {InvoiceValidationError} if format invalid or after dueDate
   */
  withIssueDate(date: ISODateString): GeneralInvoice {
    this.assertDraft("set issue date");
    GeneralInvoice.assertDateFormat(date, "issueDate");

    if (this.dueDate && date > this.dueDate) {
      throw new InvoiceValidationError(
        `issueDate (${date}) cannot be after dueDate (${this.dueDate})`,
        "issueDate",
      );
    }

    return this.rebuild({ issueDate: date });
  }

  /**
   * Set or replace the due date.
   *
   * @param date - ISO 8601 (YYYY-MM-DD)
   * @throws {InvoiceMutationError} if invoice is void
   * @throws {InvoiceValidationError} if format invalid or before issueDate
   */
  withDueDate(date: ISODateString): GeneralInvoice {
    this.assertEditable("set due date");
    GeneralInvoice.assertDateFormat(date, "dueDate");

    if (date < this.issueDate) {
      throw new InvoiceValidationError(
        `dueDate (${date}) cannot be before issueDate (${this.issueDate})`,
        "dueDate",
      );
    }

    return this.rebuild({ dueDate: date });
  }

  /**
   * Remove the due date.
   *
   * @throws {InvoiceMutationError} if invoice is void
   */
  withoutDueDate(): GeneralInvoice {
    this.assertEditable("remove due date");
    return this.rebuild({ dueDate: undefined });
  }

  /**
   * Set the billing / service period.
   *
   * @throws {InvoiceMutationError} if not draft
   * @throws {InvoiceValidationError} if dates invalid or inverted
   */
  withPeriod(period: Period): GeneralInvoice {
    this.assertDraft("set period");

    if (!period || typeof period !== "object") {
      throw new InvoiceValidationError("Period must be an object", "period");
    }

    GeneralInvoice.assertDateFormat(period.start, "period.start");
    GeneralInvoice.assertDateFormat(period.end, "period.end");

    if (period.end < period.start) {
      throw new InvoiceValidationError(
        `period.end (${period.end}) cannot be before period.start (${period.start})`,
        "period",
      );
    }

    return this.rebuild({ period: { ...period } });
  }

  /**
   * Remove the billing period.
   *
   * @throws {InvoiceMutationError} if not draft
   */
  withoutPeriod(): GeneralInvoice {
    this.assertDraft("remove period");
    return this.rebuild({ period: undefined });
  }

  /**
   * Set payment terms.
   *
   * @throws {InvoiceMutationError} if invoice is void
   */
  withPaymentTerms(terms: PaymentTerms): GeneralInvoice {
    this.assertEditable("set payment terms");

    if (!terms) {
      throw new InvoiceValidationError(
        "Payment terms cannot be empty",
        "paymentTerms",
      );
    }

    return this.rebuild({ paymentTerms: terms });
  }

  // ── References ────────────────────────────────────────────────────────────

  /**
   * Append a single document reference (PO, contract, audit ref, etc.).
   *
   * @throws {InvoiceMutationError} if invoice is void
   * @throws {InvoiceValidationError} if type or number is empty
   */
  withReference(ref: DocumentReference): GeneralInvoice {
    this.assertEditable("add reference");
    GeneralInvoice.assertValidReference(ref, "reference");

    const existing = this.references ? [...this.references] : [];
    return this.rebuild({
      references: [
        ...existing,
        { ...ref, type: ref.type.trim(), number: ref.number.trim() },
      ],
    });
  }

  /**
   * Replace all document references.
   *
   * @throws {InvoiceMutationError} if invoice is void
   * @throws {InvoiceValidationError} if any reference is invalid
   */
  withReferences(refs: DocumentReference[]): GeneralInvoice {
    this.assertEditable("replace references");

    if (!Array.isArray(refs)) {
      throw new InvoiceValidationError(
        "References must be an array",
        "references",
      );
    }

    refs.forEach((ref, i) =>
      GeneralInvoice.assertValidReference(ref, `references[${i}]`),
    );

    return this.rebuild({ references: refs.map((r) => ({ ...r })) });
  }

  /**
   * Remove a document reference matched by type and number.
   *
   * @throws {InvoiceMutationError} if invoice is void
   */
  withoutReference(type: string, number: string): GeneralInvoice {
    this.assertEditable("remove reference");

    return this.rebuild({
      references: (this.references ?? []).filter(
        (r) => !(r.type === type && r.number === number),
      ),
    });
  }

  /**
   * Remove all document references.
   *
   * @throws {InvoiceMutationError} if invoice is void
   */
  withoutReferences(): GeneralInvoice {
    this.assertEditable("clear references");
    return this.rebuild({ references: undefined });
  }

  // ── Line item mutations ───────────────────────────────────────────────────

  /**
   * Append a single line item. Totals are recomputed.
   * Inherits defaultTax if the line has no explicit tax.
   *
   * @throws {InvoiceMutationError} if not draft
   * @throws {LineItemValidationError} if input is invalid
   */
  withLineItem(input: LineItemInput): GeneralInvoice {
    this.assertDraft("add line item");

    const resolved: LineItemInput = {
      ...input,
      tax: input.tax ?? this.defaultTax,
    };

    const lineItem = LineItem.create(resolved, this.currency);
    return this.rebuild({}, [...this.lineItems, lineItem]);
  }

  /**
   * Replace all line items. Totals are recomputed.
   * defaultTax is applied to any line with no explicit tax.
   *
   * @throws {InvoiceMutationError} if not draft
   * @throws {InvoiceValidationError} if array is empty
   * @throws {LineItemValidationError} if any item is invalid
   */
  withLineItems(inputs: LineItemInput[]): GeneralInvoice {
    this.assertDraft("replace line items");

    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new InvoiceValidationError(
        "At least one line item is required",
        "lineItems",
      );
    }

    const lineItems = inputs.map((li) =>
      LineItem.create({ ...li, tax: li.tax ?? this.defaultTax }, this.currency),
    );

    return this.rebuild({}, lineItems);
  }

  /**
   * Remove a line item by id. Totals are recomputed.
   *
   * @throws {InvoiceMutationError} if not draft
   * @throws {InvoiceValidationError} if id not found or would leave zero items
   */
  withoutLineItem(id: string): GeneralInvoice {
    this.assertDraft("remove line item");

    if (!id || id.trim().length === 0) {
      throw new InvoiceValidationError(
        "Line item id is required",
        "lineItemId",
      );
    }

    const exists = this.lineItems.some((li) => li.id === id);
    if (!exists) {
      throw new InvoiceValidationError(
        `Line item with id "${id}" not found`,
        "lineItemId",
      );
    }

    if (this.lineItems.length === 1) {
      throw new InvoiceValidationError(
        "Cannot remove the last line item. Use withClearedLineItems() then withLineItem() to replace it.",
        "lineItems",
      );
    }

    return this.rebuild(
      {},
      this.lineItems.filter((li) => li.id !== id),
    );
  }

  /**
   * Update specific fields on a line item by id.
   * Only provided fields change — everything else carries over.
   * Totals are recomputed.
   *
   * @param id - Line item id
   * @param patch - Partial fields to apply
   * @throws {InvoiceMutationError} if not draft
   * @throws {InvoiceValidationError} if id not found or patch is invalid
   * @throws {LineItemValidationError} if the merged result is invalid
   */
  withUpdatedLineItem(
    id: string,
    patch: Partial<LineItemInput>,
  ): GeneralInvoice {
    this.assertDraft("update line item");

    if (!id || id.trim().length === 0) {
      throw new InvoiceValidationError(
        "Line item id is required",
        "lineItemId",
      );
    }

    const existing = this.lineItems.find((li) => li.id === id);
    if (!existing) {
      throw new InvoiceValidationError(
        `Line item with id "${id}" not found`,
        "lineItemId",
      );
    }

    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new InvoiceValidationError("Patch must be a plain object", "patch");
    }

    const mergedInput: LineItemInput = {
      id: existing.id,
      description: patch.description ?? existing.description,
      quantity: patch.quantity ?? existing.quantity,
      unitPrice: patch.unitPrice ?? existing.unitPrice.toMajor(),
      unit: "unit" in patch ? patch.unit : existing.unit,
      tax: "tax" in patch ? patch.tax : (existing.tax ?? this.defaultTax),
      discount: "discount" in patch ? patch.discount : existing.discount,
      accountCode:
        "accountCode" in patch ? patch.accountCode : existing.accountCode,
      costCenter:
        "costCenter" in patch ? patch.costCenter : existing.costCenter,
      tags: "tags" in patch ? patch.tags : existing.tags,
      metadata: "metadata" in patch ? patch.metadata : existing.metadata,
    };

    const updatedItem = LineItem.create(mergedInput, this.currency);
    const items = this.lineItems.map((li) => (li.id === id ? updatedItem : li));

    return this.rebuild({}, items);
  }

  /**
   * Remove all line items.
   * The invoice will have zero items — repopulate before projecting.
   *
   * @throws {InvoiceMutationError} if not draft
   */
  withClearedLineItems(): GeneralInvoice {
    this.assertDraft("clear line items");
    return this.rebuild({}, []);
  }

  // ── Tax mutations ─────────────────────────────────────────────────────────

  /**
   * Set or replace the invoice-level default tax.
   * Line items that had no explicit tax are re-resolved with the new default.
   * Line items with their own explicit tax are untouched.
   *
   * @throws {InvoiceMutationError} if not draft
   * @throws {InvoiceValidationError} if tax is invalid
   */
  withDefaultTax(tax: TaxDetail): GeneralInvoice {
    this.assertDraft("set default tax");
    GeneralInvoice.assertValidTax(tax, "defaultTax");

    const items = this.lineItems.map((li) => {
      // Determine if this line was inheriting the old default
      const wasInheriting =
        !this.defaultTax ||
        (li.tax?.taxType === this.defaultTax.taxType &&
          li.tax?.rate === this.defaultTax.rate &&
          li.tax?.jurisdiction === this.defaultTax.jurisdiction);

      const resolvedTax = wasInheriting ? tax : li.tax;

      return LineItem.create(
        {
          id: li.id,
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice.toMajor(),
          unit: li.unit,
          tax: resolvedTax,
          discount: li.discount,
          accountCode: li.accountCode,
          costCenter: li.costCenter,
          tags: li.tags,
          metadata: li.metadata,
        },
        this.currency,
      );
    });

    return this.rebuild({ defaultTax: { ...tax } }, items);
  }

  /**
   * Remove the invoice-level default tax.
   * Line items that were inheriting the default become tax-free.
   *
   * @throws {InvoiceMutationError} if not draft
   */
  withoutDefaultTax(): GeneralInvoice {
    this.assertDraft("remove default tax");

    const items = this.lineItems.map((li) => {
      const wasInheriting =
        this.defaultTax &&
        li.tax?.taxType === this.defaultTax.taxType &&
        li.tax?.rate === this.defaultTax.rate &&
        li.tax?.jurisdiction === this.defaultTax.jurisdiction;

      return LineItem.create(
        {
          id: li.id,
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice.toMajor(),
          unit: li.unit,
          tax: wasInheriting ? undefined : li.tax,
          discount: li.discount,
          accountCode: li.accountCode,
          costCenter: li.costCenter,
          tags: li.tags,
          metadata: li.metadata,
        },
        this.currency,
      );
    });

    return this.rebuild({ defaultTax: undefined }, items);
  }

  /**
   * Apply a specific tax to one line item, overriding whatever it had.
   *
   * @throws {InvoiceMutationError} if not draft
   * @throws {InvoiceValidationError} if id not found or tax invalid
   */
  withTaxOnLineItem(lineItemId: string, tax: TaxDetail): GeneralInvoice {
    this.assertDraft("set tax on line item");
    GeneralInvoice.assertValidTax(tax, `lineItem[${lineItemId}].tax`);

    if (!this.lineItems.some((li) => li.id === lineItemId)) {
      throw new InvoiceValidationError(
        `Line item with id "${lineItemId}" not found`,
        "lineItemId",
      );
    }

    return this.withUpdatedLineItem(lineItemId, { tax });
  }

  /**
   * Apply the same tax to all line items, overriding each line's existing tax.
   *
   * @throws {InvoiceMutationError} if not draft
   * @throws {InvoiceValidationError} if tax is invalid
   */
  withTaxOnAllLineItems(tax: TaxDetail): GeneralInvoice {
    this.assertDraft("set tax on all line items");
    GeneralInvoice.assertValidTax(tax, "tax");

    const items = this.lineItems.map((li) =>
      LineItem.create(
        {
          id: li.id,
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice.toMajor(),
          unit: li.unit,
          tax: { ...tax },
          discount: li.discount,
          accountCode: li.accountCode,
          costCenter: li.costCenter,
          tags: li.tags,
          metadata: li.metadata,
        },
        this.currency,
      ),
    );

    return this.rebuild({}, items);
  }

  /**
   * Remove tax from a specific line item.
   * The line becomes tax-free regardless of the invoice default.
   *
   * @throws {InvoiceMutationError} if not draft
   * @throws {InvoiceValidationError} if id not found
   */
  withoutTaxOnLineItem(lineItemId: string): GeneralInvoice {
    this.assertDraft("remove tax from line item");

    if (!this.lineItems.some((li) => li.id === lineItemId)) {
      throw new InvoiceValidationError(
        `Line item with id "${lineItemId}" not found`,
        "lineItemId",
      );
    }

    return this.withUpdatedLineItem(lineItemId, { tax: undefined });
  }

  /**
   * Remove tax from all line items.
   * Does not remove the invoice-level defaultTax definition.
   *
   * @throws {InvoiceMutationError} if not draft
   */
  withoutTaxOnAllLineItems(): GeneralInvoice {
    this.assertDraft("remove tax from all line items");

    const items = this.lineItems.map((li) =>
      LineItem.create(
        {
          id: li.id,
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice.toMajor(),
          unit: li.unit,
          tax: undefined,
          discount: li.discount,
          accountCode: li.accountCode,
          costCenter: li.costCenter,
          tags: li.tags,
          metadata: li.metadata,
        },
        this.currency,
      ),
    );

    return this.rebuild({}, items);
  }

  // ==========================================================================
  // ── VALIDATION ─────────────────────────────────────────────────────────────
  // ==========================================================================

  static validate(input: GeneralInvoiceInput): ValidationResult {
    const errors: Array<{ field: string; message: string }> = [];

    if (!input.issuer) {
      errors.push({ field: "issuer", message: "Issuer is required" });
    } else if (!input.issuer.legalName?.trim()) {
      errors.push({
        field: "issuer.legalName",
        message: "Issuer legal name is required",
      });
    }

    if (!input.recipient) {
      errors.push({ field: "recipient", message: "Recipient is required" });
    } else if (!input.recipient.legalName?.trim()) {
      errors.push({
        field: "recipient.legalName",
        message: "Recipient legal name is required",
      });
    }

    if (!input.currency?.trim()) {
      errors.push({ field: "currency", message: "Currency is required" });
    } else if (!/^[A-Z]{3}$/.test(input.currency)) {
      errors.push({
        field: "currency",
        message: "Currency must be a valid ISO 4217 code (e.g. PHP, USD)",
      });
    }

    if (!input.lineItems || input.lineItems.length === 0) {
      errors.push({
        field: "lineItems",
        message: "At least one line item is required",
      });
    }

    if (input.issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate)) {
      errors.push({
        field: "issueDate",
        message: "issueDate must be in YYYY-MM-DD format",
      });
    }

    if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
      errors.push({
        field: "dueDate",
        message: "dueDate must be in YYYY-MM-DD format",
      });
    }

    if (input.issueDate && input.dueDate && input.dueDate < input.issueDate) {
      errors.push({
        field: "dueDate",
        message: "dueDate cannot be before issueDate",
      });
    }

    if (input.period) {
      if (!input.period.start || !input.period.end) {
        errors.push({
          field: "period",
          message: "Period must have both start and end dates",
        });
      } else if (input.period.end < input.period.start) {
        errors.push({
          field: "period",
          message: "Period end date cannot be before start date",
        });
      }
    }

    if (
      input.issuer?.address?.country &&
      !/^[A-Z]{2}$/.test(input.issuer.address.country)
    ) {
      errors.push({
        field: "issuer.address.country",
        message:
          "Country must be a valid ISO 3166-1 alpha-2 code (e.g. PH, US)",
      });
    }

    if (
      input.recipient?.address?.country &&
      !/^[A-Z]{2}$/.test(input.recipient.address.country)
    ) {
      errors.push({
        field: "recipient.address.country",
        message:
          "Country must be a valid ISO 3166-1 alpha-2 code (e.g. PH, US)",
      });
    }

    if (input.defaultTax) {
      if (
        typeof input.defaultTax.rate !== "number" ||
        input.defaultTax.rate < 0 ||
        input.defaultTax.rate > 1
      ) {
        errors.push({
          field: "defaultTax.rate",
          message: "Default tax rate must be between 0 and 1",
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  static assertValid(input: GeneralInvoiceInput): void {
    const result = GeneralInvoice.validate(input);
    if (!result.valid) {
      const messages = result.errors.map((e) => `${e.field}: ${e.message}`);
      throw new InvoiceValidationError(
        `Invoice validation failed:\n${messages.join("\n")}`,
        undefined,
        messages,
      );
    }
  }

  private static assertValidTax(tax: TaxDetail, field: string): void {
    if (!tax || typeof tax !== "object") {
      throw new InvoiceValidationError("Tax must be a valid object", field);
    }
    if (!tax.taxType || tax.taxType.trim().length === 0) {
      throw new InvoiceValidationError(
        "Tax type is required (e.g. 'VAT', 'GST', 'WHT')",
        `${field}.taxType`,
      );
    }
    if (typeof tax.rate !== "number" || !isFinite(tax.rate)) {
      throw new InvoiceValidationError(
        "Tax rate must be a finite number",
        `${field}.rate`,
      );
    }
    if (tax.rate < 0 || tax.rate > 1) {
      throw new InvoiceValidationError(
        "Tax rate must be between 0 and 1 (e.g. 0.12 for 12%)",
        `${field}.rate`,
      );
    }
  }

  private static assertDateFormat(date: string, field: string): void {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new InvoiceValidationError(
        `${field} must be in YYYY-MM-DD format`,
        field,
      );
    }
  }

  private static assertValidReference(
    ref: DocumentReference,
    field: string,
  ): void {
    if (!ref || typeof ref !== "object") {
      throw new InvoiceValidationError(
        "Reference must be a valid object",
        field,
      );
    }
    if (!ref.type || ref.type.trim().length === 0) {
      throw new InvoiceValidationError(
        "Reference type is required",
        `${field}.type`,
      );
    }
    if (!ref.number || ref.number.trim().length === 0) {
      throw new InvoiceValidationError(
        "Reference number is required",
        `${field}.number`,
      );
    }
  }

  // ==========================================================================
  // ── GETTERS ─────────────────────────────────────────────────────────────────
  // ==========================================================================

  get formattedTotal(): string {
    return this.totals.grandTotal.format();
  }
  get totalAmount(): number {
    return this.totals.grandTotalAmount;
  }
  get taxAmount(): number {
    return this.totals.taxTotalAmount;
  }
  get subtotalAmount(): number {
    return this.totals.subtotalAmount;
  }
  get discountAmount(): number {
    return this.totals.discountTotalAmount;
  }
  get lineItemCount(): number {
    return this.lineItems.length;
  }
  get effectiveTaxRate(): number {
    return this.totals.effectiveTaxRate;
  }
  get isDraft(): boolean {
    return this.status === "draft";
  }
  get isPaid(): boolean {
    return this.status === "paid";
  }
  get isTerminal(): boolean {
    return this.status === "void";
  }
  get isCreditNote(): boolean {
    return this.type === "credit";
  }
  get isTaxInvoice(): boolean {
    return this.type === "tax";
  }
  get hasTax(): boolean {
    return this.totals.hasTax;
  }
  get hasDiscount(): boolean {
    return this.totals.hasDiscount;
  }

  get isOverdue(): boolean {
    if (!this.dueDate) return false;
    return new Date().toISOString().slice(0, 10) > this.dueDate;
  }

  get taxTypes(): string[] {
    return [
      ...new Set(
        this.lineItems
          .filter((li) => li.tax?.taxType)
          .map((li) => li.tax!.taxType),
      ),
    ];
  }

  get costCenters(): string[] {
    return [
      ...new Set(
        this.lineItems
          .filter((li) => li.costCenter)
          .map((li) => li.costCenter!),
      ),
    ];
  }

  get accountCodes(): string[] {
    return [
      ...new Set(
        this.lineItems
          .filter((li) => li.accountCode)
          .map((li) => li.accountCode!),
      ),
    ];
  }

  // ==========================================================================
  // ── CALCULATION & ANALYSIS ─────────────────────────────────────────────────
  // ==========================================================================

  /** Whether debits === credits — required before projecting to journal. */
  isBalanced(): boolean {
    if (this.lineItems.length === 0) return false;
    const lineSum = this.lineItems.reduce((s, li) => s + li.netTotalAmount, 0);
    return Math.abs(lineSum - this.totals.grandTotalAmount) < 0.01;
  }

  /** Whether a specific status transition is permitted. */
  canTransitionTo(to: InvoiceStatus): boolean {
    return ALLOWED_TRANSITIONS[this.status].includes(to);
  }

  /** All statuses this invoice can legally transition to. */
  allowedTransitions(): InvoiceStatus[] {
    return [...ALLOWED_TRANSITIONS[this.status]];
  }

  /**
   * Tax total for a specific tax type across all line items.
   * @param taxType - e.g. "VAT" | "WHT" | "GST"
   */
  taxTotalByType(taxType: string): number {
    if (!taxType?.trim()) {
      throw new InvoiceValidationError("taxType is required", "taxType");
    }
    return this.lineItems
      .filter((li) => li.tax?.taxType === taxType)
      .reduce((s, li) => s + li.taxAmountValue, 0);
  }

  /**
   * Subtotal (pre-tax, pre-discount) for a specific cost center.
   */
  subtotalByCostCenter(costCenter: string): number {
    if (!costCenter?.trim()) {
      throw new InvoiceValidationError("costCenter is required", "costCenter");
    }
    return this.lineItems
      .filter((li) => li.costCenter === costCenter)
      .reduce((s, li) => s + li.lineTotalAmount, 0);
  }

  /**
   * Subtotal for a specific account code.
   * Useful for previewing journal entry distribution before projection.
   */
  subtotalByAccountCode(accountCode: string): number {
    if (!accountCode?.trim()) {
      throw new InvoiceValidationError(
        "accountCode is required",
        "accountCode",
      );
    }
    return this.lineItems
      .filter((li) => li.accountCode === accountCode)
      .reduce((s, li) => s + li.lineTotalAmount, 0);
  }

  /**
   * Full tax breakdown grouped by (taxType + jurisdiction + inclusive).
   *
   * Useful for:
   *  - BIR VAT return preparation
   *  - Multi-jurisdiction tax separation
   *  - Withholding tax vs output tax breakdown
   *
   * @returns One entry per unique tax group
   */
  taxBreakdown(): TaxBreakdownEntry[] {
    const groups = new Map<string, TaxBreakdownEntry>();

    for (const li of this.lineItems) {
      if (!li.tax) continue;

      const key = [
        li.tax.taxType,
        li.tax.jurisdiction ?? "",
        String(li.tax.inclusive ?? false),
      ].join("::");

      const postDiscount = li.lineTotalAmount - li.discountAmountValue;
      const existing = groups.get(key);

      if (existing) {
        existing.taxableBase += postDiscount;
        existing.taxAmount += li.taxAmountValue;
        existing.lineCount += 1;
      } else {
        groups.set(key, {
          taxType: li.tax.taxType,
          jurisdiction: li.tax.jurisdiction,
          label: li.tax.label,
          rate: li.tax.rate,
          taxableBase: postDiscount,
          taxAmount: li.taxAmountValue,
          inclusive: li.tax.inclusive ?? false,
          lineCount: 1,
        });
      }
    }

    return Array.from(groups.values());
  }

  /**
   * Full discount summary across all discounted line items.
   */
  discountSummary(): DiscountSummary {
    const lines = this.lineItems
      .filter((li) => li.hasDiscount)
      .map((li) => ({
        lineItemId: li.id,
        description: li.description,
        discountAmount: li.discountAmountValue,
        discountType: li.discount!.type,
        discountValue: li.discount!.value,
      }));

    return {
      totalDiscount: this.totals.discountTotalAmount,
      formattedDiscount: this.totals.discountTotal.format(),
      effectiveRate: this.totals.effectiveDiscountRate,
      lines,
    };
  }

  /**
   * Line items grouped by account code.
   * Useful for previewing how journal entry debits/credits will distribute
   * across revenue accounts before calling toJournalEntry().
   */
  lineItemsByAccountCode(context?: AccountingContext): LineItemsByAccount[] {
    const defaultRevenue =
      context?.accounts?.revenue ?? DEFAULT_ACCOUNTS.revenue;
    const groups = new Map<string, LineItem[]>();

    for (const li of this.lineItems) {
      const code = li.accountCode ?? defaultRevenue;
      groups.set(code, [...(groups.get(code) ?? []), li]);
    }

    return Array.from(groups.entries()).map(([accountCode, items]) => ({
      accountCode,
      lineItems: items,
      subtotal: items.reduce((s, li) => s + li.lineTotalAmount, 0),
    }));
  }

  /**
   * Outstanding amount due given an already-paid amount.
   *
   * @param paid - MajikMoney representing amount already paid
   * @throws {InvoiceValidationError} if currency mismatches or paid is invalid
   */
  amountDue(paid: MajikMoney): MajikMoney {
    if (!paid || !(paid instanceof MajikMoney)) {
      throw new InvoiceValidationError(
        "paid must be a MajikMoney instance",
        "paid",
      );
    }

    if (paid.currency.code !== this.currency) {
      throw new InvoiceValidationError(
        `Currency mismatch: invoice is ${this.currency}, paid is ${paid.currency.code}`,
        "paid",
      );
    }

    if (paid.isNegative()) {
      throw new InvoiceValidationError(
        "paid amount cannot be negative",
        "paid",
      );
    }

    return this.totals.grandTotal.subtract(paid, 0);
  }

  /**
   * Whether the invoice is fully paid given an amount paid.
   */
  isFullyPaid(paid: MajikMoney): boolean {
    return this.amountDue(paid).isZero();
  }

  /**
   * Convert all totals to a target currency using an FX rate.
   * Returns a plain FxTotals object — does NOT modify the invoice.
   *
   * @param rate - Conversion rate (units of target per 1 unit of invoice currency)
   * @param targetCurrency - ISO 4217 target currency code
   * @throws {InvoiceValidationError} if rate or currency is invalid
   */
  computeWithFxRate(rate: number, targetCurrency: CurrencyCode): FxTotals {
    if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) {
      throw new InvoiceValidationError(
        "FX rate must be a positive finite number",
        "rate",
      );
    }

    if (!targetCurrency || !/^[A-Z]{3}$/.test(targetCurrency)) {
      throw new InvoiceValidationError(
        "targetCurrency must be a valid ISO 4217 code (e.g. USD, EUR)",
        "targetCurrency",
      );
    }

    if (targetCurrency === this.currency) {
      throw new InvoiceValidationError(
        "targetCurrency must differ from the invoice currency",
        "targetCurrency",
      );
    }

    // MajikMoney.convert expects a CurrencyDefinition — provide a minimal one
    const targetDef = {
      code: targetCurrency,
      symbol: "",
      minorUnits: 2,
      name: targetCurrency,
    };
    const convert = (m: MajikMoney) => m.convert(rate, targetDef);

    const subtotal = convert(this.totals.subtotal);
    const discountTotal = convert(this.totals.discountTotal);
    const taxTotal = convert(this.totals.taxTotal);
    const grandTotal = convert(this.totals.grandTotal);

    return {
      targetCurrency,
      rate,
      subtotal: subtotal.toMajor(),
      discountTotal: discountTotal.toMajor(),
      taxTotal: taxTotal.toMajor(),
      grandTotal: grandTotal.toMajor(),
      formatted: {
        subtotal: subtotal.format(),
        discountTotal: discountTotal.format(),
        taxTotal: taxTotal.format(),
        grandTotal: grandTotal.format(),
      },
    };
  }

  // ==========================================================================
  // ── PROJECTION METHODS ─────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Project this invoice into a double-entry JournalEntry.
   *
   * Sale invoice:
   *   DR  Accounts Receivable  [grandTotal]
   *   CR  Revenue (per acct)   [lineTotal − discount]
   *   CR  Tax Payable          [taxTotal]  ← if tax present
   *
   * Credit note: entries are reversed.
   *
   * Always returns status: "draft" — never auto-posts.
   *
   * @throws {InvoiceProjectionError} if no line items or unbalanced
   */
  toJournalEntry(context?: AccountingContext): JournalEntry {
    if (this.lineItems.length === 0) {
      throw new InvoiceProjectionError(
        "Cannot project an invoice with no line items to a journal entry",
      );
    }

    if (!this.isBalanced()) {
      throw new InvoiceProjectionError(
        "Cannot project an unbalanced invoice to a journal entry",
      );
    }

    const accounts = { ...DEFAULT_ACCOUNTS, ...context?.accounts };
    const isCredit = this.isCreditNote;
    const lines: JournalLine[] = [];
    const grandTotal = this.totals.grandTotalAmount;

    // AR line
    lines.push({
      accountCode: accounts.receivable,
      accountName: "Accounts Receivable",
      debit: isCredit ? undefined : grandTotal,
      credit: isCredit ? grandTotal : undefined,
      memo: `Invoice ${this.invoiceNumber ?? this.id} — ${this.recipient.legalName}`,
    });

    // Revenue lines — grouped by account code
    const revenueByAccount = new Map<
      string,
      { name: string; amount: number }
    >();
    for (const li of this.lineItems) {
      const code = li.accountCode ?? accounts.revenue;
      const postDiscount = li.lineTotalAmount - li.discountAmountValue;
      const existing = revenueByAccount.get(code);
      if (existing) {
        existing.amount += postDiscount;
      } else {
        revenueByAccount.set(code, {
          name: li.accountCode ? `Revenue (${code})` : "Revenue",
          amount: postDiscount,
        });
      }
    }

    for (const [code, { name, amount }] of revenueByAccount) {
      lines.push({
        accountCode: code,
        accountName: name,
        debit: isCredit ? amount : undefined,
        credit: isCredit ? undefined : amount,
        memo: "Revenue from services/goods",
      });
    }

    // Tax Payable line
    if (this.totals.hasTax) {
      lines.push({
        accountCode: accounts.tax,
        accountName: "Tax Payable",
        debit: isCredit ? this.totals.taxTotalAmount : undefined,
        credit: isCredit ? undefined : this.totals.taxTotalAmount,
        memo: `Tax — ${this.taxTypes.join(", ")}`,
      });
    }

    // Balance assertion
    const totalDebits = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const totalCredits = lines.reduce((s, l) => s + (l.credit ?? 0), 0);

    if (Math.abs(totalDebits - totalCredits) > 0.01) {
      throw new InvoiceProjectionError(
        `Journal entry does not balance — debits: ${totalDebits.toFixed(2)}, ` +
          `credits: ${totalCredits.toFixed(2)}, ` +
          `difference: ${Math.abs(totalDebits - totalCredits).toFixed(2)}`,
      );
    }

    return {
      id: generateUUID(),
      date: this.issueDate,
      description:
        `${this.isCreditNote ? "Credit Note" : "Invoice"} — ` +
        `${this.invoiceNumber ?? this.id} — ${this.recipient.legalName}`,
      lines,
      sourceDocument: {
        type: "invoice",
        id: this.id,
        invoiceNumber: this.invoiceNumber,
      },
      status: "draft",
      period: this.period,
      metadata: { invoiceType: this.type, currency: this.currency },
    };
  }

  /**
   * Project this invoice into an Accounts Receivable sub-ledger entry.
   * Always returns status: "open".
   *
   * @throws {InvoiceProjectionError} if no line items
   */
  toSubLedgerEntry(): SubLedgerEntry {
    if (this.lineItems.length === 0) {
      throw new InvoiceProjectionError(
        "Cannot project an invoice with no line items to a sub-ledger entry",
      );
    }

    return {
      id: generateUUID(),
      type: "AR",
      partyId: this.recipient.tin ?? this.recipient.legalName,
      partyName: this.recipient.legalName,
      invoiceId: this.id,
      invoiceNumber: this.invoiceNumber,
      date: this.issueDate,
      dueDate: this.dueDate,
      balance: this.totals.grandTotalAmount,
      currency: this.currency,
      status: "open",
    };
  }

  // ==========================================================================
  // ── SERIALIZATION ──────────────────────────────────────────────────────────
  // ==========================================================================

  toMajikInvoiceInput(): MajikInvoiceInput {
    return {
      id: this.id,
      invoiceNumber: this.invoiceNumber,
      type: this.type,
      status: this.status,
      issuer: this.issuer,
      recipient: this.recipient,
      currency: this.currency,
      issueDate: this.issueDate,
      dueDate: this.dueDate,
      period: this.period,
      paymentTerms: this.paymentTerms,
      lineItems: this.lineItems.map((li) => ({
        id: li.id,
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice.toMajor(),
        unit: li.unit,
        tax: li.tax,
        discount: li.discount,
        accountCode: li.accountCode,
        costCenter: li.costCenter,
        tags: li.tags,
        metadata: li.metadata,
      })),
      defaultTax: this.defaultTax,
      references: this.references ? [...this.references] : undefined,
      notes: this.notes,
      tags: this.tags,
      metadata: this.metadata,
    };
  }

  toJSON(): GeneralInvoiceJSON {
    return {
      __type: "GeneralInvoice",
      version: this.version,
      id: this.id,
      invoiceNumber: this.invoiceNumber,
      type: this.type,
      status: this.status,
      issuer: this.issuer,
      recipient: this.recipient,
      currency: this.currency,
      issueDate: this.issueDate,
      dueDate: this.dueDate,
      period: this.period,
      paymentTerms: this.paymentTerms,
      lineItems: this.lineItems.map((li) => li.toJSON()),
      totals: this.totals.toJSON(),
      defaultTax: this.defaultTax,
      references: this.references ? [...this.references] : undefined,
      notes: this.notes,
      tags: this.tags,
      metadata: serializeMoney(this.metadata),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static fromJSON(json: GeneralInvoiceJSON): GeneralInvoice {
    if (json.__type !== "GeneralInvoice") {
      throw new InvoiceValidationError(
        `Expected __type "GeneralInvoice", got "${json.__type}"`,
      );
    }

    const lineItems = json.lineItems.map((liJson) =>
      LineItem.fromJSON(liJson, json.currency),
    );

    const totals = InvoiceTotals.fromLineItems(lineItems, json.currency);

    return new GeneralInvoice(
      {
        id: json.id,
        invoiceNumber: json.invoiceNumber,
        type: json.type,
        status: json.status,
        issuer: json.issuer,
        recipient: json.recipient,
        currency: json.currency,
        issueDate: json.issueDate,
        dueDate: json.dueDate,
        period: json.period,
        paymentTerms: json.paymentTerms,
        defaultTax: json.defaultTax,
        references: json.references,
        notes: json.notes,
        tags: json.tags,
        metadata: deserializeMoney(json.metadata),
        createdAt: json.createdAt,
        updatedAt: json.updatedAt,
      },
      lineItems,
      totals,
    );
  }

  // ==========================================================================
  // ── CANONICAL BYTES — for signing ──────────────────────────────────────────
  // ==========================================================================

  /**
   * Deterministic canonical bytes — used by MajikInvoice for hashing/signing.
   * Keys are sorted alphabetically to ensure consistency regardless of
   * object construction order.
   */
  toCanonicalBytes(): Uint8Array {
    const json = this.toJSON();
    const canonical = JSON.stringify(json, Object.keys(json).sort());
    return new TextEncoder().encode(canonical);
  }

  toCanonicalJSON(): string {
    const json = this.toJSON();
    return JSON.stringify(json, Object.keys(json).sort());
  }
}
