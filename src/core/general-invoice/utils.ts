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
