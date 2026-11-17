/**
 * src/rules/duty.ts
 *
 * P7: Duty Computation (Column 38 on CBP Form 7501)
 *
 * Computes duty for "Free" and ad valorem HTS rates.
 * All arithmetic uses integer cents only (no floating-point money math).
 * Rates are stored internally as PPM (parts per million).
 */

import type { RuleResult, RoundingMode } from "./types";
import { config } from "./config";
import { roundEnteredValue } from "./rounding";

/**
 * Compute duty in cents from an HTS rate string and a dutiable value.
 *
 * This implements P7 (Duty Computation) from CBP Form 7501, Column 38 (7501 p.19).
 *
 * Algorithm:
 * 1. If rateStr is "Free" (case-insensitive): return OkResult(0)
 * 2. If rateStr matches ^\d+(\.\d+)?% : parse as percentage, convert to PPM
 * 3. If baseMode is "roundedEnteredValue": apply P4 rounding to dutiableValue first
 * 4. Compute duty_cents = ppm * dutiableValue / 1_000_000
 * 5. Round to cents using config.dutyCentsRounding
 * 6. Return OkResult(duty_cents)
 * 7. For unrecognized format or unavailable dutiableValue: return NeedsReview
 *
 * @param rateStr - HTS rate string (e.g., "Free", "4%", "16.5%")
 * @param dutiableValue - Dutiable value in integer cents (the duty base). If null/undefined, NeedsReview.
 * @param baseMode - Optional base mode. Defaults to config.dutyBase.
 *   - "roundedEnteredValue": Apply P4 rounding to dutiableValue first
 *   - "exactEnteredValue": Use dutiableValue as-is
 * @returns OkResult<number> with duty in cents, or NeedsReview if invalid
 * @throws Error if dutiableValue is not an integer (type violation—fail fast)
 */
export function computeDuty(
  rateStr: string,
  dutiableValue: number | null | undefined,
  baseMode?: "roundedEnteredValue" | "exactEnteredValue"
): RuleResult<number> {
  // Handle "Free" rate (case-insensitive)
  if (rateStr.toLowerCase() === "free") {
    return { ok: true, value: 0 };
  }

  // Check if dutiableValue is available
  if (dutiableValue === null || dutiableValue === undefined) {
    return {
      ok: false,
      reason:
        "Dutiable value is unavailable. Cannot compute duty without an entered value basis.",
    };
  }

  // Type check: dutiableValue must be an integer
  if (!Number.isInteger(dutiableValue)) {
    throw new Error(
      `Expected integer cents for dutiable value, got ${dutiableValue}. Cents must be a whole number representing US dollar amounts.`
    );
  }

  // Determine the base mode to use
  const mode = baseMode ?? config.dutyBase;

  // If baseMode is "roundedEnteredValue", apply P4 rounding first
  let baseValue = dutiableValue;
  if (mode === "roundedEnteredValue") {
    const roundResult = roundEnteredValue(dutiableValue, config.dutyCentsRounding);
    if (!roundResult.ok) {
      return roundResult;
    }
    // roundEnteredValue returns dollars, convert back to cents for computation
    baseValue = roundResult.value * 100;
  }

  // Try to parse rateStr as a percentage matching ^\d+(\.\d{1,4})?%
  const percentageMatch = rateStr.match(/^(\d+(?:\.\d{1,4})?)%$/);
  if (!percentageMatch) {
    return {
      ok: false,
      reason: `Unrecognized rate format: "${rateStr}". Expected "Free" or a percentage like "4%" or "16.5%".`,
    };
  }

  // Parse the percentage string to a float
  const percentageValue = parseFloat(percentageMatch[1]);

  // Convert percentage to PPM (parts per million)
  // e.g., 4% = 40000 ppm, 16.5% = 165000 ppm, 0.3464% = 3464 ppm
  const ppm = Math.round(percentageValue * 10000);

  // Compute duty: duty_cents = ppm * baseValue / 1_000_000
  // Using integer arithmetic to avoid floating-point errors
  const dutyExact = (ppm * baseValue) / 1_000_000;

  // Round to cents using applyRoundingMode
  const dutyCents = applyRoundingMode(dutyExact, config.dutyCentsRounding);

  return { ok: true, value: dutyCents };
}

/**
 * Apply the specified rounding mode to a fractional cents value.
 *
 * Helper function used by computeDuty to round the final duty amount.
 * Works with floating-point cents values (e.g., 123.456 cents).
 *
 * @param cents - The value in fractional cents
 * @param mode - The rounding mode to apply
 * @returns The rounded whole-cents integer
 *
 * @throws Error if mode is not recognized (programmer error)
 *
 * Rounding modes:
 * - halfUp: Round 0.5 up. 123.5 → 124.
 * - halfDown: Round up only if > 0.5. 123.5 → 123.
 * - halfEven: Round 0.5 to nearest even. 123.5 → 124 (odd), 124.5 → 124 (even).
 * - truncate: Always round down (discard fractional part).
 */
function applyRoundingMode(cents: number, mode: RoundingMode): number {
  const floor = Math.floor(cents);
  const fraction = cents - floor;

  switch (mode) {
    case "halfUp":
      // Round up if fraction >= 0.5
      return fraction >= 0.5 ? floor + 1 : floor;

    case "halfDown":
      // Round up only if fraction > 0.5
      return fraction > 0.5 ? floor + 1 : floor;

    case "halfEven":
      // Round 0.5 to nearest even
      if (fraction > 0.5) {
        return floor + 1;
      } else if (fraction === 0.5 && floor % 2 === 1) {
        return floor + 1;
      } else {
        return floor;
      }

    case "truncate":
      // Always round down
      return floor;

    default:
      // This should never happen if config is validated
      const exhaustive: never = mode;
      throw new Error(`Unknown rounding mode: ${exhaustive}`);
  }
}
