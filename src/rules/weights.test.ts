/**
 * src/rules/weights.test.ts
 *
 * Unit tests for P11 (Gross Weight Allocation) using Vitest.
 *
 * Tests verify correct behavior with specific examples.
 */

import { describe, it, expect } from "vitest";
import { allocateGrossWeight } from "./weights";

describe("allocateGrossWeight() - Unit Tests", () => {
  /**
   * Mandatory example from requirements:
   * allocateGrossWeight(286, [886, 472, 131, 528, 336, 194, 315], 0)
   * → [89, 47, 13, 53, 34, 19, 31] (sum = 286)
   */
  it("Mandatory example 1: 286 kg allocated across 7 lines", () => {
    const result = allocateGrossWeight(286, [886, 472, 131, 528, 336, 194, 315], 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      const allocations = result.value.map((aw) => aw.kilograms);
      expect(allocations).toEqual([89, 47, 13, 53, 34, 19, 31]);

      // Verify sum
      const sum = allocations.reduce((a, b) => a + b, 0);
      expect(sum).toBe(286);

      // All must be marked estimated
      for (const aw of result.value) {
        expect(aw.estimated).toBe(true);
      }
    }
  });

  /**
   * Mandatory example from requirements:
   * allocateGrossWeight(10, [0, 0], 0) → NeedsReview
   */
  it("Mandatory example 2: All-zero basis rejected", () => {
    const result = allocateGrossWeight(10, [0, 0], 0);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain("All basis values are 0");
    }
  });

  /**
   * Mandatory example from requirements:
   * allocateGrossWeight(10, [], 0) → NeedsReview
   */
  it("Mandatory example 3: Empty list rejected", () => {
    const result = allocateGrossWeight(10, [], 0);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  // Additional unit tests

  it("Single line receives all weight", () => {
    const result = allocateGrossWeight(100, [1], 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].kilograms).toBe(100);
      expect(result.value[0].estimated).toBe(true);
    }
  });

  it("Two lines with equal basis split evenly", () => {
    const result = allocateGrossWeight(10, [1, 1], 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value.length).toBe(2);
      // 10 kg split equally: 5 + 5
      expect(result.value[0].kilograms).toBe(5);
      expect(result.value[1].kilograms).toBe(5);
      const sum = result.value.reduce((a, aw) => a + aw.kilograms, 0);
      expect(sum).toBe(10);
    }
  });

  it("Two lines with ratio 2:1 allocation", () => {
    const result = allocateGrossWeight(30, [2, 1], 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      // 30 kg: 2/3 * 30 = 20, 1/3 * 30 = 10
      expect(result.value[0].kilograms).toBe(20);
      expect(result.value[1].kilograms).toBe(10);
      const sum = result.value.reduce((a, aw) => a + aw.kilograms, 0);
      expect(sum).toBe(30);
    }
  });

  it("Largest remainder method handles remainders correctly", () => {
    // Total 10, basis [3, 3, 3]
    // Exact: 10/3 for each = 3.333...
    // Floors: [3, 3, 3] = 9
    // Remainders: each line gets 1/3 of 10 = 3.333
    // Leftover: 10 - 9 = 1, distributed to line with largest remainder
    // All have equal remainder, so ties go to earlier lines
    const result = allocateGrossWeight(10, [3, 3, 3], 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      const allocations = result.value.map((aw) => aw.kilograms);
      // One line gets 4, others get 3 (due to remainder distribution)
      const sorted = allocations.sort((a, b) => b - a);
      expect(sorted[0]).toBe(4);
      expect(sorted[1]).toBe(3);
      expect(sorted[2]).toBe(3);

      const sum = allocations.reduce((a, b) => a + b, 0);
      expect(sum).toBe(10);
    }
  });

  it("Zero-basis line with positive basis lines", () => {
    const result = allocateGrossWeight(100, [1, 0, 1], 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      // Line 0: 50 kg, Line 1: 0 kg, Line 2: 50 kg
      expect(result.value[0].kilograms).toBe(50);
      expect(result.value[1].kilograms).toBe(0);
      expect(result.value[2].kilograms).toBe(50);

      const sum = result.value.reduce((a, aw) => a + aw.kilograms, 0);
      expect(sum).toBe(100);
    }
  });

  it("Negative total weight rejected", () => {
    const result = allocateGrossWeight(-50, [1, 1], 0);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain("negative");
    }
  });

  it("Negative basis rejected", () => {
    const result = allocateGrossWeight(100, [10, -5], 0);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain("negative");
    }
  });

  it("Non-integer basis rejected", () => {
    const result = allocateGrossWeight(100, [10, 20.5], 0);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain("not an integer");
    }
  });

  it("Decimal places: 0 decimals (whole kg)", () => {
    const result = allocateGrossWeight(10, [1, 1], 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      for (const aw of result.value) {
        // Should be whole kg
        expect(aw.kilograms).toBe(Math.floor(aw.kilograms));
      }
    }
  });

  it("Decimal places: 1 decimal place", () => {
    const result = allocateGrossWeight(10.5, [1, 1], 1);

    expect(result.ok).toBe(true);

    if (result.ok) {
      // 10.5 / 2 = 5.25 for each
      // But with largest remainder method, should be [5.3, 5.2] or similar
      const sum = result.value.reduce((a, aw) => a + aw.kilograms, 0);
      expect(Math.abs(sum - 10.5)).toBeLessThan(0.01);

      // Each should have 1 decimal place
      for (const aw of result.value) {
        const decimals = countDecimalPlaces(aw.kilograms);
        expect(decimals).toBeLessThanOrEqual(1);
      }
    }
  });

  it("Decimal places: 2 decimal places", () => {
    const result = allocateGrossWeight(15.75, [1, 1, 1], 2);

    expect(result.ok).toBe(true);

    if (result.ok) {
      const sum = result.value.reduce((a, aw) => a + aw.kilograms, 0);
      expect(Math.abs(sum - 15.75)).toBeLessThan(0.001);

      // All must have at most 2 decimal places
      for (const aw of result.value) {
        const decimals = countDecimalPlaces(aw.kilograms);
        expect(decimals).toBeLessThanOrEqual(2);
      }
    }
  });

  it("Total weight with too many decimal places rejected", () => {
    const result = allocateGrossWeight(10.123456789, [1, 1], 2);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain("decimal places");
    }
  });

  it("Order preservation: swapping lines swaps allocations", () => {
    const basis1 = [10, 20, 30];
    const result1 = allocateGrossWeight(60, basis1, 0);

    expect(result1.ok).toBe(true);

    if (result1.ok) {
      const alloc1 = result1.value.map((aw) => aw.kilograms);

      // Swap lines 0 and 2
      const basis2 = [30, 20, 10];
      const result2 = allocateGrossWeight(60, basis2, 0);

      expect(result2.ok).toBe(true);

      if (result2.ok) {
        const alloc2 = result2.value.map((aw) => aw.kilograms);

        // Allocations should be swapped
        expect(alloc2[0]).toBe(alloc1[2]);
        expect(alloc2[2]).toBe(alloc1[0]);
        expect(alloc2[1]).toBe(alloc1[1]);
      }
    }
  });

  it("Large shipment with many lines", () => {
    const totalKg = 1000;
    const lineBasis = Array.from({ length: 100 }, (_, i) => i + 1); // [1, 2, 3, ..., 100]

    const result = allocateGrossWeight(totalKg, lineBasis, 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value.length).toBe(100);

      // Sum must equal total
      const sum = result.value.reduce((a, aw) => a + aw.kilograms, 0);
      expect(sum).toBe(totalKg);

      // Higher-basis lines should generally get more (not strict, but tendency)
      const allocations = result.value.map((aw) => aw.kilograms);
      expect(allocations[99]).toBeGreaterThanOrEqual(allocations[0]);
    }
  });
});

/**
 * Helper: Count decimal places
 */
function countDecimalPlaces(num: number): number {
  const str = num.toString();
  const decimalIndex = str.indexOf(".");

  if (decimalIndex === -1) {
    return 0;
  }

  const afterDecimal = str.substring(decimalIndex + 1);

  if (afterDecimal.includes("e") || afterDecimal.includes("E")) {
    const match = str.match(/e[+-]?(\d+)/i);
    if (match) {
      const exponent = parseInt(match[1], 10);
      if (str.includes("e-") || str.includes("E-")) {
        return exponent;
      }
    }
  }

  return afterDecimal.length;
}
