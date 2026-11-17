/**
 * src/rules/rounding.ts
 *
 * P4: Entered Value Rounding (Column 36A on CBP Form 7501)
 *
 * Rounds exact line values in cents to whole-dollar amounts using configurable rounding modes.
 * Half-up rounding is the default (50 cents rounds to 1 dollar).
 */

import type { RuleResult, RoundingMode } from "./types";
import { chargesRounding } from "./config";

/**
 * Apply the specified rounding mode to convert a decimal value to an integer.
 *
 * @param value - The decimal value to round
 * @param mode - The rounding mode to apply
 * @returns The rounded integer value
 *
 * @throws Error if mode is not recognized (programmer error)
 *
 * Rounding modes:
 * - halfUp: Round 0.5 up (standard banker's rounding upward). 50 cents → 1 dollar.
 * - halfDown: Round 0.5 down. 50 cents → 0 dollars.
 * - halfEven: Round 0.5 to the nearest even number (banker's rounding). 50 cents → 0, 150 cents → 2.
 * - truncate: Always round down (discard fractional part). 99 cents → 0 dollars.
 */
function applyRoundingMode(value: number, mode: RoundingMode): number {
  const fractional = value - Math.floor(value);

  switch (mode) {
    case "halfUp":
      // Round 0.5 and above up
      return Math.round(value);

    case "halfDown":
      // Round 0.5 down (only round down at the exact 0.5 boundary)
      return fractional <= 0.5 ? Math.floor(value) : Math.ceil(value);

    case "halfEven":
      // Banker's rounding: round 0.5 to nearest even integer
      if (fractional < 0.5) {
        return Math.floor(value);
      } else if (fractional > 0.5) {
        return Math.ceil(value);
      } else {
        // Exactly 0.5: round to nearest even
        const floor = Math.floor(value);
        return floor % 2 === 0 ? floor : floor + 1;
      }

    case "truncate":
      // Always round down (discard fractional part)
      return Math.floor(value);

    default:
      // This should never happen if config is validated, but we throw to catch programmer errors
      const exhaustive: never = mode;
      throw new Error(`Unknown rounding mode: ${exhaustive}`);
  }
}

/**
 * Round an entered value in cents to a whole-dollar integer using the specified rounding mode.
 *
 * This implements P4 (Entered Value Rounding) from CBP Form 7501.
 *
 * @param cents - The exact line value in integer cents (e.g., 150 for $1.50)
 * @param mode - Optional rounding mode. Defaults to config.chargesRounding (halfUp)
 * @returns RuleResult<number>
 *   - OkResult: Non-negative whole-dollar integer
 *   - NeedsReview: If cents is negative (business rule violation)
 *
 * @throws Error if cents is not an integer (type violation—fail fast)
 *
 * Guarantees:
 * - Result is non-negative integer (whole dollars)
 * - |result - (cents/100)| ≤ 0.50
 * - 50 cents (50) rounds to 1 dollar when using halfUp mode
 * - Rounding mode determines behavior for exact 0.5 boundary
 *
 * Examples:
 * - roundEnteredValue(150) → OkResult(2)   // $1.50 → $2
 * - roundEnteredValue(149) → OkResult(1)   // $1.49 → $1
 * - roundEnteredValue(50) → OkResult(1)    // $0.50 → $1 (halfUp)
 * - roundEnteredValue(49) → OkResult(0)    // $0.49 → $0
 * - roundEnteredValue(-100) → NeedsReview  // Negative not allowed
 * - roundEnteredValue(1.5) → Error         // Non-integer throws
 */
export function roundEnteredValue(
  cents: number,
  mode?: RoundingMode
): RuleResult<number> {
  // Type check: cents must be an integer
  if (!Number.isInteger(cents)) {
    throw new Error(
      `Expected integer cents, got ${cents}. Cents must be a whole number representing US dollar amounts.`
    );
  }

  // Business rule check: cents must be non-negative
  if (cents < 0) {
    return {
      ok: false,
      reason: `Entered value must be non-negative. Received ${cents} cents (${(cents / 100).toFixed(2)} dollars).`,
    };
  }

  // Use provided mode or default from config
  const roundingMode = mode ?? chargesRounding;

  // Convert cents to dollars
  const dollars = cents / 100;

  // Apply rounding mode to convert to whole dollars
  const roundedDollars = applyRoundingMode(dollars, roundingMode);

  return {
    ok: true,
    value: roundedDollars,
  };
}
