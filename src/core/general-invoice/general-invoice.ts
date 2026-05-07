/**
 * @file general-invoice.ts
 */

import {
  MajikMoney,
  serializeMoney,
  deserializeMoney,
} from "@thezelijah/majik-money";
import { LineItem } from "./line-item";
import { InvoiceTotals } from "./invoice-totals";
import { TaxManager } from "./tax-manager";
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
  ProofOfPayment,
  PaymentStatus,
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
import {
  buildCSVHeader,
  buildCSVRow,
  CSVColumn,
  CSVResolveContext,
  DEFAULT_CSV_COLUMNS,
} from "../csv-export";
import { encoder, sha256Hex } from "../crypto-utils";

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
  /** Invoice-level default taxes — applied to any line item with no own taxes */
  readonly defaultTaxes: TaxManager;

  // ── Settlement ────────────────────────────────────────────────────────────
  readonly proofOfPayments: readonly ProofOfPayment[];

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
    payment: ProofOfPayment[] = [],
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

    this.proofOfPayments = Object.freeze([...(payment ?? [])]);

    // Always store as TaxManager — coerce whatever came in
    this.defaultTaxes = TaxManager.coerce(input.defaultTaxes);
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

  private rebuild(
    overrides: Partial<InvoiceInternalState>,
    lineItems?: LineItem[],
    payments?: ProofOfPayment[], // ← new optional arg
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
        defaultTaxes: this.defaultTaxes.toArray(),
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
      payments ?? [...this.proofOfPayments],
    );
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  private assertEditable(operation: string): void {
    if (this.status === "void") {
      throw new InvoiceMutationError(
        `Cannot ${operation} on a voided invoice (id: ${this.id}). ` +
          `Voided invoices are immutable.`,
      );
    }
  }

  private assertDraft(operation: string): void {
    if (this.status !== "draft") {
      throw new InvoiceMutationError(
        `Cannot ${operation} on an invoice with status "${this.status}". ` +
          `Structural changes are only allowed on draft invoices.`,
      );
    }
  }

  // ── Static factory ────────────────────────────────────────────────────────

  static create(input: GeneralInvoiceInput): GeneralInvoice {
    GeneralInvoice.assertValid(input);

    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    // Resolve invoice-level default taxes once
    const invoiceDefaultTaxes = TaxManager.coerce(input.defaultTaxes);

    const lineItems = input.lineItems.map((li) => {
      // Line item's own taxes take priority; fall back to invoice default
      const ownTaxes = TaxManager.coerce(li.taxes ?? li.taxes);
      const resolved = TaxManager.resolve(ownTaxes, invoiceDefaultTaxes);
      return LineItem.create(
        { ...li, taxes: resolved.toArray() },
        input.currency,
        resolved,
      );
    });

    const totals = InvoiceTotals.fromLineItems(lineItems, input.currency);

    return new GeneralInvoice(
      {
        ...input,
        id: input.id ?? generateUUID(),
        type: input.type ?? "commercial",
        status: input.status ?? "draft",
        issueDate: input.issueDate ?? today,
        defaultTaxes: invoiceDefaultTaxes.toArray(),
        createdAt: now,
        updatedAt: now,
      },
      lineItems,
      totals,
    );
  }

  // ── Internal helper — rebuild a line item preserving its own overrides ────

  private rebuildLineItem(li: LineItem, taxOverride?: TaxManager): LineItem {
    return LineItem.create(
      {
        id: li.id,
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice.toMajor(),
        unit: li.unit,
        taxes: taxOverride?.toArray() ?? li.taxes.toArray(),
        discount: li.discount,
        accountCode: li.accountCode,
        costCenter: li.costCenter,
        tags: li.tags,
        metadata: li.metadata,
      },
      this.currency,
      taxOverride,
    );
  }

  // ==========================================================================
  // ── WITH* MUTATION METHODS ─────────────────────────────────────────────────
  // ==========================================================================

  // ── Identity & metadata (unchanged — omitted for brevity) ─────────────────
  // withInvoiceNumber, withStatus, withNotes, withoutNotes, withTags,
  // withTag, withoutTag, withMetadata, withMetadataReplaced, withoutMetadata
  // — all identical to prior version, no tax involvement

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

  withNotes(notes: string): GeneralInvoice {
    this.assertEditable("set notes");
    if (typeof notes !== "string") {
      throw new InvoiceValidationError("Notes must be a string", "notes");
    }
    return this.rebuild({ notes: notes.trim() });
  }

  private _appendNotes(note: string): GeneralInvoice {
    const trimmed = note.trim();
    if (!trimmed) return this;

    const existing = this.notes?.trim();

    const notes = existing ? `${existing}\n\n${trimmed}` : trimmed;

    return this.withNotes(notes);
  }

  withoutNotes(): GeneralInvoice {
    this.assertEditable("clear notes");
    return this.rebuild({ notes: undefined });
  }

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

  withoutTag(tag: string): GeneralInvoice {
    this.assertEditable("remove tag");
    return this.rebuild({
      tags: (this.tags ?? []).filter((t) => t !== tag.trim()),
    });
  }

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
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return this.rebuild({ metadata: merged });
  }

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

  withoutMetadata(): GeneralInvoice {
    this.assertEditable("clear metadata");
    return this.rebuild({ metadata: undefined });
  }

  // ─────────────────────────────────────────────
  // ── STATUS UPDATE ─────────────────────────────
  // ─────────────────────────────────────────────

  issue(): GeneralInvoice {
    return this.withStatus("issued");
  }

  send(): GeneralInvoice {
    return this.withStatus("sent");
  }

  view(): GeneralInvoice {
    return this.withStatus("viewed");
  }

  markAsPaid(): GeneralInvoice {
    return this.withStatus("paid");
  }

  markAsPartiallyPaid(): GeneralInvoice {
    return this.withStatus("partial");
  }

  markAsOverdue(force = false): GeneralInvoice {
    if (!force && !this.isOverdue) {
      throw new InvoiceLifecycleError(
        "Cannot mark as overdue before due date has passed",
        this.status,
        "overdue",
      );
    }

    // NOTE: may still fail if transition isn't allowed
    return this.withStatus("overdue");
  }

  dispute(reason?: string): GeneralInvoice {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) return this.withStatus("disputed");

    return this.withStatus("disputed")._appendNotes(
      `DISPUTE REASON: ${trimmedReason}`,
    );
  }

  resolveDispute(reason?: string): GeneralInvoice {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) return this.withStatus("issued");

    return this.withStatus("issued")._appendNotes(
      `RESOLUTION: ${trimmedReason}`,
    );
  }

  voidInvoice(reason?: string): GeneralInvoice {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) return this.withStatus("void");

    return this.withStatus("void")._appendNotes(
      `VOID REASON: ${trimmedReason}`,
    );
  }
  // ── Dates & terms (unchanged) ─────────────────────────────────────────────

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

  withoutDueDate(): GeneralInvoice {
    this.assertEditable("remove due date");
    return this.rebuild({ dueDate: undefined });
  }

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

  withoutPeriod(): GeneralInvoice {
    this.assertDraft("remove period");
    return this.rebuild({ period: undefined });
  }

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

  // ── References (unchanged) ────────────────────────────────────────────────

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

  withoutReference(type: string, number: string): GeneralInvoice {
    this.assertEditable("remove reference");
    return this.rebuild({
      references: (this.references ?? []).filter(
        (r) => !(r.type === type && r.number === number),
      ),
    });
  }

  withoutReferences(): GeneralInvoice {
    this.assertEditable("clear references");
    return this.rebuild({ references: undefined });
  }

  // ── Line item mutations ───────────────────────────────────────────────────

  withLineItem(input: LineItemInput): GeneralInvoice {
    this.assertDraft("add line item");
    const ownTaxes = TaxManager.coerce(input.taxes ?? input.taxes);
    const resolved = TaxManager.resolve(ownTaxes, this.defaultTaxes);
    const lineItem = LineItem.create(
      { ...input, taxes: resolved.toArray() },
      this.currency,
    );
    return this.rebuild({}, [...this.lineItems, lineItem]);
  }

  withLineItems(inputs: LineItemInput[]): GeneralInvoice {
    this.assertDraft("replace line items");
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new InvoiceValidationError(
        "At least one line item is required",
        "lineItems",
      );
    }
    const lineItems = inputs.map((li) => {
      const ownTaxes = TaxManager.coerce(li.taxes ?? li.taxes);
      const resolved = TaxManager.resolve(ownTaxes, this.defaultTaxes);
      return LineItem.create(
        { ...li, taxes: resolved.toArray() },
        this.currency,
      );
    });
    return this.rebuild({}, lineItems);
  }

  withoutLineItem(id: string): GeneralInvoice {
    this.assertDraft("remove line item");
    if (!id || id.trim().length === 0) {
      throw new InvoiceValidationError(
        "Line item id is required",
        "lineItemId",
      );
    }
    if (!this.lineItems.some((li) => li.id === id)) {
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

    // Resolve taxes for the patched item
    let resolvedTaxes: TaxManager;
    if ("taxes" in patch || "tax" in patch) {
      const ownTaxes = TaxManager.coerce(patch.taxes ?? patch.taxes);
      resolvedTaxes = TaxManager.resolve(ownTaxes, this.defaultTaxes);
    } else {
      // Keep existing taxes — already resolved when first created
      resolvedTaxes = existing.taxes;
    }

    const mergedInput: LineItemInput = {
      id: existing.id,
      description: patch.description ?? existing.description,
      quantity: patch.quantity ?? existing.quantity,
      unitPrice: patch.unitPrice ?? existing.unitPrice.toMajor(),
      unit: "unit" in patch ? patch.unit : existing.unit,
      taxes: resolvedTaxes.toArray(),
      discount: "discount" in patch ? patch.discount : existing.discount,
      accountCode:
        "accountCode" in patch ? patch.accountCode : existing.accountCode,
      costCenter:
        "costCenter" in patch ? patch.costCenter : existing.costCenter,
      tags: "tags" in patch ? patch.tags : existing.tags,
      metadata: "metadata" in patch ? patch.metadata : existing.metadata,
    };

    const updatedItem = LineItem.create(mergedInput, this.currency);
    return this.rebuild(
      {},
      this.lineItems.map((li) => (li.id === id ? updatedItem : li)),
    );
  }

  withClearedLineItems(): GeneralInvoice {
    this.assertDraft("clear line items");
    return this.rebuild({}, []);
  }

  // ── Default tax mutations ─────────────────────────────────────────────────

  /**
   * Replace the invoice-level default taxes entirely.
   * Line items that were inheriting the old default are re-resolved to the new one.
   * Line items with their own explicitly set taxes are untouched.
   */
  withDefaultTaxes(
    taxes: TaxDetail | TaxDetail[] | TaxManager,
  ): GeneralInvoice {
    this.assertDraft("set default taxes");
    const newDefault = TaxManager.coerce(taxes);

    const items = this.lineItems.map((li) => {
      // A line item is "inheriting" if its taxes equal the old default.
      // We detect this by reference equality on the TaxManager or by
      // checking if the line has no independently set taxes.
      // The safest signal: if li.taxes === this.defaultTaxes (same instance),
      // it was set by inheritance and should be re-resolved.
      const isInheriting = li.taxes === this.defaultTaxes || li.taxes.isEmpty;
      if (!isInheriting) return li;
      return this.rebuildLineItem(li, newDefault);
    });

    return this.rebuild({ defaultTaxes: newDefault.toArray() }, items);
  }

  withoutDefaultTaxes(): GeneralInvoice {
    this.assertDraft("remove default taxes");

    const items = this.lineItems.map((li) => {
      const isInheriting = li.taxes === this.defaultTaxes || li.taxes.isEmpty;
      if (!isInheriting) return li;
      return this.rebuildLineItem(li, TaxManager.none());
    });

    return this.rebuild({ defaultTaxes: TaxManager.none().toArray() }, items);
  }

  // ── Per-line-item tax mutations ───────────────────────────────────────────

  /**
   * Set taxes on a specific line item.
   * Accepts TaxDetail, TaxDetail[], or TaxManager.
   */
  withTaxesOnLineItem(
    lineItemId: string,
    taxes: TaxDetail | TaxDetail[] | TaxManager,
  ): GeneralInvoice {
    this.assertDraft("set taxes on line item");
    if (!this.lineItems.some((li) => li.id === lineItemId)) {
      throw new InvoiceValidationError(
        `Line item with id "${lineItemId}" not found`,
        "lineItemId",
      );
    }
    return this.withUpdatedLineItem(lineItemId, {
      taxes: TaxManager.coerce(taxes).toArray(),
    });
  }

  /**
   * Set the same taxes on every line item.
   * Replaces all existing per-line taxes.
   */
  withTaxesOnAllLineItems(
    taxes: TaxDetail | TaxDetail[] | TaxManager,
  ): GeneralInvoice {
    this.assertDraft("set taxes on all line items");
    const tm = TaxManager.coerce(taxes);
    const items = this.lineItems.map((li) => this.rebuildLineItem(li, tm));
    return this.rebuild({}, items);
  }

  /** Remove all taxes from a specific line item */
  withoutTaxesOnLineItem(lineItemId: string): GeneralInvoice {
    this.assertDraft("remove taxes from line item");
    if (!this.lineItems.some((li) => li.id === lineItemId)) {
      throw new InvoiceValidationError(
        `Line item with id "${lineItemId}" not found`,
        "lineItemId",
      );
    }
    return this.withUpdatedLineItem(lineItemId, {
      taxes: TaxManager.none().toArray(),
    });
  }

  /** Remove all taxes from every line item */
  withoutTaxesOnAllLineItems(): GeneralInvoice {
    this.assertDraft("remove taxes from all line items");
    const items = this.lineItems.map((li) =>
      this.rebuildLineItem(li, TaxManager.none()),
    );
    return this.rebuild({}, items);
  }

  // ── Tax inclusivity toggles ───────────────────────────────────────────────

  /**
   * Set matching taxes to inclusive (tax embedded in unit price) on all lines.
   * @param taxType - optional filter; omit to affect all additive taxes
   */
  withInclusiveTax(taxType?: string): GeneralInvoice {
    this.assertDraft("set inclusive tax");
    return this._toggleTaxInclusivity(true, taxType);
  }

  /**
   * Set matching taxes to exclusive (tax added on top) on all lines.
   * @param taxType - optional filter; omit to affect all additive taxes
   */
  withExclusiveTax(taxType?: string): GeneralInvoice {
    this.assertDraft("set exclusive tax");
    return this._toggleTaxInclusivity(false, taxType);
  }

  private _toggleTaxInclusivity(
    inclusive: boolean,
    taxType?: string,
  ): GeneralInvoice {
    const items = this.lineItems.map((li) => {
      const updated = li.taxes.withInclusivity(inclusive, taxType);
      // Skip rebuild if nothing changed
      if (updated === li.taxes) return li;
      return this.rebuildLineItem(li, updated);
    });

    const updatedDefault = this.defaultTaxes.withInclusivity(
      inclusive,
      taxType,
    );
    return this.rebuild({ defaultTaxes: updatedDefault.toArray() }, items);
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
        message: "Country must be a valid ISO 3166-1 alpha-2 code",
      });
    }

    if (
      input.recipient?.address?.country &&
      !/^[A-Z]{2}$/.test(input.recipient.address.country)
    ) {
      errors.push({
        field: "recipient.address.country",
        message: "Country must be a valid ISO 3166-1 alpha-2 code",
      });
    }

    const rawDefault = input.defaultTaxes;
    if (rawDefault && !(rawDefault instanceof TaxManager)) {
      const arr = Array.isArray(rawDefault) ? rawDefault : [rawDefault];
      arr.forEach((t, i) => {
        try {
          TaxManager.assertValidTax(t, `defaultTaxes[${i}]`);
        } catch (e: any) {
          errors.push({
            field: e.field ?? `defaultTaxes[${i}]`,
            message: e.message,
          });
        }
      });
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

  get isDisputed(): boolean {
    return this.status === "disputed";
  }

  get isVoided(): boolean {
    return this.status === "void";
  }

  get isSent(): boolean {
    return this.status === "sent";
  }

  get isViewed(): boolean {
    return this.status === "viewed";
  }

  get formattedTotal(): string {
    return this.totals.grandTotal.format();
  }
  get totalAmount(): number {
    return this.totals.grandTotalAmount;
  }
  get taxAmount(): number {
    return this.totals.taxTotalAmount;
  }
  get withholdingAmount(): number {
    return this.totals.withholdingTotalAmount;
  }
  get netPayableAmount(): number {
    return this.totals.netPayableAmount;
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
  } // fixed: was "taxes"
  get hasTax(): boolean {
    return this.totals.hasTax;
  }
  get hasWithholding(): boolean {
    return this.totals.hasWithholding;
  }
  get hasDiscount(): boolean {
    return this.totals.hasDiscount;
  }

  get isOverdue(): boolean {
    if (!this.dueDate) return false;
    if (["void", "paid", "disputed"].includes(this.status)) return false;
    const totalPaid = this.proofOfPayments.reduce((s, p) => s + p.amount, 0);
    if (totalPaid >= this.totals.netPayableAmount) return false;
    return new Date().toISOString().slice(0, 10) > this.dueDate;
  }

  get effectiveStatus(): InvoiceStatus {
    return this.isOverdue ? "overdue" : this.status;
  }

  /** All unique tax types across all line items (additive + withholding) */
  get taxTypes(): string[] {
    return [...new Set(this.lineItems.flatMap((li) => li.taxes.taxTypes))];
  }

  /** All unique additive tax types (those that appear on the invoice as tax charged) */
  get additiveTaxTypes(): string[] {
    return [
      ...new Set(
        this.lineItems.flatMap((li) => li.taxes.additive.map((t) => t.taxType)),
      ),
    ];
  }

  /** All unique withholding tax types */
  get withholdingTaxTypes(): string[] {
    return [
      ...new Set(
        this.lineItems.flatMap((li) =>
          li.taxes.withholding.map((t) => t.taxType),
        ),
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
  // ── PAYMENT AND SETTLEMENT METHODS ─────────────────────────────────────────────────────
  // ==========================================================================

  get paymentStatus(): PaymentStatus {
    if (this.isFullyPaid) return "settled";
    if (this.totalPaid.isPositive()) return "partially_paid";
    return "pending";
  }

  get totalPaid(): MajikMoney {
    return this.proofOfPayments.reduce(
      (sum, p) => sum.add(MajikMoney.fromMajor(p.amount, this.currency)),
      MajikMoney.zero(this.currency),
    );
  }

  get amountDue(): MajikMoney {
    return this.totals.netPayable.subtract(this.totalPaid);
  }

  get isFullyPaid(): boolean {
    return this.amountDue.isZero();
  }

  addPayment(proof: ProofOfPayment): GeneralInvoice {
    this.assertEditable("add payment");

    if (!proof.id) {
      throw new InvoiceValidationError("Proof must have an id", "proof.id");
    }

    return this._setPayments([...this.proofOfPayments, proof]);
  }

  removePayment(paymentId: string): GeneralInvoice {
    this.assertEditable("remove payment");

    if (!paymentId || paymentId.trim().length === 0) {
      throw new InvoiceValidationError("paymentId is required", "paymentId");
    }

    if (!this.proofOfPayments.some((p) => p.id === paymentId)) {
      throw new InvoiceValidationError(
        `Payment with id "${paymentId}" not found`,
        "paymentId",
      );
    }

    const remaining = this.proofOfPayments.filter((p) => p.id !== paymentId);

    return this._setPayments(remaining);
  }

  clearPayments(): GeneralInvoice {
    this.assertEditable("clear payments");
    return this._setPayments([]);
  }

  private _setPayments(payments: ProofOfPayment[]): GeneralInvoice {
    // ── Normalize / sort ───────────────────────
    const sorted = [...payments].sort((a, b) =>
      a.settledAt.localeCompare(b.settledAt),
    );

    // ── Validate duplicates ────────────────────
    const ids = new Set<string>();
    for (const p of sorted) {
      if (ids.has(p.id)) {
        throw new InvoiceValidationError("Duplicate proof id", "proof.id");
      }
      ids.add(p.id);

      if (p.amount <= 0) {
        throw new InvoiceValidationError(
          "Payment must be greater than 0",
          "proof.amount",
        );
      }

      if (p.currency !== this.currency) {
        throw new InvoiceValidationError(
          `Payment currency (${p.currency}) must match invoice currency (${this.currency})`,
          "proof.currency",
        );
      }
    }

    // ── Rebuild ────────────────────────────────
    const updated = this.rebuild({}, undefined, sorted);

    const paid = updated.totalPaid;
    const total = updated.totals.netPayable;
    const due = updated.amountDue;

    // ── Prevent overpayment ────────────────────
    if (paid.greaterThan(total)) {
      throw new InvoiceValidationError("Overpayment not allowed");
    }

    // ── Resolve status ─────────────────────────
    if (due.isZero()) {
      return updated.withStatus("paid");
    }

    if (paid.greaterThan(MajikMoney.zero(this.currency))) {
      return updated.withStatus("partial");
    }

    // fallback: unpaid state
    return updated;
  }

  // ==========================================================================
  // ── CALCULATION & ANALYSIS ─────────────────────────────────────────────────
  // ==========================================================================

  isBalanced(): boolean {
    if (this.lineItems.length === 0) return false;
    const lineSum = this.lineItems.reduce((s, li) => s + li.netTotalAmount, 0);
    return Math.abs(lineSum - this.totals.grandTotalAmount) < 0.01;
  }

  canTransitionTo(to: InvoiceStatus): boolean {
    return ALLOWED_TRANSITIONS[this.status].includes(to);
  }

  allowedTransitions(): InvoiceStatus[] {
    return [...ALLOWED_TRANSITIONS[this.status]];
  }

  /** Sum of additive tax amounts for a given taxType across all line items */
  taxTotalByType(taxType: string): number {
    if (!taxType?.trim()) {
      throw new InvoiceValidationError("taxType is required", "taxType");
    }
    return this.lineItems.reduce((sum, li) => {
      const tax = li.taxes.getByType(taxType);
      if (!tax || (tax.behaviour ?? "additive") !== "additive") return sum;
      // Reuse the already-computed per-line additive amount for this type
      // We need per-tax-type amounts from LineItem — see note below
      return sum + li.taxAmountByType(taxType);
    }, 0);
  }

  /** Sum of withholding amounts for a given taxType across all line items */
  withholdingTotalByType(taxType: string): number {
    if (!taxType?.trim()) {
      throw new InvoiceValidationError("taxType is required", "taxType");
    }
    return this.lineItems.reduce((sum, li) => {
      return sum + li.withholdingAmountByType(taxType);
    }, 0);
  }

  subtotalByCostCenter(costCenter: string): number {
    if (!costCenter?.trim()) {
      throw new InvoiceValidationError("costCenter is required", "costCenter");
    }
    return this.lineItems
      .filter((li) => li.costCenter === costCenter)
      .reduce((s, li) => s + li.lineTotalAmount, 0);
  }

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

  taxBreakdown(): TaxBreakdownEntry[] {
    const groups = new Map<string, TaxBreakdownEntry>();

    for (const li of this.lineItems) {
      const postDiscount = li.lineTotalAmount - li.discountAmountValue;

      // Pre-calculate the total inclusive tax on this line once for withholding base logic
      const totalInclusiveTax = li.taxes.additive
        .filter((t) => t.inclusive)
        .reduce((sum, t) => sum + li.taxAmountByType(t.taxType), 0);

      for (const tax of li.taxes.all) {
        if ((tax.behaviour ?? "additive") === "informational") continue;

        const taxAmount =
          tax.behaviour === "withholding"
            ? li.withholdingAmountByType(tax.taxType)
            : li.taxAmountByType(tax.taxType);

        let trueTaxableBase = postDiscount;

        if ((tax.behaviour ?? "additive") === "additive" && tax.inclusive) {
          // Base for an inclusive tax is the price excluding that tax
          trueTaxableBase = postDiscount - taxAmount;
        } else if ((tax.behaviour ?? "additive") === "withholding") {
          // Base for withholding is the price excluding ALL inclusive VAT/taxes
          trueTaxableBase = postDiscount - totalInclusiveTax;
        }

        const key = [
          tax.taxType,
          tax.jurisdiction ?? "",
          tax.behaviour ?? "additive",
          String(tax.inclusive ?? false),
        ].join("::");

        const existing = groups.get(key);
        if (existing) {
          existing.taxableBase += trueTaxableBase;
          existing.taxAmount += taxAmount;
          existing.lineCount += 1;
        } else {
          groups.set(key, {
            taxType: tax.taxType,
            jurisdiction: tax.jurisdiction,
            label: tax.label,
            rate: tax.rate,
            behaviour: tax.behaviour ?? "additive",
            taxableBase: trueTaxableBase,
            taxAmount,
            inclusive: tax.inclusive ?? false,
            lineCount: 1,
          });
        }
      }
    }

    return Array.from(groups.values());
  }

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

  computeWithFxRate(rate: number, targetCurrency: CurrencyCode): FxTotals {
    if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) {
      throw new InvoiceValidationError(
        "FX rate must be a positive finite number",
        "rate",
      );
    }
    if (!targetCurrency || !/^[A-Z]{3}$/.test(targetCurrency)) {
      throw new InvoiceValidationError(
        "targetCurrency must be a valid ISO 4217 code",
        "targetCurrency",
      );
    }
    if (targetCurrency === this.currency) {
      throw new InvoiceValidationError(
        "targetCurrency must differ from the invoice currency",
        "targetCurrency",
      );
    }
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

    // Dr Accounts Receivable (full invoice amount including VAT)
    lines.push({
      accountCode: accounts.receivable,
      accountName: "Accounts Receivable",
      debit: isCredit ? undefined : grandTotal,
      credit: isCredit ? grandTotal : undefined,
      memo: `Invoice ${this.invoiceNumber ?? this.id} — ${this.recipient.legalName}`,
    });

    // Cr Revenue (post-discount, pre-tax)
    const revenueByAccount = new Map<
      string,
      { name: string; amount: number }
    >();

    for (const li of this.lineItems) {
      const code = li.accountCode ?? accounts.revenue;

      // Changed: Subtract additive taxes to get true net revenue
      const revenueAmount = li.netTotalAmount - li.additiveTaxAmountValue;

      const existing = revenueByAccount.get(code);
      if (existing) {
        existing.amount += revenueAmount;
      } else {
        revenueByAccount.set(code, {
          name: li.accountCode ? `Revenue (${code})` : "Revenue",
          amount: revenueAmount,
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

    // Cr VAT Payable (additive taxes only)
    if (this.totals.hasTax) {
      lines.push({
        accountCode: accounts.tax, // fixed: was accounts.taxes
        accountName: "Tax Payable",
        debit: isCredit ? this.totals.taxTotalAmount : undefined,
        credit: isCredit ? undefined : this.totals.taxTotalAmount,
        memo: `Tax — ${this.additiveTaxTypes.join(", ")}`,
      });
    }

    // NOTE on withholding: EWT is NOT journalised on the invoice itself.
    // The buyer withholds and issues BIR Form 2307. The seller journals it
    // only upon receipt of 2307: Dr CWT Receivable / Cr Income Tax Payable.
    // That entry belongs in a payment receipt handler, not here.

    const totalDebits = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const totalCredits = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    if (Math.abs(totalDebits - totalCredits) > 0.01) {
      throw new InvoiceProjectionError(
        `Journal entry does not balance — debits: ${totalDebits.toFixed(2)}, ` +
          `credits: ${totalCredits.toFixed(2)}, diff: ${Math.abs(totalDebits - totalCredits).toFixed(2)}`,
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
        taxes: li.taxes.toArray(),
        discount: li.discount,
        accountCode: li.accountCode,
        costCenter: li.costCenter,
        tags: li.tags,
        metadata: li.metadata,
      })),
      defaultTaxes: this.defaultTaxes.toArray(),
      references: this.references ? [...this.references] : undefined,
      notes: this.notes,
      tags: this.tags,
      metadata: this.metadata,
    };
  }

  toJSON(): GeneralInvoiceJSON {
    return {
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
      proofOfPayments: [...this.proofOfPayments],
      defaultTaxes: this.defaultTaxes.toArray(),
      references: this.references ? [...this.references] : undefined,
      notes: this.notes,
      tags: this.tags,
      metadata: serializeMoney(this.metadata),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static fromJSON(json: GeneralInvoiceJSON): GeneralInvoice {
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
        defaultTaxes: TaxManager.fromMany(json.defaultTaxes ?? []).toArray(),
        references: json.references,
        notes: json.notes,
        tags: json.tags,
        metadata: deserializeMoney(json.metadata),
        createdAt: json.createdAt,
        updatedAt: json.updatedAt,
        proofOfPayments: json.proofOfPayments ?? [],
      },
      lineItems,
      totals,
      json.proofOfPayments,
    );
  }

  // ==========================================================================
  // ── CANONICAL BYTES — for signing ──────────────────────────────────────────
  // ==========================================================================

  /**
   * Returns the subset of invoice fields that form the cryptographic commitment.
   *
   * Excluded intentionally:
   *   - version      — schema bumps must not invalidate old signatures
   *   - status       — lifecycle transitions (draft → issued → paid) are post-signing
   *   - notes        — can be amended by either party (dispute reasons, etc.)
   *   - tags         — organisational metadata, not a financial term
   *   - metadata     — arbitrary key-value bag, not a financial term
   *   - proofOfPayments — added by payer after signing
   *   - createdAt / updatedAt — timestamps drift across serialization roundtrips
   */
  private toSignableJSON(): object {
    return {
      id: this.id,
      invoiceNumber: this.invoiceNumber,
      type: this.type,
      issuer: this.issuer,
      recipient: this.recipient,
      currency: this.currency,
      issueDate: this.issueDate,
      dueDate: this.dueDate,
      period: this.period,
      paymentTerms: this.paymentTerms,
      lineItems: this.lineItems.map((li) => li.toJSON()),
      defaultTaxes: this.defaultTaxes.toArray(),
      references: this.references ? [...this.references] : undefined,
    };
  }

  // ── Update toCanonicalBytes() and toCanonicalJSON() ────────────────────────

  private _canonicalBytes?: Uint8Array;
  private _canonicalJSON?: string;
  private _canonicalHash?: string;

  toCanonicalBytes(): Uint8Array {
    if (this._canonicalBytes) return this._canonicalBytes;
    const json = this.toSignableJSON();
    const canonical = JSON.stringify(json, Object.keys(json).sort());
    this._canonicalJSON = canonical;
    this._canonicalBytes = encoder.encode(canonical);
    return this._canonicalBytes;
  }

  toCanonicalJSON(): string {
    if (this._canonicalJSON) return this._canonicalJSON;
    const json = this.toSignableJSON();
    this._canonicalJSON = JSON.stringify(json, Object.keys(json).sort());
    return this._canonicalJSON;
  }

  toCanonicalHash(): string {
    if (this._canonicalHash) return this._canonicalHash;
    this._canonicalHash = sha256Hex(this.toCanonicalBytes());
    return this._canonicalHash;
  }

  // ==========================================================================
  // ── CSV EXPORT — add inside the GeneralInvoice class body ──────────────────
  // ==========================================================================

  // Add this import at the top of general-invoice.ts:
  //
  //   import {
  //     CSVColumn,
  //     CSVResolveContext,
  //     DEFAULT_CSV_COLUMNS,
  //     buildCSVHeader,
  //     buildCSVRow,
  //   } from "./csv-export";

  /**
   * Export this invoice as a CSV string.
   *
   * Includes a header row followed by a single data row.
   * For multi-invoice export use `MajikInvoice.batchExportToCSV()` instead —
   * that method writes one header row followed by one row per invoice.
   *
   * @param columns - Columns to include. Defaults to DEFAULT_CSV_COLUMNS.
   *
   * @example — defaults
   * const csv = invoice.toCSV();
   *
   * @example — custom columns
   * import { ALL_CSV_COLUMNS, buildTaxBreakdownColumns } from "./csv-export";
   * const csv = invoice.toCSV([
   *   ...ALL_CSV_COLUMNS,
   *   ...buildTaxBreakdownColumns(["VAT", "EWT"]),
   * ]);
   */
  toCSV(columns: CSVColumn[] = DEFAULT_CSV_COLUMNS): string {
    const ctx: CSVResolveContext = {
      invoice: this,
      invoiceId: this.id,
    };

    const header = buildCSVHeader(columns);
    const row = buildCSVRow(ctx, columns);
    return `${header}\n${row}`;
  }

  /**
   * Export only the data row (no header).
   * Used internally by MajikInvoice.batchExportToCSV() to assemble
   * a multi-row file with a single shared header.
   *
   * @internal
   */
  toCSVRow(columns: CSVColumn[] = DEFAULT_CSV_COLUMNS): string {
    const ctx: CSVResolveContext = {
      invoice: this,
      invoiceId: this.id,
    };
    return buildCSVRow(ctx, columns);
  }
}
