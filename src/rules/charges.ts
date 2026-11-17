import type { RuleResult, RoundingMode } from "./types";
import { config } from "./config";
import { roundEnteredValue } from "./rounding";

/**
 * Formats freight and other charges as a string matching the pattern C<digits>.
 *
 * This implements the P6 rule for Column 36B (7501 p.18).
 *
 * Algorithm:
 * 1. If transportCode === "60" (passenger, hand-carried): return "C0" regardless of cents
 * 2. If cents < 0: return NeedsReview
 * 3. Round cents/100 to whole dollars using the specified rounding mode
 * 4. Return OkResult(`C${dollars}`)
 *
 * @param cents - Non-negative integer cents value
 * @param transportCode - Optional mode of transportation code (e.g., "60" for hand-carry)
 * @param mode - Optional rounding mode (defaults to config.chargesRounding)
 * @returns OkResult with formatted charges string (e.g., "C550"), or NeedsReview if invalid
 * @throws Error if cents is not an integer
 */
export function formatCharges(
  cents: number,
  transportCode?: string,
  mode?: RoundingMode
): RuleResult<string> {
  // Special case: transport code 60 (passenger, hand-carried) always yields C0
  if (transportCode === "60") {
    return { ok: true, value: "C0" };
  }

  // Type check: must be integer (delegated to roundEnteredValue)
  // This will throw if cents is not an integer
  const roundResult = roundEnteredValue(cents, mode);

  // If rounding failed (e.g., negative cents), return the error
  if (!roundResult.ok) {
    return roundResult;
  }

  const dollars = roundResult.value;

  // Format as C<dollars>
  const formatted = `C${dollars}`;

  return { ok: true, value: formatted };
}
