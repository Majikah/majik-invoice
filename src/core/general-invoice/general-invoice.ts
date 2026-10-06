/**
 * @file general-invoice.ts
 */

import {
  MajikMoney,
  serializeMoney,
  deserializeMoney,
  CurrencyDefinition,
  CURRENCIES,
} from "@thezelijah/majik-money";
import { LineItem } from "./line-item.js";
import { InvoiceTotals } from "./invoice-totals.js";
import { TaxManager } from "./tax-manager.js";
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
} from "./types.js";
import { canonicalize, generateUUID } from "./utils.js";
import {
  InvoiceLifecycleError,
  InvoiceMutationError,
  InvoiceProjectionError,
  InvoiceValidationError,
} from "./errors.js";
import {
  ALLOWED_TRANSITIONS,
  DEFAULT_ACCOUNTS,
  SCHEMA_VERSION,
} from "./constants.js";
import { MajikInvoiceInput } from "../types.js";
import {
  buildCSVHeader,
  buildCSVRow,
  CSVColumn,
  CSVResolveContext,
  DEFAULT_CSV_COLUMNS,
} from "../csv-export.js";
import { encoder, sha256Hex } from "../crypto-utils.js";

/**
 * Domain aggregate representing a complete invoice document.
 *
 * `GeneralInvoice` is the top-level invoice model that brings together:
 *
 * - issuer and recipient parties
 * - invoice identity and lifecycle status
 * - issue/due dates and payment terms
 * - line items and invoice totals
 * - invoice-level default taxes
 * - proof of payments and settlement state
 * - references, notes, tags, and metadata
 * - accounting and sub-ledger projections
 * - foreign-exchange analysis
 * - JSON and CSV serialization
 * - canonical representations for cryptographic signing
 *
 * ### Value-oriented API
 *
 * Structural changes are performed through `with*`, `without*`, payment,
 * tax, and lifecycle methods. These methods return a rebuilt `GeneralInvoice`
 * rather than modifying the current invoice instance in place.
 *
 * ### Lifecycle
 *
 * An invoice carries an explicit `InvoiceStatus`. Lifecycle transitions are
 * controlled by {@link ALLOWED_TRANSITIONS} and can also be inspected through
 * {@link GeneralInvoice.canTransitionTo} and
 * {@link GeneralInvoice.allowedTransitions}.
 *
 * ### Draft restrictions
 *
 * Structural invoice changes such as adding/removing line items and changing
 * default taxes are restricted to draft invoices.
 *
 * Other editable fields may remain changeable after issuance unless the
 * invoice has been voided.
 *
 * ### Tax model
 *
 * Each line item has a resolved {@link TaxManager}. A line item may use its
 * own explicit taxes or inherit the invoice's {@link defaultTaxes}.
 *
 * Additive taxes contribute to invoice totals, while withholding taxes are
 * tracked separately and reduce the final amount actually remitted by the
 * buyer.
 *
 * ### Monetary model
 *
 * All authoritative monetary values are represented by {@link MajikMoney}.
 * Numeric getters are convenience projections into major currency units.
 *
 * ### Signing model
 *
 * The canonical representation intentionally includes only fields considered
 * part of the invoice's signable financial/document commitment. Lifecycle,
 * operational, and post-signing fields such as status, notes, tags, metadata,
 * payments, and timestamps are excluded from the canonical payload.
 *
 * @example
 * ```ts
 * const invoice = GeneralInvoice.create({
 *   issuer: {
 *     legalName: "Majikah Solutions OPC",
 *   },
 *   recipient: {
 *     legalName: "Example Client",
 *   },
 *   currency: "PHP",
 *   lineItems: [
 *     {
 *       description: "Software Development",
 *       quantity: 1,
 *       unitPrice: 50000,
 *     },
 *   ],
 * });
 *
 * console.log(invoice.invoiceNumber);
 * console.log(invoice.totals.grandTotalAmount);
 * console.log(invoice.effectiveStatus);
 * ```
 */
export class GeneralInvoice {
  // ── Identity ──────────────────────────────────────────────────────────────

  /**
   * Stable unique identifier for this invoice.
   *
   * Generated automatically when not supplied during creation.
   */
  readonly id: string;

  /**
   * Human-facing invoice number.
   *
   * Unlike `id`, this is optional and is intended for customer-facing
   * documents and accounting references.
   */
  readonly invoiceNumber?: string;

  /**
   * Semantic invoice document type.
   *
   * Determines the business meaning of the document, such as a commercial
   * invoice, tax invoice, or credit note.
   */
  readonly type: InvoiceType;

  /**
   * Current lifecycle status of the invoice.
   *
   * Use {@link GeneralInvoice.effectiveStatus} when the status should also
   * account for automatic overdue detection.
   */
  readonly status: InvoiceStatus;

  /**
   * Schema version used by the invoice model.
   *
   * This identifies the representation schema rather than the lifecycle
   * version of the invoice itself.
   */
  readonly version: string;

  // ── Parties ───────────────────────────────────────────────────────────────

  /**
   * Party issuing or selling through the invoice.
   */
  readonly issuer: Party;

  /**
   * Party receiving or being billed by the invoice.
   */
  readonly recipient: Party;

  // ── Dates & Currency ─────────────────────────────────────────────────────

  /**
   * Currency in which the invoice is denominated.
   *
   * Expected to be a three-letter ISO 4217 currency code such as `PHP` or
   * `USD`.
   */
  readonly currency: CurrencyCode;

  /**
   * Invoice issue date in `YYYY-MM-DD` format.
   *
   * When omitted from the input, the creation date is used.
   */
  readonly issueDate: ISODateString;

  /**
   * Optional payment due date in `YYYY-MM-DD` format.
   *
   * When present, it cannot precede {@link issueDate}.
   */
  readonly dueDate?: ISODateString;

  /**
   * Optional service, billing, or accounting period covered by the invoice.
   */
  readonly period?: Period;

  /**
   * Optional payment terms associated with the invoice.
   */
  readonly paymentTerms?: PaymentTerms;

  // ── Line Items & Totals ───────────────────────────────────────────────────

  /**
   * All invoice line items.
   *
   * Line items are stored in their invoice order and contribute directly to
   * {@link totals}.
   */
  readonly lineItems: readonly LineItem[];

  /**
   * Aggregated invoice monetary totals calculated from {@link lineItems}.
   *
   * This includes subtotal, discounts, additive taxes, withholding, grand total,
   * and net payable amounts.
   */
  readonly totals: InvoiceTotals;

  /**
   * Invoice-level default taxes.
   *
   * These taxes are inherited by line items that do not define their own
   * explicit tax collection.
   */
  readonly defaultTaxes: TaxManager;

  // ── Settlement ────────────────────────────────────────────────────────────

  /**
   * Recorded payment proofs associated with the invoice.
   *
   * Payments are kept separately from invoice totals because settlement
   * history is operational state rather than part of the invoice's original
   * financial calculation.
   */
  readonly proofOfPayments: readonly ProofOfPayment[];

  // ── Supplementary ─────────────────────────────────────────────────────────

  /**
   * Optional references to related business or accounting documents.
   */
  readonly references?: readonly DocumentReference[];

  /**
   * Optional free-form invoice notes.
   */
  readonly notes?: string;

  /**
   * Optional organizational tags assigned to the invoice.
   */
  readonly tags?: string[];

  /**
   * Optional application-defined metadata.
   *
   * Metadata is preserved by the invoice model but is not interpreted by
   * financial calculations.
   */
  readonly metadata?: Record<string, unknown>;

  // ── Timestamps ────────────────────────────────────────────────────────────

  /**
   * Timestamp at which the invoice instance was originally created.
   */
  readonly createdAt: ISODateTimeString;

  /**
   * Timestamp at which the invoice instance was most recently rebuilt.
   *
   * Structural operations create a new invoice state with a refreshed
   * `updatedAt` timestamp.
   */
  readonly updatedAt: ISODateTimeString;

  // ── Private constructor ───────────────────────────────────────────────────

  /**
   * Construct a fully initialized invoice aggregate.
   *
   * This constructor is intentionally private. Use
   * {@link GeneralInvoice.create} or {@link GeneralInvoice.fromJSON} to create
   * invoice instances through the supported validation and calculation paths.
   *
   * @param input - Internal normalized invoice state.
   * @param lineItems - Fully constructed line items.
   * @param totals - Aggregated totals for the supplied line items.
   * @param payment - Optional payment proofs.
   */
  private constructor(
    input: InvoiceInternalState,
    lineItems: LineItem[],
    totals: InvoiceTotals,
    payment: ProofOfPayment[] = [],
    defaultTaxes?: TaxManager,
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

    // Preserve the normalized TaxManager instance when supplied.
    // This is important because line items may inherit this exact manager.
    this.defaultTaxes = defaultTaxes ?? TaxManager.coerce(input.defaultTaxes);

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
   * Rebuild the invoice with the supplied state overrides.
   *
   * This is the internal mechanism used by the public `with*`, `without*`,
   * payment, lifecycle, and tax mutation methods.
   *
   * Totals are recalculated from the resulting line-item collection every time.
   *
   * @param overrides - Invoice state fields to replace.
   * @param lineItems - Optional replacement line-item collection. Existing
   * line items are preserved when omitted.
   * @param payments - Optional replacement payment collection. Existing
   * payments are preserved when omitted.
   * @returns A new `GeneralInvoice` representing the rebuilt state.
   */
  private rebuild(
    overrides: Partial<InvoiceInternalState>,
    lineItems?: LineItem[],
    payments?: ProofOfPayment[],
  ): GeneralInvoice {
    const items = lineItems ?? [...this.lineItems];
    const totals = InvoiceTotals.fromLineItems(items, this.currency);

    const normalizedDefaultTaxes = overrides.defaultTaxes
      ? TaxManager.coerce(overrides.defaultTaxes)
      : this.defaultTaxes;

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
        defaultTaxes: normalizedDefaultTaxes.toArray(),
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
      normalizedDefaultTaxes,
    );
  }

  // ── Guards ─────────────────────────────────────────────────────────────────

  /**
   * Prevent an operation from mutating a voided invoice.
   *
   * Voided invoices are treated as immutable terminal documents.
   *
   * @param operation - Human-readable name of the operation being attempted.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
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
   * Ensure an operation is being performed on a draft invoice.
   *
   * Used for structural changes that are restricted to the draft lifecycle
   * state, such as changing line items or default tax configuration.
   *
   * @param operation - Human-readable name of the operation being attempted.
   * @throws {@link InvoiceMutationError} When the invoice is not in `draft`.
   */
  private assertDraft(operation: string): void {
    if (this.status !== "draft") {
      throw new InvoiceMutationError(
        `Cannot ${operation} on an invoice with status "${this.status}". ` +
          `Structural changes are only allowed on draft invoices.`,
      );
    }
  }

  // ── Static factory ────────────────────────────────────────────────────────

  /**
   * Create a new invoice from raw invoice input.
   *
   * This is the primary factory for creating a `GeneralInvoice`.
   *
   * During creation:
   *
   * - input is validated
   * - an invoice ID is generated when absent
   * - type defaults to `commercial`
   * - status defaults to `draft`
   * - issue date defaults to today
   * - invoice-level default taxes are normalized
   * - line-item taxes are resolved against invoice defaults
   * - all line items are fully calculated
   * - invoice totals are aggregated from those line items
   *
   * @param input - Invoice definition used to construct the aggregate.
   * @returns A fully validated and calculated invoice.
   * @throws {@link InvoiceValidationError} When invoice input is invalid.
   * @throws Errors from line-item or tax validation when nested data is invalid.
   *
   * @example
   * ```ts
   * const invoice = GeneralInvoice.create({
   *   issuer: { legalName: "Majikah Solutions OPC" },
   *   recipient: { legalName: "Example Client" },
   *   currency: "PHP",
   *   lineItems: [
   *     {
   *       description: "Development Services",
   *       quantity: 1,
   *       unitPrice: 25000,
   *     },
   *   ],
   * });
   * ```
   */
  static create(input: GeneralInvoiceInput): GeneralInvoice {
    GeneralInvoice.assertValid(input);

    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    // Normalize invoice-level default taxes once.
    const invoiceDefaultTaxes = TaxManager.coerce(input.defaultTaxes);

    const lineItems = input.lineItems.map((li) =>
      LineItem.create(li, input.currency, invoiceDefaultTaxes),
    );

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
      [],
      invoiceDefaultTaxes,
    );
  }

  // ── Internal helper — rebuild a line item preserving its own overrides ────

  /**
   * Recreate a line item from its current values while optionally replacing
   * its tax collection.
   *
   * Used internally when invoice-level tax configuration changes and affected
   * line items need to be recalculated.
   *
   * @param li - Existing line item to rebuild.
   * @param taxOverride - Optional replacement tax manager.
   * @returns A newly calculated line item.
   */
  private rebuildLineItem(
    li: LineItem,
    taxOverride?: TaxManager,
    inheritDefaultTaxes = false,
  ): LineItem {
    return LineItem.create(
      {
        id: li.id,
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice.toMajor(),
        unit: li.unit,
        taxes: inheritDefaultTaxes
          ? undefined
          : (taxOverride?.toArray() ?? li.taxes.toArray()),
        discount: li.discount,
        accountCode: li.accountCode,
        costCenter: li.costCenter,
        tags: li.tags,
        metadata: li.metadata,
      },
      this.currency,
      inheritDefaultTaxes ? taxOverride : undefined,
    );
  }

  /**
   * Restart a voided or otherwise terminal invoice as a draft.
   *
   * The invoice's financial and descriptive data is preserved, including:
   * line items, taxes, parties, dates, references, notes, tags, and metadata.
   *
   * The restarted invoice:
   *
   * - has `draft` status
   * - has all proof-of-payment records cleared
   *
   * Unlike {@link GeneralInvoice.withStatus}, this method intentionally bypasses
   * the normal `ALLOWED_TRANSITIONS` lifecycle rules.
   *
   * @returns A new draft invoice with the same underlying invoice data and
   * no recorded payments.
   */
  restartInvoice(): GeneralInvoice {
    return this.rebuild({ status: "draft" }, undefined, []);
  }

  // ==========================================================================
  // ── WITH* MUTATION METHODS ─────────────────────────────────────────────────
  // ==========================================================================

  // ── Identity & metadata ───────────────────────────────────────────────────

  /**
   * Set the customer-facing invoice number.
   *
   * Surrounding whitespace is removed before storage.
   *
   * @param invoiceNumber - Non-empty invoice number.
   * @returns A new invoice containing the supplied invoice number.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When the invoice number is empty.
   */
  withInvoiceNumber(invoiceNumber: string): GeneralInvoice {
    this.assertEditable("set invoice number");
    if (typeof invoiceNumber !== "string") {
      throw new InvoiceValidationError("Invoice number must be a string.");
    }
    if (!invoiceNumber || invoiceNumber.trim().length === 0) {
      throw new InvoiceValidationError(
        "Invoice number cannot be empty",
        "invoiceNumber",
      );
    }
    return this.rebuild({ invoiceNumber: invoiceNumber.trim() });
  }

  /**
   * Transition the invoice to a new lifecycle status.
   *
   * By default, the requested transition must exist in
   * `ALLOWED_TRANSITIONS`.
   *
   * Pass `force = true` to bypass the transition table. This is used by
   * controlled internal flows such as resolving payment state.
   *
   * @param status - Desired target lifecycle status.
   * @param force - Whether to bypass the configured lifecycle transition rules.
   * @returns A new invoice with the requested status. Returns the current
   * instance when the status is already the requested value.
   * @throws {@link InvoiceLifecycleError} When the transition is not allowed
   * and `force` is not enabled.
   */
  withStatus(status: InvoiceStatus, force: boolean = false): GeneralInvoice {
    if (this.status === status) return this;
    const allowed = ALLOWED_TRANSITIONS[this.status];
    if (!allowed.includes(status) && !force) {
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
   * Replace the invoice notes.
   *
   * Leading and trailing whitespace is removed.
   *
   * @param notes - Replacement notes text.
   * @returns A new invoice containing the supplied notes.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When `notes` is not a string.
   */
  withNotes(notes: string): GeneralInvoice {
    this.assertEditable("set notes");
    if (typeof notes !== "string") {
      throw new InvoiceValidationError("Notes must be a string", "notes");
    }
    return this.rebuild({ notes: notes.trim() });
  }

  /**
   * Append a non-empty note to the existing invoice notes.
   *
   * This is an internal helper used by dispute, resolution, and void
   * operations.
   *
   * @param note - Note text to append.
   * @returns A new invoice with the appended note, or the current instance
   * when the supplied note is empty.
   */
  private _appendNotes(note: string): GeneralInvoice {
    const trimmed = note.trim();
    if (!trimmed) return this;

    const existing = this.notes?.trim();

    const notes = existing ? `${existing}\n\n${trimmed}` : trimmed;

    return this.withNotes(notes);
  }

  /**
   * Remove all invoice notes.
   *
   * @returns A new invoice without notes.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   */
  withoutNotes(): GeneralInvoice {
    this.assertEditable("clear notes");
    return this.rebuild({ notes: undefined });
  }

  /**
   * Replace the invoice's complete tag collection.
   *
   * Tags are trimmed, empty values are rejected, and duplicates are removed.
   *
   * @param tags - Replacement tag collection.
   * @returns A new invoice containing the normalized tags.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When `tags` is not an array or
   * contains an empty/invalid tag.
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
   * Add a single tag to the invoice.
   *
   * If the tag is already present, the current invoice instance is returned.
   *
   * @param tag - Tag to add.
   * @returns A new invoice containing the tag, or the current instance when
   * the tag is already present.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When the tag is empty.
   */
  withTag(tag: string): GeneralInvoice {
    this.assertEditable("add tag");
    if (typeof tag !== "string") {
      throw new InvoiceValidationError("Tag must be a string.");
    }
    if (!tag || tag.trim().length === 0) {
      throw new InvoiceValidationError("Tag cannot be empty", "tag");
    }
    const existing = this.tags ?? [];
    const trimmed = tag.trim();
    if (existing.includes(trimmed)) return this;
    return this.rebuild({ tags: [...existing, trimmed] });
  }

  /**
   * Remove a single tag.
   *
   * If the tag is not present, the resulting invoice simply contains the
   * remaining tags.
   *
   * @param tag - Tag to remove.
   * @returns A new invoice without the matching tag.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   */
  withoutTag(tag: string): GeneralInvoice {
    this.assertEditable("remove tag");
    return this.rebuild({
      tags: (this.tags ?? []).filter((t) => t !== tag.trim()),
    });
  }

  /**
   * Apply a metadata patch to the invoice.
   *
   * Existing metadata is preserved unless a key is explicitly assigned
   * `null`, in which case that key is removed.
   *
   * @param patch - Metadata fields to add, replace, or remove.
   * @returns A new invoice containing the patched metadata.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When the patch is not a plain object.
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
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return this.rebuild({ metadata: merged });
  }

  /**
   * Completely replace the invoice metadata object.
   *
   * @param metadata - Replacement metadata object.
   * @returns A new invoice containing only the supplied metadata.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When the value is not a plain object.
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
   * Remove all invoice metadata.
   *
   * @returns A new invoice without metadata.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   */
  withoutMetadata(): GeneralInvoice {
    this.assertEditable("clear metadata");
    return this.rebuild({ metadata: undefined });
  }

  // ─────────────────────────────────────────────
  // ── STATUS UPDATE ─────────────────────────────
  // ─────────────────────────────────────────────

  /**
   * Transition the invoice to `issued`.
   *
   * @returns A new invoice with `issued` status.
   * @throws {@link InvoiceLifecycleError} When the transition is not allowed.
   */
  issue(): GeneralInvoice {
    return this.withStatus("issued");
  }

  /**
   * Transition the invoice to `sent`.
   *
   * @returns A new invoice with `sent` status.
   * @throws {@link InvoiceLifecycleError} When the transition is not allowed.
   */
  send(): GeneralInvoice {
    return this.withStatus("sent");
  }

  /**
   * Transition the invoice to `viewed`.
   *
   * @returns A new invoice with `viewed` status.
   * @throws {@link InvoiceLifecycleError} When the transition is not allowed.
   */
  view(): GeneralInvoice {
    return this.withStatus("viewed");
  }

  /**
   * Mark the invoice as fully paid through an explicit lifecycle transition.
   *
   * Payment records are not created by this method. Use {@link addPayment}
   * when recording actual proof of payment.
   *
   * @returns A new invoice with `paid` status.
   * @throws {@link InvoiceLifecycleError} When the transition is not allowed.
   */
  markAsPaid(): GeneralInvoice {
    return this.withStatus("paid");
  }

  /**
   * Mark the invoice as partially paid through an explicit lifecycle transition.
   *
   * Payment records are not created by this method.
   *
   * @returns A new invoice with `partial` status.
   * @throws {@link InvoiceLifecycleError} When the transition is not allowed.
   */
  markAsPartiallyPaid(): GeneralInvoice {
    return this.withStatus("partial");
  }

  /**
   * Mark the invoice as overdue.
   *
   * Unless `force` is enabled, the invoice must currently satisfy the
   * computed overdue condition.
   *
   * @param force - Whether to bypass the overdue-date guard.
   * @returns A new invoice with `overdue` status.
   * @throws {@link InvoiceLifecycleError} When the invoice is not overdue and
   * `force` is not enabled, or when the lifecycle transition is otherwise
   * not allowed.
   */
  markAsOverdue(force = false): GeneralInvoice {
    if (!force && !this.isOverdue) {
      throw new InvoiceLifecycleError(
        "Cannot mark as overdue before due date has passed",
        this.status,
        "overdue",
      );
    }

    // Force the lower-level transition since "overdue" is not a direct allowed destination
    return this.withStatus("overdue", true);
  }
  /**
   * Mark the invoice as disputed.
   *
   * When a reason is supplied, it is appended to the invoice notes using a
   * `DISPUTE REASON:` marker before the lifecycle transition is performed.
   *
   * @param reason - Optional dispute reason.
   * @returns A new invoice with `disputed` status.
   * @throws {@link InvoiceLifecycleError} When the lifecycle transition is not allowed.
   */
  dispute(reason?: string): GeneralInvoice {
    const trimmedReason = reason?.trim();
    const withReason = trimmedReason
      ? this._appendNotes(`DISPUTE REASON: ${trimmedReason}`)
      : this;
    return withReason.withStatus("disputed");
  }

  /**
   * Resolve a disputed invoice by transitioning it back to `issued`.
   *
   * When a reason is supplied, it is appended to the invoice notes using a
   * `RESOLUTION:` marker.
   *
   * @param reason - Optional resolution reason.
   * @returns A new invoice with `issued` status.
   * @throws {@link InvoiceLifecycleError} When the lifecycle transition is not allowed.
   */
  resolveDispute(reason?: string): GeneralInvoice {
    if (!this.isDisputed) {
      throw new InvoiceLifecycleError(
        "Cannot resolve a dispute on an undisputed invoice.",
        this.status,
        "issued",
      );
    }
    const trimmedReason = reason?.trim();
    const withReason = trimmedReason
      ? this._appendNotes(`RESOLUTION: ${trimmedReason}`)
      : this;
    return withReason.withStatus("issued");
  }

  /**
   * Void the invoice.
   *
   * When a reason is supplied, it is appended to the invoice notes using a
   * `VOID REASON:` marker.
   *
   * Once voided, normal mutation methods are blocked because voided invoices
   * are treated as immutable.
   *
   * @param reason - Optional reason for voiding the invoice.
   * @returns A new invoice with `void` status.
   * @throws {@link InvoiceLifecycleError} When the transition is not allowed.
   */
  voidInvoice(reason?: string): GeneralInvoice {
    const trimmedReason = reason?.trim();
    const withReason = trimmedReason
      ? this._appendNotes(`VOID REASON: ${trimmedReason}`)
      : this;
    return withReason.withStatus("void");
  }

  // ── Dates & terms ─────────────────────────────────────────────────────────

  /**
   * Set the invoice issue date.
   *
   * This operation is restricted to draft invoices.
   *
   * @param date - Issue date in `YYYY-MM-DD` format.
   * @returns A new invoice with the supplied issue date.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws {@link InvoiceValidationError} When the date format is invalid or
   * the date occurs after the due date.
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
   * Set or replace the invoice due date.
   *
   * The due date cannot precede the invoice issue date.
   *
   * @param date - Due date in `YYYY-MM-DD` format.
   * @returns A new invoice with the supplied due date.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When the date format is invalid or
   * the due date precedes the issue date.
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
   * Remove the invoice due date.
   *
   * @returns A new invoice without a due date.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   */
  withoutDueDate(): GeneralInvoice {
    this.assertEditable("remove due date");
    return this.rebuild({ dueDate: undefined });
  }

  /**
   * Set the invoice's service or accounting period.
   *
   * Period start and end dates must both be valid and the end date cannot
   * precede the start date.
   *
   * This operation is restricted to draft invoices.
   *
   * @param period - Period covered by the invoice.
   * @returns A new invoice containing the supplied period.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws {@link InvoiceValidationError} When the period is invalid.
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
   * Remove the invoice period.
   *
   * @returns A new invoice without a period.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   */
  withoutPeriod(): GeneralInvoice {
    this.assertDraft("remove period");
    return this.rebuild({ period: undefined });
  }

  /**
   * Set or replace the invoice payment terms.
   *
   * @param terms - Payment terms to associate with the invoice.
   * @returns A new invoice containing the supplied payment terms.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When payment terms are empty.
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
   * Add a related document reference.
   *
   * Reference type and number are validated and normalized by trimming
   * surrounding whitespace.
   *
   * @param ref - Document reference to add.
   * @returns A new invoice containing the additional reference.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When the reference is invalid.
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
   * Replace the complete reference collection.
   *
   * @param refs - Replacement document references.
   * @returns A new invoice containing the supplied references.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When the input is not an array or
   * any reference is invalid.
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
   * Remove one reference by its type and number.
   *
   * @param type - Reference type to match.
   * @param number - Reference number to match.
   * @returns A new invoice without the matching reference.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
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
   * Remove every document reference from the invoice.
   *
   * @returns A new invoice without references.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   */
  withoutReferences(): GeneralInvoice {
    this.assertEditable("clear references");
    return this.rebuild({ references: undefined });
  }

  // ── Line item mutations ───────────────────────────────────────────────────

  /**
   * Add a new line item to the invoice.
   *
   * The new line item inherits invoice-level default taxes when it does not
   * provide its own taxes.
   *
   * This operation is restricted to draft invoices.
   *
   * @param input - Raw line-item definition.
   * @returns A new invoice containing the additional line item and recalculated totals.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws Validation errors when the line item or its taxes are invalid.
   */
  withLineItem(input: LineItemInput): GeneralInvoice {
    this.assertDraft("add line item");

    const lineItem = LineItem.create(input, this.currency, this.defaultTaxes);
    return this.rebuild({}, [...this.lineItems, lineItem]);
  }

  /**
   * Replace all invoice line items.
   *
   * At least one line item is required.
   *
   * Each line resolves its own taxes against the invoice-level default taxes.
   *
   * @param inputs - Replacement line-item definitions.
   * @returns A new invoice with the supplied line items and recalculated totals.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws {@link InvoiceValidationError} When the input is not a non-empty
   * array or a nested line item is invalid.
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
      LineItem.create(li, this.currency, this.defaultTaxes),
    );
    return this.rebuild({}, lineItems);
  }

  /**
   * Remove a line item by ID.
   *
   * An invoice must retain at least one line item; therefore this method cannot
   * remove the final remaining line.
   *
   * @param id - ID of the line item to remove.
   * @returns A new invoice without the specified line item.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws {@link InvoiceValidationError} When the ID is empty, not found,
   * or identifies the final line item.
   */
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

  /**
   * Update an existing line item using a partial patch.
   *
   * Fields omitted from the patch retain their existing values.
   *
   * Tax behaviour is handled specially:
   *
   * - when taxes are supplied in the patch, they are resolved against the
   *   invoice default taxes
   * - when taxes are omitted, the line keeps its already resolved tax collection
   *
   * This operation is restricted to draft invoices.
   *
   * @param id - ID of the line item to update.
   * @param patch - Partial line-item fields to replace.
   * @returns A new invoice containing the updated line item and recalculated totals.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws {@link InvoiceValidationError} When the ID does not exist, the
   * patch is invalid, or the resulting line item is invalid.
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

    // Resolve taxes for the patched item.
    let resolvedTaxes: TaxManager;
    if ("taxes" in patch) {
      const ownTaxes = TaxManager.coerce(patch.taxes);
      resolvedTaxes = TaxManager.resolve(ownTaxes, this.defaultTaxes);
    } else {
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

  /**
   * Remove every line item from the invoice.
   *
   * This operation is intended as an explicit reset operation. A subsequent
   * {@link GeneralInvoice.withLineItem} call can be used to rebuild the invoice.
   *
   * @returns A new invoice containing no line items.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   */
  withClearedLineItems(): GeneralInvoice {
    this.assertDraft("clear line items");
    return this.rebuild({}, []);
  }

  // ── Default tax mutations ─────────────────────────────────────────────────

  /**
   * Replace the invoice-level default tax configuration.
   *
   * Line items that are inheriting the current invoice defaults are rebuilt
   * against the new defaults.
   *
   * Line items with independent tax configuration remain unchanged.
   *
   * This operation is restricted to draft invoices.
   *
   * @param taxes - Replacement default taxes.
   * @returns A new invoice with the new default taxes and recalculated affected lines.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws Validation errors when the supplied taxes are invalid.
   */
  withDefaultTaxes(
    taxes: TaxDetail | TaxDetail[] | TaxManager,
  ): GeneralInvoice {
    this.assertDraft("set default taxes");
    const newDefault = TaxManager.coerce(taxes);

    const items = this.lineItems.map((li) => {
      const isInheriting = li.taxes === this.defaultTaxes || li.taxes.isEmpty;

      if (!isInheriting) return li;

      return this.rebuildLineItem(li, newDefault, true);
    });

    return this.rebuild({ defaultTaxes: newDefault.toArray() }, items);
  }

  /**
   * Remove all invoice-level default taxes.
   *
   * Line items detected as inheriting the invoice defaults are rebuilt without
   * those inherited taxes. Explicitly configured line-item taxes are preserved.
   *
   * This operation is restricted to draft invoices.
   *
   * @returns A new invoice with no default taxes.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   */
  withoutDefaultTaxes(): GeneralInvoice {
    this.assertDraft("remove default taxes");

    const items = this.lineItems.map((li) => {
      const isInheriting = li.taxes === this.defaultTaxes || li.taxes.isEmpty;

      if (!isInheriting) return li;

      return this.rebuildLineItem(li, TaxManager.none(), true);
    });

    return this.rebuild({ defaultTaxes: TaxManager.none().toArray() }, items);
  }

  // ── Per-line-item tax mutations ───────────────────────────────────────────

  /**
   * Replace the tax collection on one specific line item.
   *
   * Accepts a single tax, an array of taxes, or an existing `TaxManager`.
   *
   * @param lineItemId - ID of the line item to update.
   * @param taxes - Replacement tax configuration.
   * @returns A new invoice with the updated line item and recalculated totals.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws {@link InvoiceValidationError} When the line item does not exist or
   * the supplied taxes are invalid.
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
   * Replace the taxes on every line item with the same tax configuration.
   *
   * Existing per-line tax configurations are replaced uniformly.
   *
   * @param taxes - Tax configuration to apply to every line.
   * @returns A new invoice with all line items recalculated using the supplied taxes.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws Validation errors when the supplied taxes are invalid.
   */
  withTaxesOnAllLineItems(
    taxes: TaxDetail | TaxDetail[] | TaxManager,
  ): GeneralInvoice {
    this.assertDraft("set taxes on all line items");
    const tm = TaxManager.coerce(taxes);
    const items = this.lineItems.map((li) => this.rebuildLineItem(li, tm));
    return this.rebuild({}, items);
  }

  /**
   * Remove all taxes from one specific line item.
   *
   * @param lineItemId - ID of the line item whose taxes should be removed.
   * @returns A new invoice with the selected line item untaxed.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   * @throws {@link InvoiceValidationError} When the line item does not exist.
   */
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

  /**
   * Remove all taxes from every line item.
   *
   * Existing invoice-level default taxes remain stored separately.
   *
   * @returns A new invoice whose line items have no taxes.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   */
  withoutTaxesOnAllLineItems(): GeneralInvoice {
    this.assertDraft("remove taxes from all line items");
    const items = this.lineItems.map((li) =>
      this.rebuildLineItem(li, TaxManager.none()),
    );
    return this.rebuild({}, items);
  }

  // ── Tax inclusivity toggles ───────────────────────────────────────────────

  /**
   * Mark matching additive taxes as inclusive on all line items.
   *
   * Inclusive taxes are treated as already embedded in the line amount.
   * Withholding taxes are ignored by the underlying {@link TaxManager}.
   *
   * @param taxType - Optional tax type filter. Omit to affect all eligible
   * additive taxes.
   * @returns A new invoice with matching taxes marked inclusive.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   */
  withInclusiveTax(taxType?: string): GeneralInvoice {
    this.assertDraft("set inclusive tax");
    return this._toggleTaxInclusivity(true, taxType);
  }

  /**
   * Mark matching additive taxes as exclusive on all line items.
   *
   * Exclusive taxes are calculated on top of the applicable line amount.
   * Withholding taxes are ignored by the underlying {@link TaxManager}.
   *
   * @param taxType - Optional tax type filter. Omit to affect all eligible
   * additive taxes.
   * @returns A new invoice with matching taxes marked exclusive.
   * @throws {@link InvoiceMutationError} When the invoice is not draft.
   */
  withExclusiveTax(taxType?: string): GeneralInvoice {
    this.assertDraft("set exclusive tax");
    return this._toggleTaxInclusivity(false, taxType);
  }

  /**
   * Apply an inclusivity setting to matching taxes throughout the invoice.
   *
   * Both line-item tax managers and invoice-level default taxes are updated
   * so the invoice's tax configuration remains consistent.
   *
   * @param inclusive - Whether matching additive taxes should be inclusive.
   * @param taxType - Optional tax type filter.
   * @returns A new invoice with the updated tax inclusivity configuration.
   */
  private _toggleTaxInclusivity(
    inclusive: boolean,
    taxType?: string,
  ): GeneralInvoice {
    const items = this.lineItems.map((li) => {
      const updated = li.taxes.withInclusivity(inclusive, taxType);
      // Skip rebuild if nothing changed.
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

  /**
   * Validate raw invoice input without throwing for validation failures.
   *
   * The returned object contains a boolean validity flag plus all discovered
   * validation errors.
   *
   * Validation covers:
   * - issuer presence and legal name
   * - recipient presence and legal name
   * - currency format
   * - presence of line items
   * - issue and due date formats
   * - issue/due date ordering
   * - period completeness and ordering
   * - issuer and recipient country-code formats
   * - invoice-level default tax definitions
   *
   * @param input - Invoice input to validate.
   * @returns A {@link ValidationResult} containing the validation outcome and
   * all discovered field-level errors.
   *
   * @example
   * ```ts
   * const result = GeneralInvoice.validate(input);
   *
   * if (!result.valid) {
   *   console.log(result.errors);
   * }
   * ```
   */
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

  /**
   * Validate invoice input and throw when validation fails.
   *
   * Unlike {@link GeneralInvoice.validate}, this method is intended for
   * validation gates where invalid input should immediately stop execution.
   *
   * All validation failures are combined into one
   * {@link InvoiceValidationError}.
   *
   * @param input - Invoice input to validate.
   * @returns Nothing when the input is valid.
   * @throws {@link InvoiceValidationError} When one or more validation errors
   * are present.
   *
   * @example
   * ```ts
   * GeneralInvoice.assertValid(input);
   * ```
   */
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

  /**
   * Validate an ISO calendar date string.
   *
   * @param date - Date value to validate.
   * @param field - Field name used in validation errors.
   * @throws {@link InvoiceValidationError} When the date is not `YYYY-MM-DD`.
   */
  private static assertDateFormat(date: string, field: string): void {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new InvoiceValidationError(
        `${field} must be in YYYY-MM-DD format`,
        field,
      );
    }
  }

  /**
   * Validate a document reference.
   *
   * A reference must be an object with non-empty `type` and `number` fields.
   *
   * @param ref - Document reference to validate.
   * @param field - Field path used in validation errors.
   * @throws {@link InvoiceValidationError} When the reference shape is invalid.
   */
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
  // ── GETTERS ────────────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Whether the invoice is currently disputed.
   *
   * @returns `true` when {@link status} is `disputed`.
   */
  get isDisputed(): boolean {
    return this.status === "disputed";
  }

  /**
   * Whether the invoice has been voided.
   *
   * @returns `true` when {@link status} is `void`.
   */
  get isVoided(): boolean {
    return this.status === "void";
  }

  /**
   * Whether the invoice has been sent.
   *
   * @returns `true` when {@link status} is `sent`.
   */
  get isSent(): boolean {
    return this.status === "sent";
  }

  /**
   * Whether the invoice has been viewed.
   *
   * @returns `true` when {@link status} is `viewed`.
   */
  get isViewed(): boolean {
    return this.status === "viewed";
  }

  /**
   * Get the formatted grand total.
   *
   * Formatting is delegated to {@link MajikMoney.format} using the invoice's
   * underlying currency representation.
   *
   * @returns Human-readable formatted grand total.
   */
  get formattedTotal(): string {
    return this.totals.grandTotal.format();
  }

  /**
   * Get the invoice grand total as a JavaScript number.
   *
   * @returns Grand total in major currency units.
   */
  get totalAmount(): number {
    return this.totals.grandTotalAmount;
  }

  /**
   * Get the total additive tax as a JavaScript number.
   *
   * @returns Additive tax total in major currency units.
   */
  get taxAmount(): number {
    return this.totals.taxTotalAmount;
  }

  /**
   * Get the total withholding amount as a JavaScript number.
   *
   * @returns Withholding total in major currency units.
   */
  get withholdingAmount(): number {
    return this.totals.withholdingTotalAmount;
  }

  /**
   * Get the amount actually payable after withholding as a JavaScript number.
   *
   * @returns Net payable in major currency units.
   */
  get netPayableAmount(): number {
    return this.totals.netPayableAmount;
  }

  /**
   * Get the invoice subtotal as a JavaScript number.
   *
   * @returns Subtotal in major currency units.
   */
  get subtotalAmount(): number {
    return this.totals.subtotalAmount;
  }

  /**
   * Get the total discount as a JavaScript number.
   *
   * @returns Total discount in major currency units.
   */
  get discountAmount(): number {
    return this.totals.discountTotalAmount;
  }

  /**
   * Get the number of line items on the invoice.
   *
   * @returns Current line-item count.
   */
  get lineItemCount(): number {
    return this.lineItems.length;
  }

  /**
   * Get the effective aggregate additive tax rate.
   *
   * @returns Effective tax rate as a decimal fraction.
   */
  get effectiveTaxRate(): number {
    return this.totals.effectiveTaxRate;
  }

  /**
   * Whether the invoice is in draft status.
   *
   * @returns `true` when {@link status} is `draft`.
   */
  get isDraft(): boolean {
    return this.status === "draft";
  }

  /**
   * Whether the invoice is in paid status.
   *
   * @returns `true` when {@link status} is `paid`.
   */
  get isPaid(): boolean {
    return this.status === "paid";
  }

  /**
   * Whether the invoice is in its terminal void state.
   *
   * @returns `true` when {@link status} is `void`.
   */
  get isTerminal(): boolean {
    return this.status === "void";
  }

  /**
   * Whether this invoice is a credit note.
   *
   * @returns `true` when {@link type} is `credit`.
   */
  get isCreditNote(): boolean {
    return this.type === "credit";
  }

  /**
   * Whether this invoice is a tax invoice.
   *
   * @returns `true` when {@link type} is `tax`.
   */
  get isTaxInvoice(): boolean {
    return this.type === "tax";
  }

  /**
   * Whether the invoice has a positive additive tax total.
   *
   * Withholding is intentionally excluded.
   *
   * @returns `true` when additive tax is present.
   */
  get hasTax(): boolean {
    return this.totals.hasTax;
  }

  /**
   * Whether the invoice has a positive withholding total.
   *
   * @returns `true` when withholding is present.
   */
  get hasWithholding(): boolean {
    return this.totals.hasWithholding;
  }

  /**
   * Whether the invoice has a positive discount total.
   *
   * @returns `true` when a discount is present.
   */
  get hasDiscount(): boolean {
    return this.totals.hasDiscount;
  }

  /**
   * Whether the invoice is currently overdue.
   *
   * An invoice is considered overdue when:
   *
   * - a due date exists
   * - the invoice is not void, paid, or disputed
   * - recorded payments do not fully cover the current net payable amount
   * - today's date is later than the due date
   *
   * @returns `true` when the invoice meets the overdue conditions.
   */
  get isOverdue(): boolean {
    if (!this.dueDate) return false;
    if (["void", "paid", "disputed"].includes(this.status)) return false;
    const totalPaid = this.proofOfPayments.reduce((s, p) => s + p.amount, 0);
    if (totalPaid >= this.totals.netPayableAmount) return false;
    return new Date().toISOString().slice(0, 10) > this.dueDate;
  }

  /**
   * Get the status that should currently be presented to consumers.
   *
   * When an otherwise active invoice has passed its due date and remains
   * unpaid, this getter reports `overdue` even when the stored lifecycle
   * status is still another non-terminal state.
   *
   * @returns Computed effective invoice status.
   */
  get effectiveStatus(): InvoiceStatus {
    return this.isOverdue ? "overdue" : this.status;
  }

  /**
   * Get all unique tax types appearing anywhere on the invoice.
   *
   * Includes additive, withholding, and informational taxes.
   *
   * @returns Unique tax type names across all line items.
   */
  get taxTypes(): string[] {
    return [...new Set(this.lineItems.flatMap((li) => li.taxes.taxTypes))];
  }

  /**
   * Get all unique additive tax types charged on the invoice.
   *
   * These are taxes that contribute to the invoice's tax total.
   *
   * @returns Unique additive tax type names.
   */
  get additiveTaxTypes(): string[] {
    return [
      ...new Set(
        this.lineItems.flatMap((li) => li.taxes.additive.map((t) => t.taxType)),
      ),
    ];
  }

  /**
   * Get all unique withholding tax types appearing on the invoice.
   *
   * @returns Unique withholding tax type names.
   */
  get withholdingTaxTypes(): string[] {
    return [
      ...new Set(
        this.lineItems.flatMap((li) =>
          li.taxes.withholding.map((t) => t.taxType),
        ),
      ),
    ];
  }

  /**
   * Get all unique cost centers used by the invoice line items.
   *
   * @returns Unique non-empty cost-center identifiers.
   */
  get costCenters(): string[] {
    return [
      ...new Set(
        this.lineItems
          .filter((li) => li.costCenter)
          .map((li) => li.costCenter!),
      ),
    ];
  }

  /**
   * Get all unique accounting codes used by the invoice line items.
   *
   * @returns Unique non-empty account codes.
   */
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
  // ── PAYMENT AND SETTLEMENT METHODS ────────────────────────────────────────
  // ==========================================================================

  /**
   * Get the aggregate payment state derived from recorded proof-of-payments.
   *
   * Possible states are:
   *
   * - `settled` — total recorded payment fully covers the invoice net payable
   * - `partially_paid` — at least one positive payment exists but the invoice
   *   is not fully covered
   * - `pending` — no positive payment has been recorded
   *
   * @returns Current computed {@link PaymentStatus}.
   */
  get paymentStatus(): PaymentStatus {
    if (this.isFullyPaid) return "settled";
    if (this.totalPaid.isPositive()) return "partially_paid";
    return "pending";
  }

  /**
   * Get the aggregate amount recorded as paid.
   *
   * Payment amounts are reconstructed into {@link MajikMoney} using the
   * invoice currency before being summed.
   *
   * @returns Total recorded payments in the invoice currency.
   */
  get totalPaid(): MajikMoney {
    return this.proofOfPayments.reduce(
      (sum, p) => sum.add(MajikMoney.fromMajor(p.amount, this.currency)),
      MajikMoney.zero(this.currency),
    );
  }

  /**
   * Get the outstanding amount after recorded payments.
   *
   * Calculated as:
   *
   * `totals.netPayable − totalPaid`
   *
   * @returns Remaining payable balance as `MajikMoney`.
   */
  get amountDue(): MajikMoney {
    return this.totals.netPayable.subtract(this.totalPaid);
  }

  /**
   * Determine whether the invoice is fully paid.
   *
   * @returns `true` when the outstanding amount is zero.
   */
  get isFullyPaid(): boolean {
    return this.amountDue.isZero();
  }

  /**
   * Record a new proof of payment.
   *
   * The payment is appended to the existing settlement history and the
   * resulting invoice status is recalculated:
   *
   * - fully paid → `paid`
   * - partially paid → `partial`
   * - unpaid → current lifecycle status is preserved
   *
   * Payment IDs must be present and unique, payment amounts must be positive,
   * and payment currency must match the invoice currency.
   *
   * @param proof - Payment proof to record.
   * @returns A new invoice containing the payment and updated settlement status.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When the proof is invalid or would
   * cause overpayment.
   */
  addPayment(proof: ProofOfPayment): GeneralInvoice {
    this.assertEditable("add payment");

    if (!proof.id) {
      throw new InvoiceValidationError("Proof must have an id", "proof.id");
    }

    return this._setPayments([...this.proofOfPayments, proof]);
  }

  /**
   * Remove a recorded payment by payment ID.
   *
   * The remaining settlement state is recalculated after removal.
   *
   * @param paymentId - ID of the payment proof to remove.
   * @returns A new invoice without the specified payment.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   * @throws {@link InvoiceValidationError} When the payment ID is empty or
   * does not exist.
   */
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

  /**
   * Remove every recorded payment from the invoice.
   *
   * @returns A new invoice with an empty payment history.
   * @throws {@link InvoiceMutationError} When the invoice is voided.
   */
  clearPayments(): GeneralInvoice {
    this.assertEditable("clear payments");
    return this._setPayments([]);
  }

  /**
   * Normalize, validate, and apply a complete payment collection.
   *
   * Payment proofs are sorted chronologically by `settledAt`, duplicate IDs
   * are rejected, currency mismatches are rejected, overpayment is rejected,
   * and the resulting invoice status is derived from the updated settlement.
   *
   * @param payments - Complete replacement payment collection.
   * @returns A rebuilt invoice containing the normalized payment collection.
   * @throws {@link InvoiceValidationError} When payments are invalid or exceed
   * the invoice's net payable amount.
   */
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
      return updated.withStatus("paid", true);
    }

    if (paid.greaterThan(MajikMoney.zero(this.currency))) {
      return updated.withStatus("partial", true);
    }

    return updated;
  }

  // ==========================================================================
  // ── CALCULATION & ANALYSIS ─────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Verify that invoice totals agree with the sum of its line-item totals.
   *
   * The comparison uses a `0.01` tolerance to account for minor floating-point
   * differences when values are exposed as JavaScript numbers.
   *
   * An invoice with no line items is considered unbalanced.
   *
   * @returns `true` when line-item totals reconcile with the invoice grand total.
   */
  isBalanced(): boolean {
    if (this.lineItems.length === 0) return false;
    const lineSum = this.lineItems.reduce((s, li) => s + li.netTotalAmount, 0);
    return Math.abs(lineSum - this.totals.grandTotalAmount) < 0.01;
  }

  /**
   * Check whether the current invoice may transition to a target status.
   *
   * This checks the configured lifecycle transition table only and does not
   * apply forced-transition semantics.
   *
   * @param to - Candidate target invoice status.
   * @returns `true` when the transition is listed as allowed.
   */
  canTransitionTo(to: InvoiceStatus): boolean {
    return ALLOWED_TRANSITIONS[this.status].includes(to);
  }

  /**
   * Get all lifecycle statuses allowed directly from the current status.
   *
   * @returns A new array containing the allowed target statuses.
   */
  allowedTransitions(): InvoiceStatus[] {
    return [...ALLOWED_TRANSITIONS[this.status]];
  }

  /**
   * Calculate the total additive tax amount for a specific tax type.
   *
   * The amount is aggregated across every line item and uses the line item's
   * already-calculated per-tax breakdown.
   *
   * @param taxType - Tax type to aggregate.
   * @returns Total additive tax amount in major currency units.
   * @throws {@link InvoiceValidationError} When `taxType` is empty.
   *
   * @example
   * ```ts
   * invoice.taxTotalByType("VAT");
   * ```
   */
  taxTotalByType(taxType: string): number {
    if (!taxType?.trim()) {
      throw new InvoiceValidationError("taxType is required", "taxType");
    }
    return this.lineItems.reduce((sum, li) => {
      const tax = li.taxes.getByType(taxType);
      if (!tax || (tax.behaviour ?? "additive") !== "additive") return sum;
      return sum + li.taxAmountByType(taxType);
    }, 0);
  }

  /**
   * Calculate the total withholding amount for a specific tax type.
   *
   * The amount is aggregated across every line item using each line's
   * calculated withholding breakdown.
   *
   * @param taxType - Withholding tax type to aggregate.
   * @returns Total withholding amount in major currency units.
   * @throws {@link InvoiceValidationError} When `taxType` is empty.
   */
  withholdingTotalByType(taxType: string): number {
    if (!taxType?.trim()) {
      throw new InvoiceValidationError("taxType is required", "taxType");
    }
    return this.lineItems.reduce((sum, li) => {
      return sum + li.withholdingAmountByType(taxType);
    }, 0);
  }

  /**
   * Calculate the gross subtotal for a specific cost center.
   *
   * This aggregates line totals before discounts and taxes.
   *
   * @param costCenter - Cost-center identifier to match.
   * @returns Sum of matching line totals in major currency units.
   * @throws {@link InvoiceValidationError} When `costCenter` is empty.
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
   * Calculate the gross subtotal for a specific accounting code.
   *
   * This aggregates line totals before discounts and taxes.
   *
   * @param accountCode - Account code to match.
   * @returns Sum of matching line totals in major currency units.
   * @throws {@link InvoiceValidationError} When `accountCode` is empty.
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
   * Produce a grouped tax analysis for the entire invoice.
   *
   * Informational taxes are excluded. Additive and withholding taxes are
   * grouped by tax type, jurisdiction, behaviour, and inclusivity.
   *
   * Each entry reports:
   *
   * - tax identity
   * - applicable rate
   * - tax behaviour
   * - whether the tax is inclusive
   * - aggregated taxable base
   * - aggregated tax amount
   * - number of affected line items
   *
   * For inclusive additive taxes, the taxable base excludes the tax amount
   * itself. For withholding taxes, the base excludes all inclusive additive
   * taxes on the line.
   *
   * @returns Grouped tax breakdown entries for the invoice.
   */
  taxBreakdown(): TaxBreakdownEntry[] {
    const groups = new Map<string, TaxBreakdownEntry>();

    for (const li of this.lineItems) {
      const postDiscount = li.lineTotalAmount - li.discountAmountValue;

      // Pre-calculate the total inclusive tax on this line once for withholding base logic.
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
          // Base for an inclusive tax excludes that tax.
          trueTaxableBase = postDiscount - taxAmount;
        } else if ((tax.behaviour ?? "additive") === "withholding") {
          // Base for withholding excludes ALL inclusive VAT/taxes.
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

  /**
   * Produce an invoice-wide discount summary.
   *
   * The result includes:
   *
   * - total discount
   * - formatted discount
   * - effective invoice discount rate
   * - per-line discount details
   *
   * @returns Aggregate discount information for the invoice.
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
   * Group line items by accounting code.
   *
   * Lines without an explicit `accountCode` are grouped under the configured
   * revenue account from {@link DEFAULT_ACCOUNTS} or the supplied accounting
   * context.
   *
   * @param context - Optional accounting configuration override.
   * @returns One group per account code containing matching lines and subtotal.
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
   * Calculate invoice totals using a supplied foreign-exchange rate.
   *
   * The conversion applies to subtotal, discounts, additive taxes, and grand
   * total. The result is returned as a separate FX projection and does not
   * modify the invoice's stored currency or monetary values.
   *
   * @param rate - Positive finite conversion rate.
   * @param targetCurrency - Three-letter ISO 4217 target currency code.
   * @returns Converted invoice totals in the target currency.
   * @throws {@link InvoiceValidationError} When the FX rate is invalid, the
   * target currency is invalid, or the target currency matches the invoice currency.
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
    const targetDef: CurrencyDefinition = {
      code: targetCurrency,
      symbol: "",
      minorUnits: 2,
      name: targetCurrency,
      cashRoundingIncrement:
        CURRENCIES[targetCurrency]?.cashRoundingIncrement ?? 0.01,
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
   * Project the invoice into a draft journal entry.
   *
   * The projection requires:
   *
   * - at least one line item
   * - a balanced invoice
   *
   * The generated journal entry contains:
   *
   * - Accounts Receivable for the full invoice grand total
   * - Revenue entries grouped by accounting code
   * - Tax Payable for additive taxes when present
   *
   * Withholding is intentionally not journalized here because this projection
   * represents the invoice itself rather than the later payment/withholding
   * receipt process.
   *
   * Credit notes reverse the debit/credit direction of the generated lines.
   *
   * @param context - Optional accounting account overrides.
   * @returns A draft {@link JournalEntry}.
   * @throws {@link InvoiceProjectionError} When the invoice has no line items,
   * is unbalanced, or the resulting journal entry fails its balance check.
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

    // Dr Accounts Receivable (full invoice amount including VAT).
    lines.push({
      accountCode: accounts.receivable,
      accountName: "Accounts Receivable",
      debit: isCredit ? undefined : grandTotal,
      credit: isCredit ? grandTotal : undefined,
      memo: `Invoice ${this.invoiceNumber ?? this.id} — ${this.recipient.legalName}`,
    });

    // Cr Revenue (post-discount, pre-tax).
    const revenueByAccount = new Map<
      string,
      { name: string; amount: number }
    >();

    for (const li of this.lineItems) {
      const code = li.accountCode ?? accounts.revenue;

      // Subtract additive taxes to obtain the revenue portion.
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

    // Cr VAT Payable (additive taxes only).
    if (this.totals.hasTax) {
      lines.push({
        accountCode: accounts.tax,
        accountName: "Tax Payable",
        debit: isCredit ? this.totals.taxTotalAmount : undefined,
        credit: isCredit ? undefined : this.totals.taxTotalAmount,
        memo: `Tax — ${this.additiveTaxTypes.join(", ")}`,
      });
    }

    // Withholding is intentionally excluded from invoice journalization.
    // The payment/2307 workflow can account for it separately.

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

  /**
   * Project the invoice into an Accounts Receivable sub-ledger entry.
   *
   * The resulting entry uses the recipient as the sub-ledger party and exposes
   * the invoice grand total as the initial outstanding balance.
   *
   * @returns An open {@link SubLedgerEntry} representing the invoice balance.
   * @throws {@link InvoiceProjectionError} When the invoice contains no line items.
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

  /**
   * Convert the invoice into the input structure expected by the broader
   * Majik Invoice API.
   *
   * Derived monetary totals are intentionally omitted because they can be
   * recalculated from the source invoice fields and line items.
   *
   * @returns A `MajikInvoiceInput` representation of the invoice.
   */
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

  /**
   * Serialize the complete invoice into its JSON representation.
   *
   * Serialized data includes:
   *
   * - schema version
   * - identity and lifecycle state
   * - parties
   * - dates and payment terms
   * - serialized line items and totals
   * - proof of payments
   * - default taxes
   * - references and supplementary metadata
   * - creation/update timestamps
   *
   * Monetary values and metadata are passed through the project's serializer.
   *
   * @returns JSON-serializable invoice representation.
   *
   * @example
   * ```ts
   * const json = invoice.toJSON();
   * JSON.stringify(json);
   * ```
   */
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

  /**
   * Reconstruct an invoice from serialized JSON.
   *
   * Line items are reconstructed from their serialized representations and
   * invoice totals are recalculated from those line items rather than trusting
   * the serialized aggregate totals.
   *
   * Default taxes and metadata are also restored through their respective
   * deserialization paths.
   *
   * @param json - Serialized invoice representation.
   * @returns A reconstructed `GeneralInvoice`.
   *
   * @example
   * ```ts
   * const invoice = GeneralInvoice.fromJSON(savedInvoice);
   * ```
   */
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
   * Build the canonical signable subset of the invoice.
   *
   * This method intentionally excludes fields that are operational,
   * lifecycle-driven, or expected to change after the original document
   * commitment.
   *
   * Excluded fields:
   *
   * - `version` — schema changes should not invalidate existing signatures
   * - `status` — lifecycle state can change after signing
   * - `notes` — operational annotations may be amended
   * - `tags` — organizational metadata
   * - `metadata` — arbitrary application metadata
   * - `proofOfPayments` — settlement information is added after signing
   * - `createdAt` / `updatedAt` — timestamps can vary across serialization
   *   or rebuild operations
   *
   * @returns Plain object containing the fields committed by the canonical
   * signing representation.
   * @internal
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

  // ── Canonical representation cache ────────────────────────────────────────

  /**
   * Cached canonical UTF-8 representation of the signable invoice.
   *
   * @internal
   */
  private _canonicalBytes?: Uint8Array;

  /**
   * Cached canonical JSON string used for signing and hashing.
   *
   * @internal
   */
  private _canonicalJSON?: string;

  /**
   * Cached SHA-256 hash of the canonical bytes.
   *
   * @internal
   */
  private _canonicalHash?: string;

  /**
   * Return the canonical UTF-8 bytes committed by the invoice signing model.
   *
   * The canonical representation is generated from
   * {@link GeneralInvoice.toSignableJSON} and cached after first calculation.
   *
   * @returns UTF-8 encoded canonical invoice bytes.
   *
   * @example
   * ```ts
   * const bytes = invoice.toCanonicalBytes();
   * ```
   */
  toCanonicalBytes(): Uint8Array {
    if (this._canonicalBytes) {
      return this._canonicalBytes;
    }

    const canonical = canonicalize(this.toSignableJSON());

    const json = JSON.stringify(canonical);

    this._canonicalJSON = json;
    this._canonicalBytes = encoder.encode(json);

    return this._canonicalBytes;
  }

  /**
   * Return the canonical JSON string committed by the invoice signing model.
   *
   * This is the deterministic JSON representation used as the basis for
   * canonical bytes and the invoice hash.
   *
   * @returns Canonical JSON string.
   *
   * @example
   * ```ts
   * const canonical = invoice.toCanonicalJSON();
   * ```
   */
  toCanonicalJSON(): string {
    if (this._canonicalJSON) {
      return this._canonicalJSON;
    }

    const canonical = canonicalize(this.toSignableJSON());

    this._canonicalJSON = JSON.stringify(canonical);

    return this._canonicalJSON;
  }

  /**
   * Return the SHA-256 hash of the canonical signable invoice.
   *
   * This provides a compact cryptographic commitment to the invoice fields
   * included by {@link GeneralInvoice.toSignableJSON}.
   *
   * The hash is cached after its first calculation.
   *
   * @returns Lower-level hash representation as a hexadecimal string.
   *
   * @example
   * ```ts
   * const hash = invoice.toCanonicalHash();
   * ```
   */
  toCanonicalHash(): string {
    if (this._canonicalHash) return this._canonicalHash;
    this._canonicalHash = sha256Hex(this.toCanonicalBytes());
    return this._canonicalHash;
  }

  // ==========================================================================
  // ── CSV EXPORT ──────────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Export this invoice as a CSV document.
   *
   * The resulting string contains one header row followed by one invoice data
   * row using the supplied column definitions.
   *
   * For multi-invoice exports, use the higher-level batch CSV facility rather
   * than repeatedly concatenating complete CSV documents.
   *
   * @param columns - CSV columns to include. Defaults to
   * {@link DEFAULT_CSV_COLUMNS}.
   * @returns CSV string containing a header and one data row.
   *
   * @example
   * ```ts
   * const csv = invoice.toCSV();
   * ```
   *
   * @example
   * ```ts
   * const csv = invoice.toCSV(customColumns);
   * ```
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
   * Export only this invoice's CSV data row.
   *
   * Intended for internal use by multi-invoice CSV exporters that provide
   * their own shared header row.
   *
   * @param columns - CSV columns to include. Defaults to
   * {@link DEFAULT_CSV_COLUMNS}.
   * @returns A single CSV data row without a header.
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

// Freeze static methods
Object.freeze(GeneralInvoice);

// Freeze instance methods
Object.freeze(GeneralInvoice.prototype);
