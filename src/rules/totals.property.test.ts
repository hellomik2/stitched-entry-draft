/**
 * src/rules/totals.property.test.ts
 *
 * Property-based tests for P5 (Total Entered Value) using fast-check.
 *
 * Tests validate universal correctness properties that should hold across
 * all valid inputs and both rounding modes.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { totalEnteredValue } from "./totals";
import { roundEnteredValue } from "./rounding";

describe("totalEnteredValue() - Property-Based Tests", () => {
  /**
   * Property 4: Sum of Rounded Lines
   *
   * For any non-empty list of non-negative cents values, computing the total
   * in `sumOfRoundedLines` mode SHALL equal the sum of individually rounded values.
   *
   * **Validates: Requirements 2.1**
   */
  it("Property 4: sumOfRoundedLines equals sum of individually rounded lines", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (linesCents) => {
          // Compute total using sumOfRoundedLines mode
          const result = totalEnteredValue(linesCents, "sumOfRoundedLines");
          expect(result.ok).toBe(true);

          if (!result.ok) return; // Type guard

          // Manually compute sum of individually rounded lines
          let expectedTotal = 0;
          for (const lineCents of linesCents) {
            const roundingResult = roundEnteredValue(lineCents);
            expect(roundingResult.ok).toBe(true);
            if (roundingResult.ok) {
              expectedTotal += roundingResult.value;
            }
          }

          // Verify they match
          expect(result.value).toBe(expectedTotal);
        }
      )
    );
  });

  /**
   * Property 5: Round Sum of Exact Lines
   *
   * For any non-empty list of non-negative cents values, computing the total
   * in `roundSumOfExactLines` mode SHALL equal the result of rounding the sum
   * of all exact values.
   *
   * **Validates: Requirements 2.2**
   */
  it("Property 5: roundSumOfExactLines equals P4(sum of all exact values)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (linesCents) => {
          // Compute total using roundSumOfExactLines mode
          const result = totalEnteredValue(linesCents, "roundSumOfExactLines");
          expect(result.ok).toBe(true);

          if (!result.ok) return; // Type guard

          // Manually compute sum of all exact cents
          const totalCents = linesCents.reduce((sum, cents) => sum + cents, 0);

          // Apply P4 rounding to the total
          const roundingResult = roundEnteredValue(totalCents);
          expect(roundingResult.ok).toBe(true);

          if (roundingResult.ok) {
            // Verify they match
            expect(result.value).toBe(roundingResult.value);
          }
        }
      )
    );
  });

  /**
   * Property 6: Monotonicity
   *
   * For any list of lines and any non-negative cents value v, the total
   * for the list with v appended SHALL be greater than or equal to the total
   * for the original list (in both modes).
   *
   * **Validates: Requirements 2.4**
   */
  it("Property 6: Adding non-negative value increases or maintains total (sumOfRoundedLines)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), {
          maxLength: 100,
        }),
        fc.integer({ min: 0, max: 10000 }),
        (originalLines, newValue) => {
          // Compute total for original list
          const originalResult = totalEnteredValue(originalLines, "sumOfRoundedLines");
          expect(originalResult.ok).toBe(true);

          if (!originalResult.ok) return;

          // Compute total with new value appended
          const newLines = [...originalLines, newValue];
          const newResult = totalEnteredValue(newLines, "sumOfRoundedLines");
          expect(newResult.ok).toBe(true);

          if (!newResult.ok) return;

          // Verify monotonicity: new total >= original total
          expect(newResult.value).toBeGreaterThanOrEqual(originalResult.value);
        }
      )
    );
  });

  /**
   * Property 6 (continued): Monotonicity for roundSumOfExactLines mode
   */
  it("Property 6: Adding non-negative value increases or maintains total (roundSumOfExactLines)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), {
          maxLength: 100,
        }),
        fc.integer({ min: 0, max: 10000 }),
        (originalLines, newValue) => {
          // Compute total for original list
          const originalResult = totalEnteredValue(
            originalLines,
            "roundSumOfExactLines"
          );
          expect(originalResult.ok).toBe(true);

          if (!originalResult.ok) return;

          // Compute total with new value appended
          const newLines = [...originalLines, newValue];
          const newResult = totalEnteredValue(newLines, "roundSumOfExactLines");
          expect(newResult.ok).toBe(true);

          if (!newResult.ok) return;

          // Verify monotonicity: new total >= original total
          expect(newResult.value).toBeGreaterThanOrEqual(originalResult.value);
        }
      )
    );
  });

  /**
   * Property 7: Single Line Equivalence
   *
   * For any single-line list, the total in either mode SHALL equal the
   * individually rounded value of that line.
   *
   * **Validates: Requirements 2.5**
   */
  it("Property 7: Single-line list equals individually rounded value (sumOfRoundedLines)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10000 }), (lineCents) => {
        // Compute total for single-line list
        const result = totalEnteredValue([lineCents], "sumOfRoundedLines");
        expect(result.ok).toBe(true);

        if (!result.ok) return;

        // Compute P4 rounding of that line
        const roundingResult = roundEnteredValue(lineCents);
        expect(roundingResult.ok).toBe(true);

        if (roundingResult.ok) {
          // Verify they match
          expect(result.value).toBe(roundingResult.value);
        }
      })
    );
  });

  /**
   * Property 7 (continued): Single-line equivalence for roundSumOfExactLines
   */
  it("Property 7: Single-line list equals individually rounded value (roundSumOfExactLines)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10000 }), (lineCents) => {
        // Compute total for single-line list
        const result = totalEnteredValue([lineCents], "roundSumOfExactLines");
        expect(result.ok).toBe(true);

        if (!result.ok) return;

        // Compute P4 rounding of that line (which is the same as rounding the sum)
        const roundingResult = roundEnteredValue(lineCents);
        expect(roundingResult.ok).toBe(true);

        if (roundingResult.ok) {
          // Verify they match
          expect(result.value).toBe(roundingResult.value);
        }
      })
    );
  });

  /**
   * Property 8: Commutativity
   *
   * For any list of lines, reordering the list SHALL not change the total
   * in either mode.
   *
   * **Validates: Requirements 2.6**
   */
  it("Property 8: Reordering lines does not change total (sumOfRoundedLines)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (originalLines) => {
          // Compute total for original order
          const originalResult = totalEnteredValue(
            originalLines,
            "sumOfRoundedLines"
          );
          expect(originalResult.ok).toBe(true);

          if (!originalResult.ok) return;

          // Create a shuffled copy
          const shuffledLines = [...originalLines].sort(
            () => Math.random() - 0.5
          );

          // Compute total for shuffled order
          const shuffledResult = totalEnteredValue(
            shuffledLines,
            "sumOfRoundedLines"
          );
          expect(shuffledResult.ok).toBe(true);

          if (!shuffledResult.ok) return;

          // Verify they match
          expect(shuffledResult.value).toBe(originalResult.value);
        }
      )
    );
  });

  /**
   * Property 8 (continued): Commutativity for roundSumOfExactLines
   */
  it("Property 8: Reordering lines does not change total (roundSumOfExactLines)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (originalLines) => {
          // Compute total for original order
          const originalResult = totalEnteredValue(
            originalLines,
            "roundSumOfExactLines"
          );
          expect(originalResult.ok).toBe(true);

          if (!originalResult.ok) return;

          // Create a shuffled copy
          const shuffledLines = [...originalLines].sort(
            () => Math.random() - 0.5
          );

          // Compute total for shuffled order
          const shuffledResult = totalEnteredValue(
            shuffledLines,
            "roundSumOfExactLines"
          );
          expect(shuffledResult.ok).toBe(true);

          if (!shuffledResult.ok) return;

          // Verify they match
          expect(shuffledResult.value).toBe(originalResult.value);
        }
      )
    );
  });

  /**
   * Property 9: Mode Difference Bound
   *
   * For any list of N lines, the absolute difference between `sumOfRoundedLines`
   * and `roundSumOfExactLines` modes SHALL not exceed 50 * N cents.
   *
   * **Validates: Requirements 2.7**
   */
  it("Property 9: Mode difference bounded by 50*N cents", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (linesCents) => {
          // Compute total in sumOfRoundedLines mode
          const result1 = totalEnteredValue(linesCents, "sumOfRoundedLines");
          expect(result1.ok).toBe(true);

          if (!result1.ok) return;

          // Compute total in roundSumOfExactLines mode
          const result2 = totalEnteredValue(linesCents, "roundSumOfExactLines");
          expect(result2.ok).toBe(true);

          if (!result2.ok) return;

          // Compute difference in cents (convert dollars to cents)
          const diff = Math.abs(result1.value - result2.value) * 100;

          // Calculate bound: 50 * N cents
          const bound = 50 * linesCents.length;

          // Verify difference is within bound
          expect(diff).toBeLessThanOrEqual(bound);
        }
      )
    );
  });

  /**
   * Property 10: Empty List
   *
   * For an empty list of lines, the total SHALL be 0 in either mode.
   *
   * **Validates: Requirements 2.8**
   */
  it("Property 10: Empty list returns 0 (sumOfRoundedLines)", () => {
    const result = totalEnteredValue([], "sumOfRoundedLines");
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });

  it("Property 10: Empty list returns 0 (roundSumOfExactLines)", () => {
    const result = totalEnteredValue([], "roundSumOfExactLines");
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });

  it("Property 10: Empty list returns 0 (default mode)", () => {
    const result = totalEnteredValue([]);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });

  /**
   * Negative Line Values Rejection
   *
   * For any list containing negative values, the function SHALL return
   * a NeedsReview result.
   *
   * **Validates: Requirements 2.9 (input validation)**
   */
  it("Negative line values are rejected", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.array(fc.integer({ min: 0, max: 10000 }), { maxLength: 5 }),
          fc.integer({ min: -10000, max: -1 }),
          fc.array(fc.integer({ min: 0, max: 10000 }), { maxLength: 5 })
        ),
        ([before, negative, after]) => {
          const linesCents = [...before, negative, ...after];
          const result = totalEnteredValue(linesCents);

          // Should return NeedsReview
          expect(result.ok).toBe(false);

          if (!result.ok) {
            // Verify reason mentions non-negative requirement
            expect(result.reason).toContain("non-negative");
          }
        }
      )
    );
  });

  /**
   * Default Mode Behavior
   *
   * When no mode is specified, the function SHALL default to
   * config.totalEnteredValueMode (sumOfRoundedLines by default).
   *
   * **Validates: Requirements 2.3 (default behavior)**
   */
  it("Default mode behaves as sumOfRoundedLines", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (linesCents) => {
          // Compute with explicit mode
          const explicitResult = totalEnteredValue(
            linesCents,
            "sumOfRoundedLines"
          );
          expect(explicitResult.ok).toBe(true);

          if (!explicitResult.ok) return;

          // Compute with default mode
          const defaultResult = totalEnteredValue(linesCents);
          expect(defaultResult.ok).toBe(true);

          if (!defaultResult.ok) return;

          // Verify they match
          expect(defaultResult.value).toBe(explicitResult.value);
        }
      )
    );
  });

  /**
   * Edge Case: All Zeros
   *
   * For a list of all zeros, the total SHALL be 0 in both modes.
   */
  it("List of all zeros returns 0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        (count) => {
          const zeros = new Array(count).fill(0);

          const result1 = totalEnteredValue(zeros, "sumOfRoundedLines");
          expect(result1.ok).toBe(true);
          if (result1.ok) expect(result1.value).toBe(0);

          const result2 = totalEnteredValue(zeros, "roundSumOfExactLines");
          expect(result2.ok).toBe(true);
          if (result2.ok) expect(result2.value).toBe(0);
        }
      )
    );
  });

  /**
   * Edge Case: Large Values
   *
   * The function should handle large cent values without overflow.
   */
  it("Handles large cent values correctly", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9999999 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (linesCents) => {
          // Both modes should succeed
          const result1 = totalEnteredValue(linesCents, "sumOfRoundedLines");
          expect(result1.ok).toBe(true);

          const result2 = totalEnteredValue(linesCents, "roundSumOfExactLines");
          expect(result2.ok).toBe(true);

          // Results should be reasonable (non-negative)
          if (result1.ok) expect(result1.value).toBeGreaterThanOrEqual(0);
          if (result2.ok) expect(result2.value).toBeGreaterThanOrEqual(0);
        }
      )
    );
  });
});
