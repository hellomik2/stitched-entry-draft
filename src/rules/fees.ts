/**
 * src/rules/fees.ts
 *
 * P8: Merchandise Processing Fee (MPF) computation
 *
 * Computes the MPF based on the dutiable value, applying configured rate,
 * minimum, and maximum bounds. All arithmetic uses integer cents only.
 */

import type { RuleResult, RoundingMode } from "./types";
import { config } from "./config";

/**
 * Round a fractional cent value to an integer number of cents using the specified rounding mode.
 *
 * This helper rounds the raw result of (rate * base / 1_000_000) from a fractional
 * cent value to an integer number of cents, using the configured rounding mode.
 *
 * @param fractionalCents - The value in fractional cents (may have decimals)
 * @param mode - The rounding mode to apply
 * @returns The rounded integer cents
 *
 * Rounding modes (0.5 cent boundary determines rounding):
 * - halfUp: Round up if fractional part >= 0.5. 0.5 → 1.
 * - halfDown: Round up only if fractional part > 0.5. 0.5 → 0.
 * - halfEven: Round to nearest even, with 0.5 rounding to nearest even.
 * - truncate: Always round down (discard fractional part).
 */
function roundCents(fractionalCents: number, mode: RoundingMode): number {
  const wholeCents = Math.floor(fractionalCents);
  const remainder = fractionalCents - wholeCents;

  switch (mode) {
    case "halfUp":
      // Round up if remainder >= 0.5
      return remainder >= 0.5 ? wholeCents + 1 : wholeCents;

    case "halfDown":
      // Round up only if remainder > 0.5
      return remainder > 0.5 ? wholeCents + 1 : wholeCents;

    case "halfEven":
      // Round to nearest even
      if (remainder > 0.5) {
        return wholeCents + 1;
      } else if (remainder === 0.5 && wholeCents % 2 === 1) {
        return wholeCents + 1;
      } else {
        return wholeCents;
      }

    case "truncate":
      // Always round down
      return wholeCents;

    default:
      // Programmer error
      const exhaustive: never = mode;
      throw new Error(`Unknown rounding mode: ${exhaustive}`);
  }
}

/**
 * Compute Merchandise Processing Fee (MPF) based on total dutiable value.
 *
 * MPF is calculated as 0.3464% of the dutiable value (after subtracting FTA-exempt portions),
 * rounded to cents, and clamped to a minimum and maximum.
 *
 * @param totalDutiableValueCents - Total dutiable value in integer cents (e.g., 100000 for $1000.00)
 * @param ftaExemptValues - Array of FTA-exempt values in cents to subtract. Defaults to empty array.
 * @returns RuleResult<number>
 *   - OkResult: MPF amount in cents, clamped to [min, max] range
 *   - NeedsReview: If total is negative or non-integer
 *
 * @throws Error if totalDutiableValueCents is not an integer (type violation—fail fast)
 * @throws Error if any exempt value is not an integer (type violation—fail fast)
 *
 * Computation steps:
 * 1. Validate totalDutiableValueCents is a non-negative integer
 * 2. Validate all exempt values are non-negative integers
 * 3. Calculate base = max(0, total - sum(exempt))
 * 4. Calculate raw = 3464 * base / 1_000_000, rounded halfUp to cents
 * 5. Clamp result to [minimumCents, maximumCents]
 *
 * Examples (using config: rate=3464 ppm, min=$34.58, max=$670.86):
 * - 330600 cents ($3306.00) → 3458 cents ($34.58, at minimum)
 * - 2000000 cents ($20000.00) → 6928 cents ($69.28)
 * - 50000000 cents ($500000.00) → 67086 cents ($670.86, at maximum)
 * - -1 cents → NeedsReview (negative)
 * - Infinity → Error (non-integer)
 *
 * Rate note: 3464 parts per million = 0.3464% = 3464 / 1_000_000
 */
export function computeMPF(
  totalDutiableValueCents: number,
  ftaExemptValues: number[] = []
): RuleResult<number> {
  // Type check: totalDutiableValueCents must be an integer
  if (!Number.isInteger(totalDutiableValueCents)) {
    return {
      ok: false,
      reason: `Expected integer cents for totalDutiableValueCents, got ${totalDutiableValueCents}. Cents must be a whole number.`,
    };
  }

  // Validate all exempt values are integers
  for (let i = 0; i < ftaExemptValues.length; i++) {
    if (!Number.isInteger(ftaExemptValues[i])) {
      return {
        ok: false,
        reason: `Expected integer cents for ftaExemptValues[${i}], got ${ftaExemptValues[i]}. Cents must be a whole number.`,
      };
    }
  }

  // Business rule check: totalDutiableValueCents must be non-negative
  if (totalDutiableValueCents < 0) {
    return {
      ok: false,
      reason: `Total dutiable value must be non-negative. Received ${totalDutiableValueCents} cents (${(totalDutiableValueCents / 100).toFixed(2)} dollars).`,
    };
  }

  // Calculate the sum of exempt values
  const sumExempt = ftaExemptValues.reduce((acc, val) => acc + val, 0);

  // Calculate base = max(0, total - sum(exempt))
  const base = Math.max(0, totalDutiableValueCents - sumExempt);

  // Calculate raw MPF: rate * base / 1_000_000
  // Result is in fractional cents
  const rawCents = (config.mpfRate * base) / 1_000_000;

  // Round to integer cents using the configured rounding mode
  const rawCentsRounded = roundCents(rawCents, config.mpfCentsRounding);

  // Clamp to [minimum, maximum]
  const clamped = Math.max(
    config.mpfMinimumCents,
    Math.min(rawCentsRounded, config.mpfMaximumCents)
  );

  return {
    ok: true,
    value: clamped,
  };
}
