import type { TaxDetail, TaxBehaviour } from "./types.js";
import { InvoiceValidationError } from "./errors.js";

/**
 * Immutable manager for a collection of {@link TaxDetail} entries.
 *
 * `TaxManager` provides a single, consistent API for working with the taxes
 * attached to an invoice line or other taxable document element.
 *
 * ### Behaviour
 * - Stores zero or more tax entries.
 * - Identifies taxes by their `taxType`.
 * - Validates tax definitions when they enter the manager.
 * - Resolves line-item taxes against invoice-level defaults.
 * - Supports immutable add, replace, upsert, remove, and inclusivity operations.
 * - Separates taxes by their {@link TaxBehaviour}.
 * - Provides convenience accessors for common Philippine tax workflows such as
 *   VAT and Expanded Withholding Tax (EWT).
 *
 * ### Immutability
 * All instance-level mutation methods return a new `TaxManager` rather than
 * modifying the current instance. The original manager remains unchanged.
 *
 * The only empty state is represented by {@link TaxManager.none}.
 *
 * @example
 * ```ts
 * const taxes = TaxManager.fromMany([
 *   { taxType: "VAT", rate: 0.12, inclusive: false },
 * ]);
 *
 * const updated = taxes.add({
 *   taxType: "EWT",
 *   rate: 0.02,
 *   behaviour: "withholding",
 * });
 *
 * console.log(taxes.taxTypes);   // ["VAT"]
 * console.log(updated.taxTypes); // ["VAT", "EWT"]
 * ```
 */
export class TaxManager {
  /**
   * Internal immutable tax collection.
   *
   * The stored array is frozen and is never exposed for direct mutation.
   * Use {@link TaxManager.all} for the read-only collection or
   * {@link TaxManager.toArray} when a mutable array copy is required.
   */
  private readonly _taxes: readonly TaxDetail[];

  /**
   * Create a manager from an already validated tax collection.
   *
   * This constructor is intentionally private so that every public creation
   * path goes through the manager's validation rules.
   *
   * @param taxes - Tax entries to store.
   */
  private constructor(taxes: TaxDetail[]) {
    this._taxes = Object.freeze([...taxes]);
  }

  // ── Factories ─────────────────────────────────────────────────────────────

  /**
   * Create an empty tax manager.
   *
   * Use this when no taxes are currently applied.
   *
   * @returns An empty `TaxManager` containing no tax entries.
   *
   * @example
   * ```ts
   * const taxes = TaxManager.none();
   * taxes.isEmpty; // true
   * ```
   */
  static none(): TaxManager {
    return new TaxManager([]);
  }

  /**
   * Create a tax manager containing a single tax.
   *
   * The supplied tax is validated before the manager is created.
   *
   * @param tax - Tax definition to store.
   * @returns A `TaxManager` containing the supplied tax.
   * @throws {@link InvoiceValidationError} When the tax definition is invalid.
   *
   * @example
   * ```ts
   * const taxes = TaxManager.fromOne({
   *   taxType: "VAT",
   *   rate: 0.12,
   * });
   * ```
   */
  static fromOne(tax: TaxDetail): TaxManager {
    TaxManager.assertValidTax(tax, "tax");
    return new TaxManager([tax]);
  }

  /**
   * Create a tax manager from multiple tax definitions.
   *
   * Every tax is individually validated, duplicate tax combinations are
   * rejected, and the collection is checked for conflicting inclusive taxes.
   *
   * @param taxes - Tax definitions to store.
   * @returns A `TaxManager` containing the validated tax collection.
   * @throws {@link InvoiceValidationError} When:
   * - `taxes` is not an array.
   * - Any tax entry is invalid.
   * - A duplicate tax type/jurisdiction combination exists.
   * - More than one inclusive additive tax is present.
   *
   * @example
   * ```ts
   * const taxes = TaxManager.fromMany([
   *   { taxType: "VAT", rate: 0.12 },
   *   { taxType: "EWT", rate: 0.02, behaviour: "withholding" },
   * ]);
   * ```
   */
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
   * Resolve the effective tax collection for a line item.
   *
   * A line item's explicitly assigned taxes take precedence over the invoice
   * default. The invoice default is inherited only when the line item has no
   * taxes of its own.
   *
   * @param own - Taxes explicitly assigned to the line item.
   * @param invoiceDefault - Taxes configured as the invoice-level default.
   * @returns `own` when it contains at least one tax; otherwise `invoiceDefault`.
   *
   * @example
   * ```ts
   * const effective = TaxManager.resolve(lineTaxes, invoiceTaxes);
   * ```
   */
  static resolve(own: TaxManager, invoiceDefault: TaxManager): TaxManager {
    return own.isEmpty ? invoiceDefault : own;
  }

  /**
   * Normalize supported tax input into a `TaxManager`.
   *
   * This helper provides backward compatibility for APIs that may receive:
   * - a single `TaxDetail`
   * - an array of `TaxDetail`
   * - an existing `TaxManager`
   * - `undefined`
   *
   * `undefined` represents no taxes and produces {@link TaxManager.none}.
   * Existing managers are converted through the normal validation path.
   *
   * @param input - Tax input in any supported legacy or manager form.
   * @returns A validated `TaxManager`.
   * @throws {@link InvoiceValidationError} When the supplied tax input is invalid.
   *
   * @example
   * ```ts
   * const taxes = TaxManager.coerce(input);
   * ```
   */
  static coerce(
    input: TaxDetail | TaxDetail[] | TaxManager | undefined,
  ): TaxManager {
    if (!input) return TaxManager.none();
    if (input instanceof TaxManager) {
      return TaxManager.fromMany(input.toArray());
    }
    if (Array.isArray(input)) return TaxManager.fromMany(input);
    return TaxManager.fromOne(input);
  }

  // ── Immutable mutations ───────────────────────────────────────────────────

  /**
   * Add a new tax entry.
   *
   * The tax must be valid and its `taxType` must not already exist in the
   * current manager. The returned manager contains the original taxes plus
   * the new tax.
   *
   * This method does not modify the current instance.
   *
   * @param tax - Tax definition to add.
   * @returns A new `TaxManager` containing the added tax.
   * @throws {@link InvoiceValidationError} When the tax is invalid or its
   * `taxType` already exists.
   *
   * @example
   * ```ts
   * const updated = taxes.add({
   *   taxType: "VAT",
   *   rate: 0.12,
   * });
   * ```
   */
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

  /**
   * Replace an existing tax using its `taxType` as the lookup key.
   *
   * The replacement must already exist in the manager. Use {@link TaxManager.add}
   * when introducing a new tax type.
   *
   * This method does not modify the current instance.
   *
   * @param tax - Replacement tax definition. Its `taxType` identifies the
   * existing entry to replace.
   * @returns A new `TaxManager` containing the replacement tax.
   * @throws {@link InvoiceValidationError} When the replacement is invalid or
   * no tax with the supplied `taxType` exists.
   *
   * @example
   * ```ts
   * const updated = taxes.replace({
   *   taxType: "VAT",
   *   rate: 0.15,
   * });
   * ```
   */
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

  /**
   * Add a tax when its `taxType` is new, or replace the existing tax when
   * that `taxType` is already present.
   *
   * This provides upsert semantics in a single operation.
   *
   * This method does not modify the current instance.
   *
   * @param tax - Tax definition to add or use as the replacement.
   * @returns A new `TaxManager` containing the supplied tax definition.
   * @throws {@link InvoiceValidationError} When the tax definition is invalid
   * or violates the manager's tax constraints.
   *
   * @example
   * ```ts
   * const updated = taxes.set({
   *   taxType: "VAT",
   *   rate: 0.12,
   * });
   * ```
   */
  set(tax: TaxDetail): TaxManager {
    TaxManager.assertValidTax(tax, "tax");
    if (this.hasTaxType(tax.taxType)) return this.replace(tax);
    return this.add(tax);
  }

  /**
   * Remove a tax by its `taxType`.
   *
   * If no matching tax exists, the operation is a no-op and the returned
   * manager simply contains the remaining taxes.
   *
   * This method does not modify the current instance.
   *
   * @param taxType - Tax type to remove.
   * @returns A new `TaxManager` without matching tax entries.
   *
   * @example
   * ```ts
   * const updated = taxes.remove("VAT");
   * ```
   */
  remove(taxType: string): TaxManager {
    return new TaxManager(this._taxes.filter((t) => t.taxType !== taxType));
  }

  /**
   * Remove every tax from the collection.
   *
   * This is equivalent to returning {@link TaxManager.none}.
   *
   * This method does not modify the current instance.
   *
   * @returns An empty `TaxManager`.
   */
  clear(): TaxManager {
    return TaxManager.none();
  }

  /**
   * Set the `inclusive` flag for matching tax entries.
   *
   * Withholding taxes are always skipped because tax inclusivity does not
   * apply to withholding behaviour.
   *
   * When `taxType` is provided, only the matching tax type is considered.
   * When omitted, all non-withholding entries are considered.
   *
   * If every relevant entry already has the requested inclusivity, the current
   * manager instance is returned unchanged.
   *
   * This method does not modify the current instance.
   *
   * @param inclusive - `true` to mark the entry as inclusive; `false` to mark
   * it as exclusive.
   * @param taxType - Optional tax type filter. Omit to affect all
   * non-withholding entries.
   * @returns The current manager when nothing changed; otherwise a new manager
   * containing the updated inclusivity flags.
   *
   * @example
   * ```ts
   * // Mark the VAT tax as inclusive.
   * const updated = taxes.withInclusivity(true, "VAT");
   *
   * // Mark all eligible taxes as exclusive.
   * const updated = taxes.withInclusivity(false);
   * ```
   */
  withInclusivity(inclusive: boolean, taxType?: string): TaxManager {
    let changed = false;
    const next = this._taxes.map((t) => {
      if ((t.behaviour ?? "additive") === "withholding") return t;
      if (taxType !== undefined && t.taxType !== taxType) return t;
      if ((t.inclusive ?? false) === inclusive) return t;
      changed = true;
      return { ...t, inclusive };
    });
    return changed ? new TaxManager(next as TaxDetail[]) : this;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /**
   * Get every tax currently managed by this instance.
   *
   * The returned array is read-only at the type level and the internal
   * collection itself is frozen.
   *
   * @returns The complete tax collection.
   */
  get all(): readonly TaxDetail[] {
    return this._taxes;
  }

  /**
   * Determine whether the manager contains no taxes.
   *
   * @returns `true` when the collection is empty; otherwise `false`.
   *
   * @example
   * ```ts
   * if (taxes.isEmpty) {
   *   // No taxes apply.
   * }
   * ```
   */
  get isEmpty(): boolean {
    return this._taxes.length === 0;
  }

  /**
   * Get all taxes using additive behaviour.
   *
   * Taxes without an explicit `behaviour` are treated as additive.
   *
   * @returns All additive tax entries.
   */
  get additive(): readonly TaxDetail[] {
    return this._taxes.filter(
      (t) => (t.behaviour ?? "additive") === "additive",
    );
  }

  /**
   * Get all taxes using withholding behaviour.
   *
   * @returns All withholding tax entries.
   */
  get withholding(): readonly TaxDetail[] {
    return this._taxes.filter((t) => t.behaviour === "withholding");
  }

  /**
   * Get all taxes using informational behaviour.
   *
   * @returns All informational tax entries.
   */
  get informational(): readonly TaxDetail[] {
    return this._taxes.filter((t) => t.behaviour === "informational");
  }

  /**
   * Get the `taxType` value of every managed tax.
   *
   * The order matches the order of the underlying tax collection.
   *
   * @returns An array containing each tax type.
   *
   * @example
   * ```ts
   * taxes.taxTypes;
   * // ["VAT", "EWT"]
   * ```
   */
  get taxTypes(): string[] {
    return this._taxes.map((t) => t.taxType);
  }

  /**
   * Check whether a tax with the specified `taxType` exists.
   *
   * @param taxType - Tax type to search for.
   * @returns `true` when a matching tax exists; otherwise `false`.
   */
  hasTaxType(taxType: string): boolean {
    return this._taxes.some((t) => t.taxType === taxType);
  }

  /**
   * Find the first tax with the specified `taxType`.
   *
   * @param taxType - Tax type to search for.
   * @returns The matching tax, or `undefined` when no match exists.
   *
   * @example
   * ```ts
   * const vat = taxes.getByType("VAT");
   * ```
   */
  getByType(taxType: string): TaxDetail | undefined {
    return this._taxes.find((t) => t.taxType === taxType);
  }

  /**
   * Return the managed taxes as a new mutable array.
   *
   * The returned array is a copy, so changing it does not change the
   * `TaxManager` instance.
   *
   * @returns A new array containing all managed tax entries.
   */
  toArray(): TaxDetail[] {
    return [...this._taxes];
  }

  /**
   * Get the first additive VAT tax.
   *
   * A tax qualifies when:
   * - its normalized `taxType` contains `"vat"`, and
   * - its effective behaviour is `"additive"`.
   *
   * Useful for Philippine VAT invoice workflows where a single additive VAT
   * entry is expected.
   *
   * @returns The first matching VAT tax, or `undefined` when none exists.
   */
  get vat(): TaxDetail | undefined {
    return this._taxes.find((t) => {
      const type = t.taxType.trim().toLowerCase();
      const behaviour = t.behaviour ?? "additive";

      return type.includes("vat") && behaviour === "additive";
    });
  }

  /**
   * Get the first Expanded Withholding Tax (EWT) entry.
   *
   * A tax qualifies when:
   * - its normalized `taxType` contains `"ewt"`, and
   * - its behaviour is `"withholding"`.
   *
   * Useful for Philippine BIR withholding workflows.
   *
   * @returns The first matching EWT tax, or `undefined` when none exists.
   */
  get ewt(): TaxDetail | undefined {
    return this._taxes.find((t) => {
      const type = t.taxType.trim().toLowerCase();

      return type.includes("ewt") && t.behaviour === "withholding";
    });
  }

  // ── Validation ────────────────────────────────────────────────────────────

  /**
   * Validate a single {@link TaxDetail}.
   *
   * This is the canonical tax validation routine used by `TaxManager` and
   * other invoice domain classes such as `LineItem` and `GeneralInvoice`.
   *
   * Validation covers:
   * - object shape
   * - required `taxType`
   * - tax type normalization
   * - finite tax rate
   * - rate range (`0` through `1`)
   * - supported tax behaviour
   * - withholding/inclusive compatibility
   *
   * As part of validation, `taxType` is trimmed and normalized to uppercase.
   *
   * @param tax - Tax definition to validate.
   * @param field - Path/name used when reporting validation failures.
   * @returns Nothing when the tax is valid.
   * @throws {@link InvoiceValidationError} When any tax constraint is violated.
   *
   * @example
   * ```ts
   * TaxManager.assertValidTax(tax, "invoice.tax");
   * ```
   */
  static assertValidTax(tax: TaxDetail, field: string): void {
    // 1. Guard against null, primitive, or array inputs first
    if (!tax || typeof tax !== "object" || Array.isArray(tax)) {
      throw new InvoiceValidationError("Tax must be a valid object", field);
    }

    // 2. Guard against missing or non-string taxType
    if (
      !tax.taxType ||
      typeof tax.taxType !== "string" ||
      tax.taxType.trim().length === 0
    ) {
      throw new InvoiceValidationError(
        "taxType is required (e.g. 'VAT', 'GST', 'EWT')",
        `${field}.taxType`,
      );
    }

    // 3. Normalize taxType safely now that we know it exists
    tax.taxType = tax.taxType.trim().toUpperCase();

    // 4. Rate checks
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

    // 5. Behaviour checks
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

    // 6. Inclusivity constraints
    if (tax.behaviour === "withholding" && tax.inclusive) {
      throw new InvoiceValidationError(
        "Withholding taxes cannot be inclusive — the inclusive flag only applies to additive taxes",
        `${field}.inclusive`,
      );
    }
  }

  /**
   * Ensure the collection does not contain duplicate normalized
   * tax type/jurisdiction combinations.
   *
   * The comparison is case-insensitive and ignores surrounding whitespace.
   *
   * This prevents the same tax identity from being represented more than once
   * within a single collection.
   *
   * @param taxes - Tax collection to validate.
   * @throws {@link InvoiceValidationError} When a duplicate combination exists.
   */
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

  /**
   * Ensure the collection contains at most one inclusive additive tax.
   *
   * Multiple inclusive additive taxes would make it ambiguous how the same
   * base price should be interpreted. Withholding and other non-additive
   * behaviours are not counted by this constraint.
   *
   * @param taxes - Tax collection to validate.
   * @throws {@link InvoiceValidationError} When more than one inclusive
   * additive tax is present.
   */
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

// Freeze static methods
Object.freeze(TaxManager);

// Freeze instance methods
Object.freeze(TaxManager.prototype);