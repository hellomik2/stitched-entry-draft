import type { RoundingMode } from "./types";

/**
 * Rounding mode type - re-exported from types for convenience.
 * - halfUp: Round 0.5 up (default)
 * - halfDown: Round 0.5 down
 * - halfEven: Round 0.5 to nearest even
 * - truncate: Truncate (always round down)
 */
export type { RoundingMode };

/**
 * MPF (Merchandise Processing Fee) configuration for fiscal year 2027.
 * Source: CBP Dec. 26-14
 * Effective date: October 1, 2026
 */
export const mpfConfig = {
  rate: 3464, // PPM (0.3464%)
  minimumCents: 3458, // $34.58
  maximumCents: 67086, // $670.86
  effectiveDate: "2026-10-01",
} as const;

/**
 * Total Entered Value computation mode.
 * Default: "sumOfRoundedLines"
 * - sumOfRoundedLines: Round each line individually, then sum
 * - roundSumOfExactLines: Sum all exact values, then round total
 */
export const totalEnteredValueMode = "sumOfRoundedLines" as const;

/**
 * Default rounding mode for charges (Column 36B, P6).
 * Default: "halfUp"
 */
export const chargesRounding: RoundingMode = "halfUp";

/**
 * Duty computation base mode (P7).
 * Default: "roundedEnteredValue"
 * - roundedEnteredValue: Use P4-rounded entered value as duty base
 * - exactEnteredValue: Use exact line value in cents as duty base
 */
export const dutyBase = "roundedEnteredValue" as const;

/**
 * Default rounding mode for duty computation in cents (Column 38, P7).
 * Default: "halfUp"
 */
export const dutyCentsRounding: RoundingMode = "halfUp";

/**
 * Default rounding mode for MPF computation in cents (P8).
 * Default: "halfUp"
 */
export const mpfCentsRounding: RoundingMode = "halfUp";

/**
 * Number of decimal places for gross weight allocation (Column 34A, P11).
 * Default: 0 (whole kilograms)
 * Allowed: 0-6 decimal places
 */
export const grossWeightDecimals = 0;

/**
 * Maximum number of line items allowed on a single entry (P18).
 * Default: 999
 * CBP Form 7501 supports line numbers 001–999
 */
export const maxLineNumber = 999;

/**
 * Config interface representing all configuration settings.
 * All settings are centralized here to enable fiscal-year and rule-change updates
 * without modifying the rule implementations.
 */
export interface Config {
  /** MPF rate in parts per million (3464 = 0.3464%) */
  readonly mpfRate: number;
  /** MPF minimum in cents ($34.58) */
  readonly mpfMinimumCents: number;
  /** MPF maximum in cents ($670.86) */
  readonly mpfMaximumCents: number;
  /** MPF effective date (YYYY-MM-DD format) */
  readonly mpfEffectiveDate: string;
  /** Total entered value computation mode */
  readonly totalEnteredValueMode: "sumOfRoundedLines" | "roundSumOfExactLines";
  /** Default rounding mode for charges (P6) */
  readonly chargesRounding: RoundingMode;
  /** Duty computation base mode (P7) */
  readonly dutyBase: "roundedEnteredValue" | "exactEnteredValue";
  /** Default rounding mode for duty in cents (P7) */
  readonly dutyCentsRounding: RoundingMode;
  /** Default rounding mode for MPF in cents (P8) */
  readonly mpfCentsRounding: RoundingMode;
  /** Number of decimal places for gross weight allocation (P11) */
  readonly grossWeightDecimals: number;
  /** Maximum line number allowed (P18) */
  readonly maxLineNumber: number;
  /** Column 2 country codes (embargo) that trigger needs review for rates */
  readonly column2Countries: readonly string[];
}

/**
 * Default configuration instance.
 * This is the single source of truth for all configuration values.
 * All rule functions read from this instance.
 */
export const config: Config = {
  mpfRate: mpfConfig.rate,
  mpfMinimumCents: mpfConfig.minimumCents,
  mpfMaximumCents: mpfConfig.maximumCents,
  mpfEffectiveDate: mpfConfig.effectiveDate,
  totalEnteredValueMode,
  chargesRounding,
  dutyBase,
  dutyCentsRounding,
  mpfCentsRounding,
  grossWeightDecimals,
  maxLineNumber,
  column2Countries: ["CU", "KP", "RU", "BY"],
};

/**
 * Validates all configuration settings at module load time.
 * Throws an Error if any setting has an invalid value.
 * This function is called automatically when this module is imported.
 *
 * Validation rules:
 * - chargesRounding, dutyCentsRounding, mpfCentsRounding must be valid RoundingMode values
 * - totalEnteredValueMode must be "sumOfRoundedLines" or "roundSumOfExactLines"
 * - dutyBase must be "roundedEnteredValue" or "exactEnteredValue"
 * - grossWeightDecimals must be an integer between 0 and 6 inclusive
 * - maxLineNumber must be an integer between 1 and 999 inclusive
 * - MPF config values must be logically consistent (min <= max, rate > 0, etc.)
 */
export function validateConfig(): void {
  const allowedRoundingModes: readonly RoundingMode[] = ["halfUp", "halfDown", "halfEven", "truncate"];
  const allowedTotalModes = ["sumOfRoundedLines", "roundSumOfExactLines"];
  const allowedDutyBases = ["roundedEnteredValue", "exactEnteredValue"];

  // Validate chargesRounding
  if (!allowedRoundingModes.includes(config.chargesRounding)) {
    throw new Error(
      `Invalid chargesRounding: "${config.chargesRounding}". Must be one of: ${Array.from(allowedRoundingModes).join(", ")}`
    );
  }

  // Validate dutyCentsRounding
  if (!allowedRoundingModes.includes(config.dutyCentsRounding)) {
    throw new Error(
      `Invalid dutyCentsRounding: "${config.dutyCentsRounding}". Must be one of: ${Array.from(allowedRoundingModes).join(", ")}`
    );
  }

  // Validate mpfCentsRounding
  if (!allowedRoundingModes.includes(config.mpfCentsRounding)) {
    throw new Error(
      `Invalid mpfCentsRounding: "${config.mpfCentsRounding}". Must be one of: ${Array.from(allowedRoundingModes).join(", ")}`
    );
  }

  // Validate totalEnteredValueMode
  if (!allowedTotalModes.includes(config.totalEnteredValueMode)) {
    throw new Error(
      `Invalid totalEnteredValueMode: "${config.totalEnteredValueMode}". Must be one of: ${allowedTotalModes.join(", ")}`
    );
  }

  // Validate dutyBase
  if (!allowedDutyBases.includes(config.dutyBase)) {
    throw new Error(
      `Invalid dutyBase: "${config.dutyBase}". Must be one of: ${allowedDutyBases.join(", ")}`
    );
  }

  // Validate grossWeightDecimals
  if (!Number.isInteger(config.grossWeightDecimals) || config.grossWeightDecimals < 0 || config.grossWeightDecimals > 6) {
    throw new Error(
      `Invalid grossWeightDecimals: ${config.grossWeightDecimals}. Must be an integer between 0 and 6 inclusive`
    );
  }

  // Validate maxLineNumber
  if (!Number.isInteger(config.maxLineNumber) || config.maxLineNumber < 1 || config.maxLineNumber > 999) {
    throw new Error(
      `Invalid maxLineNumber: ${config.maxLineNumber}. Must be an integer between 1 and 999 inclusive`
    );
  }

  // Validate MPF config values
  if (config.mpfRate < 0) {
    throw new Error(`Invalid mpfRate: ${config.mpfRate}. Must be non-negative`);
  }

  if (config.mpfMinimumCents < 0) {
    throw new Error(`Invalid mpfMinimumCents: ${config.mpfMinimumCents}. Must be non-negative`);
  }

  if (config.mpfMaximumCents < 0) {
    throw new Error(`Invalid mpfMaximumCents: ${config.mpfMaximumCents}. Must be non-negative`);
  }

  if (config.mpfMinimumCents > config.mpfMaximumCents) {
    throw new Error(
      `Invalid MPF bounds: minimum (${config.mpfMinimumCents}) must be <= maximum (${config.mpfMaximumCents})`
    );
  }
}

// Validate configuration at module initialization
validateConfig();
