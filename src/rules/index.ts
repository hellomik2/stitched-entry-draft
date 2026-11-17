/**
 * src/rules/index.ts
 *
 * Public re-exports for all rule functions and types.
 *
 * This is the single entry point for importing Calculator rules and types.
 */

// Re-export types
export type {
  OkResult,
  NeedsReview,
  RuleResult,
  RoundingMode,
  AllocatedWeight,
  NumberedLineItem,
} from "./types";

// Re-export rounding functions (P4)
export { roundEnteredValue } from "./rounding";

// Re-export totals functions (P5, P10)
export { totalEnteredValue, summarizeTotals } from "./totals";

// Re-export charges functions (P6)
export { formatCharges } from "./charges";

// Re-export duty functions (P7)
export { computeDuty } from "./duty";

// Re-export fees functions (P8)
export { computeMPF } from "./fees";

// Re-export weights functions (P11)
export { allocateGrossWeight } from "./weights";

// Re-export config and validation
export {
  mpfConfig,
  totalEnteredValueMode,
  chargesRounding,
  dutyBase,
  dutyCentsRounding,
  mpfCentsRounding,
  grossWeightDecimals,
  maxLineNumber,
  validateConfig,
} from "./config";
