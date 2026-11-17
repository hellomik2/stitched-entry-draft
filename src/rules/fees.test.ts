/**
 * src/rules/fees.test.ts
 *
 * Example tests for P8 (Merchandise Processing Fee) using worked examples.
 *
 * Tests validate correct computation of MPF based on confirmed rates and
 * configuration values from CBP Form 7501 instructions and MPF notice.
 */

import { describe, it, expect } from "vitest";
import { computeMPF } from "./fees";

describe("computeMPF() - Example Tests", () => {
  /**
   * Example 1: Small base value (at minimum)
   *
   * Dutiable value: $3306.00 = 330,600 cents
   * Computation: 330,600 * 3464 / 1,000,000 = 1,144.66 cents ≈ 1,145 cents (halfUp)
   * This is less than minimum ($34.58 = 3,458 cents), so clamp to minimum.
   * Result: 3,458 cents ($34.58)
   */
  it("Example 1: Small base clamps to minimum", () => {
    const result = computeMPF(330600);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(3458);
    }
  });

  /**
   * Example 2: Medium base value (within range)
   *
   * Dutiable value: $20,000.00 = 2,000,000 cents
   * Computation: 2,000,000 * 3464 / 1,000,000 = 6,928 cents
   * This is within [3,458, 67,086], so use computed value.
   * Result: 6,928 cents ($69.28)
   */
  it("Example 2: Medium base computes directly", () => {
    const result = computeMPF(2000000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(6928);
    }
  });

  /**
   * Example 3: Large base value (at maximum)
   *
   * Dutiable value: $500,000.00 = 50,000,000 cents
   * Computation: 50,000,000 * 3464 / 1,000,000 = 173,200 cents
   * This exceeds maximum ($670.86 = 67,086 cents), so clamp to maximum.
   * Result: 67,086 cents ($670.86)
   */
  it("Example 3: Large base clamps to maximum", () => {
    const result = computeMPF(50000000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(67086);
    }
  });

  /**
   * Example 4: Negative base returns NeedsReview
   *
   * Dutiable value: -1 cents (negative, invalid)
   * Should return NeedsReview, not throw.
   */
  it("Example 4: Negative base returns NeedsReview", () => {
    const result = computeMPF(-1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("non-negative");
    }
  });

  /**
   * Example 5: Non-integer base returns NeedsReview
   *
   * Dutiable value: 1.5 cents (non-integer, invalid)
   * Should return NeedsReview, not throw.
   */
  it("Example 5: Non-integer base returns NeedsReview", () => {
    const result = computeMPF(1.5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("integer");
    }
  });

  /**
   * Example 6: With FTA exempt deduction
   *
   * Dutiable value (before exempt): $20,000.00 = 2,000,000 cents
   * FTA-exempt value: $10,000.00 = 1,000,000 cents
   * Effective base: 2,000,000 - 1,000,000 = 1,000,000 cents
   * Computation: 1,000,000 * 3464 / 1,000,000 = 3,464 cents
   * This is within [3,458, 67,086], so use computed value.
   * Result: 3,464 cents ($34.64)
   */
  it("Example 6: FTA exempt deduction reduces base", () => {
    const result = computeMPF(2000000, [1000000]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(3464);
    }
  });

  /**
   * Example 7: Non-integer exempt value returns NeedsReview
   *
   * Should return NeedsReview when exempt value is not an integer.
   */
  it("Example 7: Non-integer exempt value returns NeedsReview", () => {
    const result = computeMPF(2000000, [500.5]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("integer");
    }
  });

  /**
   * Example 8: Zero base returns minimum
   *
   * Dutiable value: $0.00 = 0 cents
   * Computation: 0 * 3464 / 1,000,000 = 0 cents
   * This is less than minimum ($34.58 = 3,458 cents), so clamp to minimum.
   * Result: 3,458 cents ($34.58)
   */
  it("Example 8: Zero base returns minimum", () => {
    const result = computeMPF(0, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(3458);
    }
  });

  /**
   * Example 9: Multiple FTA exempt deductions
   *
   * Dutiable value (before exempt): $50,000.00 = 5,000,000 cents
   * FTA-exempt values: $10,000.00 = 1,000,000 cents, $20,000.00 = 2,000,000 cents
   * Total exempt: 3,000,000 cents
   * Effective base: 5,000,000 - 3,000,000 = 2,000,000 cents
   * Computation: 2,000,000 * 3464 / 1,000,000 = 6,928 cents
   * Result: 6,928 cents ($69.28)
   */
  it("Example 9: Multiple FTA exempt values sum to deduction", () => {
    const result = computeMPF(5000000, [1000000, 2000000]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(6928);
    }
  });

  /**
   * Example 10: Empty exempt array
   *
   * Should behave the same as calling with default empty array.
   * Dutiable value: $20,000.00 = 2,000,000 cents
   * Result: 6,928 cents ($69.28)
   */
  it("Example 10: Empty exempt array same as default", () => {
    const result1 = computeMPF(2000000);
    const result2 = computeMPF(2000000, []);
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value).toBe(result2.value);
    }
  });
});
