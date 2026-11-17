/**
 * src/rules/weights.property.test.ts
 *
 * Property-based tests for P11 (Gross Weight Allocation) using fast-check.
 *
 * Tests validate universal correctness properties that should hold across
 * all valid inputs for the largest remainder method weight allocation.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { allocateGrossWeight } from "./weights";

describe("allocateGrossWeight() - Property-Based Tests", () => {
  /**
   * Property 27: Sum Exactness
   *
   * For any total gross weight and non-empty list of basis values,
   * the sum of all allocated weights SHALL equal the total weight exactly.
   *
   * **Validates: Requirements 7.2**
   */
  it("Property 27: Sum of allocated weights equals total exactly", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.array(fc.integer({ min: 1, max: 1000 }), {
          minLength: 1,
          maxLength: 50,
        }),
        (totalKg, lineBasis) => {
          const result = allocateGrossWeight(totalKg, lineBasis, 0);
          expect(result.ok).toBe(true);

          if (!result.ok) return;

          // Sum all allocated weights
          const sum = result.value.reduce((acc, aw) => acc + aw.kilograms, 0);

          // Must equal total exactly
          expect(sum).toBe(totalKg);
        }
      )
    );
  });

  /**
   * Property 28: Non-Negativity and Decimal Places
   *
   * For any total gross weight and basis values, every allocated weight
   * SHALL be non-negative and formatted to the configured decimal places.
   *
   * **Validates: Requirements 7.3**
   */
  it("Property 28: All allocated weights are non-negative with correct decimal places", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.array(fc.integer({ min: 1, max: 1000 }), {
          minLength: 1,
          maxLength: 50,
        }),
        fc.integer({ min: 0, max: 6 }),
        (totalKg, lineBasis, decimals) => {
          // Adjust totalKg to have at most `decimals` decimal places
          const adjustedTotal =
            Math.floor(totalKg * Math.pow(10, decimals)) / Math.pow(10, decimals);

          const result = allocateGrossWeight(adjustedTotal, lineBasis, decimals);
          expect(result.ok).toBe(true);

          if (!result.ok) return;

          for (const aw of result.value) {
            // Must be non-negative
            expect(aw.kilograms).toBeGreaterThanOrEqual(0);

            // Must have exactly `decimals` decimal places
            const multiplier = Math.pow(10, decimals);
            const asInteger = Math.round(aw.kilograms * multiplier);
            const reconstructed = asInteger / multiplier;
            expect(reconstructed).toBe(aw.kilograms);
          }
        }
      )
    );
  });

  /**
   * Property 29: Zero-Basis Allocation is Zero
   *
   * For a line with basis 0 and at least one line with positive basis,
   * that line's allocation SHALL be 0 kg.
   *
   * **Validates: Requirements 7.4**
   */
  it("Property 29: Zero-basis line allocates 0 kg", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.tuple(
          fc.array(fc.integer({ min: 1, max: 1000 }), { maxLength: 3 }),
          fc.array(fc.integer({ min: 1, max: 1000 }), { maxLength: 3 })
        ),
        (totalKg, [before, after]) => {
          // Create basis with at least one zero in the middle
          const lineBasis = [...before, 0, ...after];

          // Must have at least one non-zero basis
          if (lineBasis.every((b) => b === 0)) return;

          const result = allocateGrossWeight(totalKg, lineBasis, 0);
          expect(result.ok).toBe(true);

          if (!result.ok) return;

          // The zero-basis line should allocate 0 kg
          const zeroBasisIndex = before.length;
          expect(result.value[zeroBasisIndex].kilograms).toBe(0);
        }
      )
    );
  });

  /**
   * Property 30: All-Zero Basis Rejected
   *
   * If all basis values are 0, the allocation function
   * SHALL return a NeedsReview result.
   *
   * **Validates: Requirements 7.5**
   */
  it("Property 30: All-zero basis returns NeedsReview", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        (count) => {
          const allZeros = new Array(count).fill(0);
          const result = allocateGrossWeight(100, allZeros, 0);

          // Must return NeedsReview
          expect(result.ok).toBe(false);

          if (!result.ok) {
            // Reason should mention zero basis
            expect(result.reason).toContain("0");
          }
        }
      )
    );
  });

  /**
   * Property 31: Swapping lines with tie-breaking
   *
   * When two lines are swapped, their allocated weights generally swap in the result,
   * BUT when two lines have equal remainder (tie), the largest remainder method gives
   * the extra unit to the earlier line. After a swap, the extra unit moves with the
   * position, not with the line. A tie can also occur between a swapped line and an
   * untouched line, causing the untouched line to gain or lose one unit. This property
   * asserts:
   * - Both results are ok and each sums to totalKg
   * - For every index k, the swapped allocation at k differs from the original allocation
   *   at the corresponding original position by at most one unit (plus floating-point tolerance)
   *
   * **Validates: Requirements 7.7**
   */
  it("Property 31: Swapping lines swaps allocations (with tie-breaking tolerance)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.array(fc.integer({ min: 1, max: 1000 }), {
          minLength: 2,
          maxLength: 50,
        }),
        fc.integer({ min: 0, max: 1 }),
        fc.integer({ min: 0, max: 1 }),
        (totalKg, lineBasis, swapFactor, decimals) => {
          // Pick two indices to swap
          const i = swapFactor;
          const j = lineBasis.length - 1 - swapFactor;

          if (i === j) return; // Skip if same index

          // Create swapped basis
          const swappedBasis = [...lineBasis];
          [swappedBasis[i], swappedBasis[j]] = [swappedBasis[j], swappedBasis[i]];

          // Allocate original
          const result1 = allocateGrossWeight(totalKg, lineBasis, decimals);
          expect(result1.ok).toBe(true);

          if (!result1.ok) return;

          // Allocate swapped
          const result2 = allocateGrossWeight(totalKg, swappedBasis, decimals);
          expect(result2.ok).toBe(true);

          if (!result2.ok) return;

          // Unit of the smallest difference (1 unit = 1 / 10^decimals)
          const unit = 1 / Math.pow(10, decimals);

          // Both results must sum to totalKg (compare in integer units)
          const multiplier = Math.pow(10, decimals);
          const sum1 = result1.value.reduce((acc, aw) => acc + aw.kilograms, 0);
          const sum2 = result2.value.reduce((acc, aw) => acc + aw.kilograms, 0);
          expect(Math.round(sum1 * multiplier)).toBe(Math.round(totalKg * multiplier));
          expect(Math.round(sum2 * multiplier)).toBe(Math.round(totalKg * multiplier));

          // For every index k, compute the original position p(k):
          // If k was the position of i after swap, its original position was j (and vice versa).
          for (let k = 0; k < lineBasis.length; k++) {
            let p: number;
            if (k === i) {
              p = j; // Position k now holds what was at position j
            } else if (k === j) {
              p = i; // Position k now holds what was at position i
            } else {
              p = k; // Position k holds what was at position k
            }

            // The allocation at k in result2 should match the allocation at p in result1
            // within one unit (plus floating-point tolerance)
            expect(Math.abs(result2.value[k].kilograms - result1.value[p].kilograms))
              .toBeLessThanOrEqual(unit + 1e-9);
          }
        }
      )
    );
  });

  /**
   * Property 32: Empty List Rejected
   *
   * If the input line list is empty, the allocation function
   * SHALL return a NeedsReview result.
   *
   * **Validates: Requirements 7.9**
   */
  it("Property 32: Empty line list returns NeedsReview", () => {
    const result = allocateGrossWeight(100, [], 0);

    // Must return NeedsReview
    expect(result.ok).toBe(false);

    if (!result.ok) {
      // Reason should mention empty list
      expect(result.reason).toContain("empty");
    }
  });

  /**
   * Edge Case: All Equal Basis
   *
   * When all basis values are equal, each line should receive
   * exactly 1/N of the total weight (with remainders distributed via largest remainder).
   */
  it("Edge case: Equal basis distributes equally", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 1000 }),
        fc.integer({ min: 2, max: 20 }),
        (totalKg, lineCount) => {
          // All basis values equal
          const equalBasis = new Array(lineCount).fill(100);

          const result = allocateGrossWeight(totalKg, equalBasis, 0);
          expect(result.ok).toBe(true);

          if (!result.ok) return;

          // With equal basis, allocations should be as equal as possible
          const allocations = result.value.map((aw) => aw.kilograms);

          // All allocations should differ by at most 1 kg
          const min = Math.min(...allocations);
          const max = Math.max(...allocations);
          expect(max - min).toBeLessThanOrEqual(1);

          // Sum must equal total
          const sum = allocations.reduce((a, b) => a + b, 0);
          expect(sum).toBe(totalKg);
        }
      )
    );
  });

  /**
   * Edge Case: Single Line
   *
   * With a single line, that line receives the entire total weight.
   */
  it("Edge case: Single line receives all weight", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10000 }), (totalKg) => {
        const result = allocateGrossWeight(totalKg, [100], 0);
        expect(result.ok).toBe(true);

        if (result.ok) {
          expect(result.value.length).toBe(1);
          expect(result.value[0].kilograms).toBe(totalKg);
          expect(result.value[0].estimated).toBe(true);
        }
      })
    );
  });

  /**
   * Edge Case: Very Small Total
   *
   * With total weight smaller than number of lines, some lines get 0,
   * and the non-zero allocations go to highest-basis lines.
   */
  it("Edge case: Small total with many lines", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 2, max: 50 }),
        (totalKg, lineCount) => {
          // Basis values vary
          const lineBasis = Array.from({ length: lineCount }, (_, i) => i + 1);

          const result = allocateGrossWeight(totalKg, lineBasis, 0);
          expect(result.ok).toBe(true);

          if (!result.ok) return;

          // Sum must equal total
          const sum = result.value.reduce((acc, aw) => acc + aw.kilograms, 0);
          expect(sum).toBe(totalKg);

          // All must be non-negative
          for (const aw of result.value) {
            expect(aw.kilograms).toBeGreaterThanOrEqual(0);
          }

          // Higher-basis lines should generally get more allocation
          // (not a strict ordering, but a tendency)
          const allocations = result.value.map((aw) => aw.kilograms);
          const firstAlloc = allocations[0];
          const lastAlloc = allocations[lineCount - 1];
          // Last line has higher basis, so should get >= first line allocation
          expect(lastAlloc).toBeGreaterThanOrEqual(firstAlloc);
        }
      )
    );
  });

  /**
   * Edge Case: Decimal Places
   *
   * When decimals > 0, allocations should have the correct fractional parts.
   */
  it("Edge case: Decimal places in output", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 10 })
        ),
        fc.integer({ min: 1, max: 3 }),
        ([wholeKg, fracKg], decimals) => {
          // Create a total with fractional part
          const multiplier = Math.pow(10, decimals);
          const totalWithFrac = wholeKg + fracKg / multiplier;

          const basis = [1, 1];
          const result = allocateGrossWeight(totalWithFrac, basis, decimals);
          expect(result.ok).toBe(true);

          if (!result.ok) return;

          // Sum should equal total
          const sum = result.value.reduce((acc, aw) => acc + aw.kilograms, 0);
          expect(Math.abs(sum - totalWithFrac)).toBeLessThan(
            1 / (multiplier * 1000)
          );

          // Each allocation should have at most `decimals` decimal places
          for (const aw of result.value) {
            const asInt = Math.round(aw.kilograms * multiplier);
            const reconstructed = asInt / multiplier;
            expect(reconstructed).toBe(aw.kilograms);
          }
        }
      )
    );
  });

  /**
   * Edge Case: Negative Basis Rejected
   *
   * Any negative basis value should return NeedsReview.
   */
  it("Edge case: Negative basis returns NeedsReview", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 3 }),
        fc.integer({ min: -1000, max: -1 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 3 }),
        (totalKg, before, negative, after) => {
          const lineBasis = [...before, negative, ...after];

          // If all become negative, skip
          if (lineBasis.every((b) => b < 0)) return;

          const result = allocateGrossWeight(totalKg, lineBasis, 0);

          // Must return NeedsReview
          expect(result.ok).toBe(false);

          if (!result.ok) {
            expect(result.reason).toContain("negative");
          }
        }
      )
    );
  });

  /**
   * Edge Case: Non-Integer Basis Rejected
   *
   * Any non-integer basis value should return NeedsReview.
   */
  it("Edge case: Non-integer basis returns NeedsReview", () => {
    const result = allocateGrossWeight(100, [10, 20.5, 30], 0);

    // Must return NeedsReview
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain("not an integer");
    }
  });

  /**
   * Mandatory Example from Task 9.1:
   *
   * allocateGrossWeight(286, [886, 472, 131, 528, 336, 194, 315], 0)
   * → [89, 47, 13, 53, 34, 19, 31]
   */
  it("Mandatory example: 286 kg allocated across 7 lines", () => {
    const result = allocateGrossWeight(286, [886, 472, 131, 528, 336, 194, 315], 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      const allocations = result.value.map((aw) => aw.kilograms);
      expect(allocations).toEqual([89, 47, 13, 53, 34, 19, 31]);

      // Verify sum
      const sum = allocations.reduce((a, b) => a + b, 0);
      expect(sum).toBe(286);

      // Verify all marked as estimated
      for (const aw of result.value) {
        expect(aw.estimated).toBe(true);
      }
    }
  });

  /**
   * Mandatory Example from Task 9.1:
   *
   * allocateGrossWeight(10, [0, 0], 0) → NeedsReview
   */
  it("Mandatory example: All-zero basis rejected", () => {
    const result = allocateGrossWeight(10, [0, 0], 0);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain("0");
    }
  });

  /**
   * Mandatory Example from Task 9.1:
   *
   * allocateGrossWeight(10, [], 0) → NeedsReview
   */
  it("Mandatory example: Empty list rejected", () => {
    const result = allocateGrossWeight(10, [], 0);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });
});
