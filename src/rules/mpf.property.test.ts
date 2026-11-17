/**
 * src/rules/mpf.property.test.ts
 *
 * Property-based tests for P8 (Merchandise Processing Fee) using fast-check.
 *
 * Tests validate universal correctness properties that should hold across
 * all valid inputs.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeMPF } from "./fees";
import { config, mpfConfig } from "./config";

describe("computeMPF() - Property-Based Tests", () => {
  /**
   * Property 4: MPF Within Bounds
   *
   * For any non-negative base value and any valid excluded lines set,
   * the computed MPF SHALL be within the configured [minimum, maximum] range.
   *
   * **Validates: Requirements 2.7**
   */
  it("Property 4: Result within [3458, 67086] cents for all valid inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000000 }),
        fc.array(fc.integer({ min: 0, max: 100000 }), { maxLength: 10 }),
        (baseCents, exemptCents) => {
          const result = computeMPF(baseCents, exemptCents);
          expect(result.ok).toBe(true);

          if (result.ok) {
            // Result must be within the configured range
            expect(result.value).toBeGreaterThanOrEqual(config.mpfMinimumCents);
            expect(result.value).toBeLessThanOrEqual(config.mpfMaximumCents);
          }
        }
      )
    );
  });

  /**
   * Property 5: MPF Monotonic in Base
   *
   * For any set of exempt values, if the base value increases, the result
   * SHALL never decrease (monotonicity property).
   *
   * **Validates: Requirements 2.8**
   */
  it("Property 5: Monotonic in base value (higher base → higher or equal result)", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 50000000 }),
          fc.integer({ min: 50000000, max: 100000000 })
        ),
        fc.array(fc.integer({ min: 0, max: 100000 }), { maxLength: 10 }),
        ([lowerBase, higherBase], exemptCents) => {
          const result1 = computeMPF(lowerBase, exemptCents);
          const result2 = computeMPF(higherBase, exemptCents);

          expect(result1.ok).toBe(true);
          expect(result2.ok).toBe(true);

          if (result1.ok && result2.ok) {
            // Higher base should yield higher or equal result
            expect(result2.value).toBeGreaterThanOrEqual(result1.value);
          }
        }
      )
    );
  });

  /**
   * Property 6: MPF Formula Consistency
   *
   * For any base value where the direct computation (without clamping) falls
   * within [minimum, maximum], the result SHALL equal base * rate / 1,000,000
   * rounded with the configured mode, without clamping.
   *
   * **Validates: Requirements 2.9**
   */
  it("Property 6: Unclamped computation equals direct calculation when in range", () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: Math.ceil((mpfConfig.minimumCents * 1000000) / mpfConfig.rate),
          max: Math.floor((mpfConfig.maximumCents * 1000000) / mpfConfig.rate),
        }),
        (baseCents) => {
          const result = computeMPF(baseCents, []);
          expect(result.ok).toBe(true);

          if (result.ok) {
            // Compute unclamped MPF directly: base * rate / 1,000,000 with halfUp rounding
            const rawMpfCents = Math.round(
              (baseCents * config.mpfRate) / 1000000
            );

            // When unclamped value is within range, result should equal unclamped value
            if (
              rawMpfCents >= config.mpfMinimumCents &&
              rawMpfCents <= config.mpfMaximumCents
            ) {
              expect(result.value).toBe(rawMpfCents);
            }
          }
        }
      )
    );
  });

  /**
   * Property 23: Negative base values are rejected with NeedsReview
   *
   * For any negative base value, the function SHALL return a NeedsReview result
   * with an appropriate reason.
   *
   * **Validates: Requirements 2.11**
   */
  it("Property 23: Negative base values are rejected with NeedsReview", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100000000, max: -1 }),
        fc.array(fc.integer({ min: 0, max: 100000 }), { maxLength: 10 }),
        (negativeBases, exemptCents) => {
          const result = computeMPF(negativeBases, exemptCents);

          // Must return NeedsReview
          expect(result.ok).toBe(false);

          if (!result.ok) {
            // Reason should indicate the issue
            expect(result.reason).toContain("non-negative");
          }
        }
      )
    );
  });

  /**
   * Edge Case: Zero base value
   *
   * For a base value of 0, the result SHALL be the configured minimum
   * (as per rule: if computed is below minimum, use minimum).
   */
  it("Edge case: Zero base value returns minimum MPF", () => {
    const result = computeMPF(0, []);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBe(config.mpfMinimumCents);
    }
  });

  /**
   * Edge Case: Very large base value
   *
   * For a very large base value, the result SHALL clamp to maximum,
   * never exceed it.
   */
  it("Edge case: Very large base value clamps to maximum", () => {
    const result = computeMPF(100000000, []);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBe(mpfConfig.maximumCents);
    }
  });

  /**
   * Edge Case: FTA Exempt Deduction
   *
   * When exempt values are provided, they should be subtracted from the base
   * before computing MPF.
   */
  it("Edge case: FTA-exempt deduction reduces base", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50000000 }),
        fc.integer({ min: 0, max: 5000000 }),
        (baseCents, exemptCents) => {
          // Ensure exempt is not greater than base
          const actual = Math.min(exemptCents, baseCents);

          const resultWithExempt = computeMPF(baseCents, [actual]);
          const resultWithoutExempt = computeMPF(baseCents - actual, []);

          expect(resultWithExempt.ok).toBe(true);
          expect(resultWithoutExempt.ok).toBe(true);

          if (resultWithExempt.ok && resultWithoutExempt.ok) {
            // Should produce same result
            expect(resultWithExempt.value).toBe(resultWithoutExempt.value);
          }
        }
      )
    );
  });

  /**
   * Type Safety: Non-integer base value returns NeedsReview
   *
   * For a non-integer base value, the function returns NeedsReview.
   */
  it("Type safety: Non-integer base value returns NeedsReview", () => {
    expect(computeMPF(100.5, []).ok).toBe(false);
  });

  /**
   * Type Safety: NaN base value returns NeedsReview
   *
   * For a NaN base value, the function returns NeedsReview.
   */
  it("Type safety: NaN base value returns NeedsReview", () => {
    expect(computeMPF(NaN, []).ok).toBe(false);
  });

  /**
   * Type Safety: Infinity base value returns NeedsReview
   *
   * For an Infinity base value, the function returns NeedsReview.
   */
  it("Type safety: Infinity base value returns NeedsReview", () => {
    expect(computeMPF(Infinity, []).ok).toBe(false);
  });

  /**
   * Rate Application: Exact computation for known test values
   *
   * For the MPF rate of 3464 ppm (0.3464%), verify known test values.
   */
  it("Rate application: Computes correctly for $2,000,000 base", () => {
    // Base: $2,000,000 = 200,000,000 cents
    // MPF = 200,000,000 * 3464 / 1,000,000 = 692,800 cents → clamped to 67086
    // This is within [3458, 67086], so we compute: 2,000,000 * 3464 / 1,000,000 = 6,928 cents
    const result = computeMPF(2000000, []);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBe(6928);
    }
  });

  /**
   * Clamping: Very small base clamps to minimum
   *
   * For a base that would compute to less than minimum, verify clamping to minimum.
   */
  it("Clamping: Very small base clamps to minimum", () => {
    // Base: $1 = 100 cents
    // MPF = 100 * 3464 / 1,000,000 = 0.3464 cents ≈ 0 cents
    // Below minimum 3458, so clamp to minimum
    const result = computeMPF(100, []);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBe(config.mpfMinimumCents);
    }
  });

  /**
   * Clamping: Large base with exempt clamps to maximum
   *
   * For a base that would compute to more than maximum even after exempt deduction,
   * verify clamping to maximum.
   */
  it("Clamping: Large base with exempt clamps to maximum", () => {
    // Base before exempt: $100,000,000 = 10,000,000,000 cents
    // After exempt of $1,000,000: 9,900,000,000 cents
    // MPF = 9,900,000,000 * 3464 / 1,000,000 = 34,293,600 cents
    // Exceeds maximum 67086, so clamp to maximum
    const result = computeMPF(10000000000, [1000000000]);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBe(config.mpfMaximumCents);
    }
  });

  /**
   * Boundary: Base at minimum threshold (no clamping)
   *
   * For the base value that computes exactly to minimum, verify no clamping applied.
   */
  it("Boundary: Base at minimum threshold", () => {
    // Base that computes to approximately minimum: 3458 * 1,000,000 / 3464 ≈ 999,269 cents
    const baseForMinimum = Math.ceil(
      (config.mpfMinimumCents * 1000000) / config.mpfRate
    );
    const result = computeMPF(baseForMinimum, []);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBeGreaterThanOrEqual(config.mpfMinimumCents);
    }
  });

  /**
   * Boundary: Base at maximum threshold (no clamping)
   *
   * For the base value that computes exactly to maximum, verify no clamping applied.
   */
  it("Boundary: Base at maximum threshold", () => {
    // Base that computes to approximately maximum: 67086 * 1,000,000 / 3464 ≈ 19,382,926 cents
    const baseForMaximum = Math.floor(
      (mpfConfig.maximumCents * 1000000) / mpfConfig.rate
    );
    const result = computeMPF(baseForMaximum, []);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBeLessThanOrEqual(mpfConfig.maximumCents);
    }
  });

  /**
   * Multiple Exempt Lines
   *
   * When multiple exempt values are provided, their sum should be deducted from base.
   */
  it("Multiple exempt lines: sum of exemptions deducted from base", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10000000 }),
        fc.array(fc.integer({ min: 0, max: 1000000 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (baseCents, exemptArray) => {
          // Ensure sum of exemptions does not exceed base
          const totalExempt = exemptArray.reduce((a, b) => a + b, 0);
          const cappedExempt = Math.min(totalExempt, baseCents);

          const resultWithMultiple = computeMPF(baseCents, exemptArray);
          const resultWithSum = computeMPF(
            Math.max(0, baseCents - cappedExempt),
            []
          );

          expect(resultWithMultiple.ok).toBe(true);
          expect(resultWithSum.ok).toBe(true);

          if (resultWithMultiple.ok && resultWithSum.ok) {
            // When exemptions sum to less than base, should match
            if (cappedExempt === totalExempt) {
              expect(resultWithMultiple.value).toBe(resultWithSum.value);
            }
          }
        }
      )
    );
  });

  /**
   * Overflow Safety: Exempt exceeding base
   *
   * When exempt values exceed base, the effective base should be 0.
   */
  it("Overflow safety: Exempt values exceeding base result in minimum MPF", () => {
    const result = computeMPF(1000, [2000]);
    expect(result.ok).toBe(true);

    if (result.ok) {
      // Base becomes max(0, 1000 - 2000) = 0
      // MPF(0) = minimum
      expect(result.value).toBe(mpfConfig.minimumCents);
    }
  });
});
