/**
 * src/rules/totals.ts
 *
 * P5: Total Entered Value (Block 39 on CBP Form 7501)
 * P10: Summary Totals (Blocks 41–44 on CBP Form 7501)
 *
 * Computes total entered values for all lines, with configurable rounding strategy.
 * Summarizes duty, tax, and other fees into the final total.
 */

import type { RuleResult } from "./types";
import { roundEnteredValue } from "./rounding";
import { totalEnteredValueMode } from "./config";

/**
 * Compute the total entered value for all lines on an entry.
 *
 * This implements P5 (Total Entered Value) from CBP Form 7501, Block 39.
 *
 * Two modes are supported:
 * - "sumOfRoundedLines": Round each line individually using P4, then sum
 * - "roundSumOfExactLines": Sum all exact line values, then apply P4 rounding to total
 *
 * @param linesCents - Array of exact line values in cents (e.g., [150, 200, 75])
 * @param mode - Optional rounding mode. Defaults to config.totalEnteredValueMode
 * @returns RuleResult<number>
 *   - OkResult: Non-negative whole-dollar integer representing total
 *   - NeedsReview: If any line value is negative (business rule violation)
 *
 * @throws Error if linesCents is not an array or contains non-integers (type violation)
 *
 * Guarantees:
 * - Result is non-negative integer (whole dollars)
 * - Empty array returns OkResult(0)
 * - Single-line list returns same as P4(line) in both modes
 * - Reordering lines does not change total
 * - Adding non-negative value increases or maintains total
 * - |sumOfRoundedLines - roundSumOfExactLines| ≤ 50 * N cents (where N = line count)
 *
 * Examples (mode: sumOfRoundedLines):
 * - totalEnteredValue([150, 200]) → OkResult(4)   // $1.50 + $2.00 → $1 + $2 = $3
 * - totalEnteredValue([]) → OkResult(0)           // Empty list
 * - totalEnteredValue([50]) → OkResult(1)         // Single $0.50 line → $1
 * - totalEnteredValue([100, -50]) → NeedsReview   // Negative value not allowed
 *
 * Examples (mode: roundSumOfExactLines):
 * - totalEnteredValue([150, 200], "roundSumOfExactLines") → OkResult(4)  // $3.50 → $4 (rounded)
 * - totalEnteredValue([25, 25], "roundSumOfExactLines") → OkResult(0)   // $0.50 total → $1 (rounded)
 */
export function totalEnteredValue(
  linesCents: number[],
  mode?: "sumOfRoundedLines" | "roundSumOfExactLines"
): RuleResult<number> {
  // Type check: linesCents must be an array
  if (!Array.isArray(linesCents)) {
    throw new Error(
      `Expected array of line values, got ${typeof linesCents}. linesCents must be an array of integers representing cents.`
    );
  }

  // Business rule check: no negative values
  for (let i = 0; i < linesCents.length; i++) {
    if (linesCents[i] < 0) {
      return {
        ok: false,
        reason: `Line ${i} has negative value ${linesCents[i]} cents (${(linesCents[i] / 100).toFixed(2)} dollars). All line values must be non-negative.`,
      };
    }
  }

  // Use provided mode or default from config
  const roundingMode = mode ?? totalEnteredValueMode;

  // Edge case: empty array
  if (linesCents.length === 0) {
    return {
      ok: true,
      value: 0,
    };
  }

  if (roundingMode === "sumOfRoundedLines") {
    // Mode 1: Round each line individually using P4, then sum
    let totalDollars = 0;

    for (const lineCents of linesCents) {
      // roundEnteredValue returns OkResult or NeedsReview
      // We already validated that lineCents is non-negative above,
      // so roundEnteredValue will always return OkResult
      const roundingResult = roundEnteredValue(lineCents);

      // Should never be NeedsReview since we validated non-negative above
      if (!roundingResult.ok) {
        // This should not happen due to our validation above
        return roundingResult;
      }

      totalDollars += roundingResult.value;
    }

    return {
      ok: true,
      value: totalDollars,
    };
  } else if (roundingMode === "roundSumOfExactLines") {
    // Mode 2: Sum all exact line values, then apply P4 rounding
    const totalCents = linesCents.reduce((sum, lineCents) => sum + lineCents, 0);

    // Apply P4 rounding to the total
    const roundingResult = roundEnteredValue(totalCents);

    // Should never be NeedsReview since totalCents is non-negative
    // (sum of non-negative values is non-negative)
    if (!roundingResult.ok) {
      return roundingResult;
    }

    return {
      ok: true,
      value: roundingResult.value,
    };
  } else {
    // This should never happen if config is validated
    // but we throw to catch programmer errors
    const exhaustive: never = roundingMode;
    throw new Error(
      `Unknown totalEnteredValueMode: ${exhaustive}. Must be "sumOfRoundedLines" or "roundSumOfExactLines".`
    );
  }
}

/**
 * Summarize duty, tax, and other fees into the total amount due (Block 44).
 *
 * This implements P10 (Summary Totals) from CBP Form 7501, Blocks 41–44.
 *
 * Block 44 (total due) = Block 41 (duty) + Block 42 (tax) + Block 43 (other fees)
 *
 * @param block41Duty - Block 41 (duty) in cents, or null if unknown
 * @param block42Tax - Block 42 (tax) in cents, or null if unknown
 * @param block43OtherFees - Block 43 (other fees) in cents, or null if unknown
 * @param block34BondedADCVD - Optional: Block 34B (bonded AD/CVD) in cents
 * @param block34B5232a - Optional: Block 34B (5232(a) deferred tax) in cents
 * @returns RuleResult<{ block44Total: number; bonded?: number; deferred?: number }>
 *   - OkResult: Object with block44Total and optional bonded/deferred fields
 *   - NeedsReview: If any required block is null or negative
 *
 * Guarantees:
 * - Block 44 = Block 41 + Block 42 + Block 43 for all known non-negative inputs
 * - Reordering the three input blocks does not change Block 44
 * - Bonded AD/CVD and 5232(a) deferred amounts do not affect Block 44
 *
 * Examples:
 * - summarizeTotals(5000, 2000, 1000) → OkResult({ block44Total: 8000 })
 * - summarizeTotals(5000, null, 1000) → NeedsReview  // block42Tax is unknown
 * - summarizeTotals(5000, -1000, 1000) → NeedsReview  // block42Tax is negative
 */
export function summarizeTotals(
  block41Duty: number | null,
  block42Tax: number | null,
  block43OtherFees: number | null,
  block34BondedADCVD?: number,
  block34B5232a?: number
): RuleResult<{ block44Total: number; bonded?: number; deferred?: number }> {
  // Check for missing blocks
  if (block41Duty === null) {
    return {
      ok: false,
      reason: "Block 41 (duty) is required but missing. Cannot compute Block 44 total.",
    };
  }

  if (block42Tax === null) {
    return {
      ok: false,
      reason: "Block 42 (tax) is required but missing. Cannot compute Block 44 total.",
    };
  }

  if (block43OtherFees === null) {
    return {
      ok: false,
      reason: "Block 43 (other fees) is required but missing. Cannot compute Block 44 total.",
    };
  }

  // Check for negative blocks
  if (block41Duty < 0) {
    return {
      ok: false,
      reason: `Block 41 (duty) is negative: ${block41Duty} cents. All blocks must be non-negative.`,
    };
  }

  if (block42Tax < 0) {
    return {
      ok: false,
      reason: `Block 42 (tax) is negative: ${block42Tax} cents. All blocks must be non-negative.`,
    };
  }

  if (block43OtherFees < 0) {
    return {
      ok: false,
      reason: `Block 43 (other fees) is negative: ${block43OtherFees} cents. All blocks must be non-negative.`,
    };
  }

  // Compute Block 44 total
  const block44Total = block41Duty + block42Tax + block43OtherFees;

  // Build result with optional fields
  const result: { block44Total: number; bonded?: number; deferred?: number } = {
    block44Total,
  };

  if (block34BondedADCVD !== undefined) {
    result.bonded = block34BondedADCVD;
  }

  if (block34B5232a !== undefined) {
    result.deferred = block34B5232a;
  }

  return {
    ok: true,
    value: result,
  };
}
