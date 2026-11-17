/**
 * src/rules/rounding.ts
 *
 * P4: Entered Value Rounding (Column 36A on CBP Form 7501)
 *
 * Rounds exact line values in cents to whole-dollar amounts using configurable rounding modes.
 * Half-up rounding is the default (50 cents rounds to 1 dollar).
 *
 * All arithmetic uses integer cents only (no floating-point money math).
 */

import type { RuleResult, RoundingMode } from "./types";

/**
 * Apply the specified rounding mode to convert cents to whole dollars using integer arithmetic.
 *
 * @param cents - The value in integer cents
 * @param mode - The rounding mode to apply
 * @returns The rounded whole-dollar integer
 *
 * @throws Error if mode is not recognized (programmer error)
 *
 * Rounding modes (integer-based, cents remainder in range [0, 99]):
 * - halfUp: Round up if remainder >= 50. 50 cents → 1 dollar.
 * - halfDown: Round up if remainder > 50. 50 cents → 0 dollars.
 * - halfEven: Round up if remainder > 50, or remainder == 50 and dollars is odd.
 * - truncate: Never round up (always discard remainder).
 */
function applyRoundingMode(cents: number, mode: RoundingMode): number {
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;

  switch (mode) {
    case "halfUp":
      // Round up if remainder >= 50
      return remainder >= 50 ? dollars + 1 : dollars;

    case "halfDown":
      // Round up only if remainder > 50
      return remainder > 50 ? dollars + 1 : dollars;

    case "halfEven":
      // Round up if remainder > 50, or remainder == 50 and dollars is odd
      if (remainder > 50) {
        return dollars + 1;
      } else if (remainder === 50 && dollars % 2 === 1) {
        return dollars + 1;
      } else {
        return dollars;
      }

    case "truncate":
      // Always round down (discard remainder)
      return dollars;

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
 * @param mode - Optional rounding mode. Defaults to "halfUp"
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
  mode: RoundingMode = "halfUp"
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

  // Apply rounding mode using integer arithmetic
  const roundedDollars = applyRoundingMode(cents, mode);

  return {
    ok: true,
    value: roundedDollars,
  };
}
