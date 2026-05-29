import type { TaxDetail, TaxBehaviour } from "./types";
import { InvoiceValidationError } from "./errors";

/**
 * Tax Manager
 * ---
 *
 * @description Immutable collection of TaxDetail entries with named operations.
 *
 * Responsibilities:
 *  - Canonical storage for a set of taxes (array internally, but managed)
 *  - Inheritance resolution (line item taxes vs invoice default taxes)
 *  - Inclusivity toggling by taxType filter
 *  - Validation of individual TaxDetail entries
 *  - BIR-aware guards (e.g. withholding cannot be inclusive)
 *
 * TaxManager is value-object style — every mutation returns a new instance.
 * The empty TaxManager is TaxManager.none().
 */
export class TaxManager {
  private readonly _taxes: readonly TaxDetail[];

  private constructor(taxes: TaxDetail[]) {
    this._taxes = Object.freeze([...taxes]);
  }

  // ── Factories ─────────────────────────────────────────────────────────────

  /** Empty — no taxes applied */
  static none(): TaxManager {
    return new TaxManager([]);
  }

  /** Wrap a single TaxDetail */
  static fromOne(tax: TaxDetail): TaxManager {
    TaxManager.assertValidTax(tax, "tax");
    return new TaxManager([tax]);
  }

  /** Wrap an array of TaxDetail */
  static fromMany(taxes: TaxDetail[]): TaxManager {
    if (!Array.isArray(taxes)) {
      throw new InvoiceValidationError("taxes must be an array", "taxes");
    }
    taxes.forEach((t, i) => TaxManager.assertValidTax(t, `taxes[${i}]`));
    TaxManager.assertNoDuplicates(taxes);
    TaxManager.assertInclusiveConstraints(taxes);
    return new TaxManager(taxes);
  }

  /**
   * Resolve a line item's own taxes against an invoice-level default.
   * - If the line item has its own TaxManager with entries, use it as-is.
   * - If the line item has none, inherit from the invoice default.
   * This is called in LineItem.create() to resolve the final tax set.
   */
  static resolve(own: TaxManager, invoiceDefault: TaxManager): TaxManager {
    return own.isEmpty ? invoiceDefault : own;
  }

  /**
   * Coerce from legacy single-tax input (backward compat).
   * Accepts TaxDetail | TaxDetail[] | TaxManager | undefined.
   */
  static coerce(
    input: TaxDetail | TaxDetail[] | TaxManager | undefined,
  ): TaxManager {
    if (!input) return TaxManager.none();
    if (input instanceof TaxManager) {
      return TaxManager.fromMany(input.toArray());
    }
    if (Array.isArray(input)) return TaxManager.fromMany(input); // ← validated
    return TaxManager.fromOne(input); // ← validated
  }

  // ── Immutable mutations ───────────────────────────────────────────────────

  /** Add a tax. Throws if a tax with the same taxType already exists. */
  add(tax: TaxDetail): TaxManager {
    TaxManager.assertValidTax(tax, "tax");
    if (this.hasTaxType(tax.taxType)) {
      throw new InvoiceValidationError(
        `Tax type "${tax.taxType}" already exists on this line. ` +
          `Use replace() to update it.`,
        "taxType",
      );
    }
    const next = [...this._taxes, tax];
    TaxManager.assertInclusiveConstraints(next);
    return new TaxManager(next);
  }

  /** Replace the tax with the matching taxType. Throws if not found. */
  replace(tax: TaxDetail): TaxManager {
    TaxManager.assertValidTax(tax, "tax");
    if (!this.hasTaxType(tax.taxType)) {
      throw new InvoiceValidationError(
        `Tax type "${tax.taxType}" not found. Use add() to add a new tax.`,
        "taxType",
      );
    }
    const next = this._taxes.map((t) => (t.taxType === tax.taxType ? tax : t));
    TaxManager.assertInclusiveConstraints(next as TaxDetail[]);
    return new TaxManager(next as TaxDetail[]);
  }

  /** Add or replace — upsert semantics */
  set(tax: TaxDetail): TaxManager {
    TaxManager.assertValidTax(tax, "tax");
    if (this.hasTaxType(tax.taxType)) return this.replace(tax);
    return this.add(tax);
  }

  /** Remove by taxType. No-op if not found. */
  remove(taxType: string): TaxManager {
    return new TaxManager(this._taxes.filter((t) => t.taxType !== taxType));
  }

  /** Remove all taxes */
  clear(): TaxManager {
    return TaxManager.none();
  }

  /**
   * Set the `inclusive` flag on all additive taxes matching the filter.
   * Withholding taxes are skipped silently (inclusive is meaningless for them).
   *
   * @param inclusive - true = inclusive, false = exclusive
   * @param taxType   - optional filter; omit to affect all additive taxes
   */
  withInclusivity(inclusive: boolean, taxType?: string): TaxManager {
    let changed = false;
    const next = this._taxes.map((t) => {
      if ((t.behaviour ?? "additive") === "withholding") return t;
      if (taxType !== undefined && t.taxType !== taxType) return t;
      if ((t.inclusive ?? false) === inclusive) return t; // already correct
      changed = true;
      return { ...t, inclusive };
    });
    return changed ? new TaxManager(next as TaxDetail[]) : this;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  get all(): readonly TaxDetail[] {
    return this._taxes;
  }

  get isEmpty(): boolean {
    return this._taxes.length === 0;
  }

  get additive(): readonly TaxDetail[] {
    return this._taxes.filter(
      (t) => (t.behaviour ?? "additive") === "additive",
    );
  }

  get withholding(): readonly TaxDetail[] {
    return this._taxes.filter((t) => t.behaviour === "withholding");
  }

  get informational(): readonly TaxDetail[] {
    return this._taxes.filter((t) => t.behaviour === "informational");
  }

  get taxTypes(): string[] {
    return this._taxes.map((t) => t.taxType);
  }

  hasTaxType(taxType: string): boolean {
    return this._taxes.some((t) => t.taxType === taxType);
  }

  getByType(taxType: string): TaxDetail | undefined {
    return this._taxes.find((t) => t.taxType === taxType);
  }

  toArray(): TaxDetail[] {
    return [...this._taxes];
  }

  /**
   * First additive VAT tax.
   * Useful for PH VAT invoices where only one VAT is expected.
   */
  get vat(): TaxDetail | undefined {
    return this._taxes.find((t) => {
      const type = t.taxType.trim().toLowerCase();
      const behaviour = t.behaviour ?? "additive";

      return type.includes("vat") && behaviour === "additive";
    });
  }

  /**
   * First EWT withholding tax.
   * Useful for PH BIR withholding workflows.
   */
  get ewt(): TaxDetail | undefined {
    return this._taxes.find((t) => {
      const type = t.taxType.trim().toLowerCase();

      return type.includes("ewt") && t.behaviour === "withholding";
    });
  }

  // ── Validation (static — also used by LineItem and GeneralInvoice) ─────────

  static assertValidTax(tax: TaxDetail, field: string): void {
    tax.taxType = tax.taxType.trim().toUpperCase();

    if (!tax || typeof tax !== "object" || Array.isArray(tax)) {
      throw new InvoiceValidationError("Tax must be a valid object", field);
    }
    if (!tax.taxType || tax.taxType.trim().length === 0) {
      throw new InvoiceValidationError(
        "taxType is required (e.g. 'VAT', 'GST', 'EWT')",
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
    const validBehaviours: TaxBehaviour[] = [
      "additive",
      "withholding",
      "informational",
    ];
    if (tax.behaviour && !validBehaviours.includes(tax.behaviour)) {
      throw new InvoiceValidationError(
        `behaviour must be one of: ${validBehaviours.join(", ")}`,
        `${field}.behaviour`,
      );
    }
    if (tax.behaviour === "withholding" && tax.inclusive) {
      throw new InvoiceValidationError(
        "Withholding taxes cannot be inclusive — the inclusive flag only applies to additive taxes",
        `${field}.inclusive`,
      );
    }
  }

  private static assertNoDuplicates(taxes: TaxDetail[]): void {
    const seen = new Set<string>();
    for (const t of taxes) {
      const key = `${t.taxType.trim().toUpperCase()}::${t.jurisdiction?.trim()?.toUpperCase() ?? ""}`;
      if (seen.has(key)) {
        throw new InvoiceValidationError(
          `Duplicate tax type "${t.taxType}". Each taxType must appear at most once per line item.`,
          "taxType",
        );
      }
      seen.add(key);
    }
  }

  private static assertInclusiveConstraints(taxes: TaxDetail[]): void {
    const inclusiveCount = taxes.filter(
      (t) => (t.behaviour ?? "additive") === "additive" && t.inclusive,
    ).length;
    if (inclusiveCount > 1) {
      throw new InvoiceValidationError(
        "At most one inclusive additive tax is allowed per line item. " +
          "Multiple inclusive taxes on the same price are ambiguous.",
        "taxes",
      );
    }
  }
}
