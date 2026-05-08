import { v4 as uuidv4 } from "uuid";
import { TaxManager } from "./tax-manager";
import { LineItemInput } from "./types";

export function generateUUID(): string {
  try {
    const genID = uuidv4();

    return genID;
  } catch (error) {
    throw new Error(`Failed to generate ID: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Internal helper — resolve taxes array from input (backward-compat)
// ---------------------------------------------------------------------------

/**
 * Normalise the dual tax/taxes fields from LineItemInput into a single
 * canonical TaxDetail[]. Deduplicates by taxType + jurisdiction.
 *
 * Priority: taxes[] wins over deprecated tax when both are present.
 */
export function resolveTaxes(input: LineItemInput): TaxManager {
  if (input.taxes && input.taxes.length > 0)
    return TaxManager.fromMany(input.taxes);
  return TaxManager.none();
}



// ---------------------------------------------------------------------------
// Internal helper — Utilities for working with invoice-like alphanumeric identifiers.
// ---------------------------------------------------------------------------


/**
 * invoice-number.utils.ts
 *
 * Utilities for working with invoice-like alphanumeric identifiers.
 *
 * Features:
 * - Detects whether a string contains numbers
 * - Finds the LAST numeric sequence in a string
 * - Increments the LAST numeric sequence
 * - Preserves leading zero padding
 * - Supports arbitrarily large numbers via BigInt
 * - Falls back to appending "-1" if no number exists
 *
 * Examples:
 *
 *  INV-90-ABC-0000349
 *    -> INV-90-ABC-0000350
 *
 *  INV-90-ABC-0000349ABZ
 *    -> INV-90-ABC-0000350ABZ
 *
 *  INV-2025-0001-FINAL
 *    -> INV-2025-0002-FINAL
 *
 *  INV
 *    -> INV-1
 */

export interface NumericRange {
  /**
   * Start index of the numeric sequence (inclusive).
   */
  start: number;

  /**
   * End index of the numeric sequence (exclusive).
   */
  end: number;

  /**
   * Raw numeric string found in the input.
   */
  value: string;
}

/**
 * Returns true if the string contains at least one numeric character.
 *
 * Examples:
 *  "INV-001"    -> true
 *  "INV-ABC"    -> false
 *  "123"        -> true
 */
export function containsNumber(value: string): boolean {
  return /\d/.test(value);
}

/**
 * Returns true if the string ENDS with a numeric sequence.
 *
 * Examples:
 *  "INV-001"        -> true
 *  "INV-001ABC"     -> false
 *  "ABC123"         -> true
 */
export function endsWithNumber(value: string): boolean {
  return /\d+$/.test(value);
}

/**
 * Finds the LAST numeric sequence anywhere in the string.
 *
 * Examples:
 *  "INV-90-ABC-0000349"
 *    -> { start: 11, end: 18, value: "0000349" }
 *
 *  "INV-90-ABC-0000349ABZ"
 *    -> { start: 11, end: 18, value: "0000349" }
 *
 *  "INV"
 *    -> null
 */
export function findLastNumberRange(value: string): NumericRange | null {
  const matches = [...value.matchAll(/\d+/g)];

  if (matches.length === 0) {
    return null;
  }

  const lastMatch = matches[matches.length - 1];

  const start = lastMatch.index ?? 0;
  const numericValue = lastMatch[0];

  return {
    start,
    end: start + numericValue.length,
    value: numericValue,
  };
}

/**
 * Increments a numeric string while preserving leading zero padding.
 *
 * Examples:
 *  "0000349" -> "0000350"
 *  "0099"    -> "0100"
 *  "9999"    -> "10000"
 */
export function incrementNumericString(value: string): string {
  const incremented = (BigInt(value) + 1n).toString();

  // Preserve existing padding when possible
  if (incremented.length < value.length) {
    return incremented.padStart(value.length, "0");
  }

  return incremented;
}

/**
 * Increments the LAST numeric sequence found in the string.
 *
 * If no numeric sequence exists, "-1" is appended.
 *
 * Examples:
 *
 *  "INV-90-ABC-0000349"
 *    -> "INV-90-ABC-0000350"
 *
 *  "INV-90-ABC-0000349ABZ"
 *    -> "INV-90-ABC-0000350ABZ"
 *
 *  "INV-2025-0001-FINAL"
 *    -> "INV-2025-0002-FINAL"
 *
 *  "INV"
 *    -> "INV-1"
 */
export function incrementLastNumericSequence(value: string): string {
  const range = findLastNumberRange(value);

  // No numbers found
  if (!range) {
    return `${value}-1`;
  }

  const incremented = incrementNumericString(range.value);

  return value.slice(0, range.start) + incremented + value.slice(range.end);
}
