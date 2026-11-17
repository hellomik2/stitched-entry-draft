/**
 * src/rules/totals.test.ts
 *
 * Unit tests for P5 (Total Entered Value) and P10 (Summary Totals).
 *
 * These tests verify specific examples and critical functionality.
 */

import { describe, it, expect } from "vitest";
import { totalEnteredValue, summarizeTotals } from "./totals";

describe("totalEnteredValue() - Unit Tests", () => {
  describe("sumOfRoundedLines mode", () => {
    it("returns 0 for empty array", () => {
      const result = totalEnteredValue([], "sumOfRoundedLines");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("sums individually rounded values", () => {
      // $1.50 + $2.00 = $1 (rounded) + $2 (rounded) = $3
      const result = totalEnteredValue([150, 200], "sumOfRoundedLines");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3);
      }
    });

    it("handles single line correctly", () => {
      // $0.50 → $1 (rounded halfUp)
      const result = totalEnteredValue([50], "sumOfRoundedLines");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });

    it("rejects negative values", () => {
      const result = totalEnteredValue([100, -50], "sumOfRoundedLines");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("non-negative");
      }
    });

    it("handles multiple rounding scenarios", () => {
      // $0.49 → $0
      // $0.50 → $1
      // $0.51 → $1
      // Total: 0 + 1 + 1 = 2
      const result = totalEnteredValue([49, 50, 51], "sumOfRoundedLines");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }
    });

    it("handles all zero values", () => {
      const result = totalEnteredValue([0, 0, 0], "sumOfRoundedLines");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("maintains monotonicity: adding value increases total", () => {
      const original = totalEnteredValue([100, 200], "sumOfRoundedLines");
      const withAdded = totalEnteredValue([100, 200, 50], "sumOfRoundedLines");

      expect(original.ok && withAdded.ok).toBe(true);

      if (original.ok && withAdded.ok) {
        expect(withAdded.value).toBeGreaterThanOrEqual(original.value);
      }
    });

    it("is commutative: order doesn't matter", () => {
      const result1 = totalEnteredValue([150, 200, 75], "sumOfRoundedLines");
      const result2 = totalEnteredValue([75, 150, 200], "sumOfRoundedLines");
      const result3 = totalEnteredValue([200, 75, 150], "sumOfRoundedLines");

      expect(result1.ok && result2.ok && result3.ok).toBe(true);

      if (result1.ok && result2.ok && result3.ok) {
        expect(result1.value).toBe(result2.value);
        expect(result2.value).toBe(result3.value);
      }
    });
  });

  describe("roundSumOfExactLines mode", () => {
    it("returns 0 for empty array", () => {
      const result = totalEnteredValue([], "roundSumOfExactLines");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("sums exact values then rounds", () => {
      // $1.50 + $2.00 = $3.50 → $4 (rounded halfUp)
      // Wait, that's actually $3 in dollars. Let me recalculate:
      // 150 cents + 200 cents = 350 cents = $3.50 → $4 (rounded)
      const result = totalEnteredValue([150, 200], "roundSumOfExactLines");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(4);
      }
    });

    it("handles single line correctly", () => {
      // $0.50 → $1 (rounded halfUp)
      const result = totalEnteredValue([50], "roundSumOfExactLines");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });

    it("demonstrates mode difference with fractional rounding", () => {
      // Mode 1 (sumOfRoundedLines): $0.25 → $0, $0.25 → $0, total $0
      // Mode 2 (roundSumOfExactLines): $0.50 → $1 total
      const result1 = totalEnteredValue([25, 25], "sumOfRoundedLines");
      const result2 = totalEnteredValue([25, 25], "roundSumOfExactLines");

      expect(result1.ok && result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        expect(result1.value).toBe(0);
        expect(result2.value).toBe(1);
      }
    });

    it("rejects negative values", () => {
      const result = totalEnteredValue([100, -50], "roundSumOfExactLines");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("non-negative");
      }
    });

    it("is commutative: order doesn't matter", () => {
      const result1 = totalEnteredValue([150, 200, 75], "roundSumOfExactLines");
      const result2 = totalEnteredValue([75, 150, 200], "roundSumOfExactLines");
      const result3 = totalEnteredValue([200, 75, 150], "roundSumOfExactLines");

      expect(result1.ok && result2.ok && result3.ok).toBe(true);

      if (result1.ok && result2.ok && result3.ok) {
        expect(result1.value).toBe(result2.value);
        expect(result2.value).toBe(result3.value);
      }
    });
  });

  describe("default mode behavior", () => {
    it("defaults to sumOfRoundedLines", () => {
      const defaultResult = totalEnteredValue([150, 200]);
      const explicitResult = totalEnteredValue([150, 200], "sumOfRoundedLines");

      expect(defaultResult.ok && explicitResult.ok).toBe(true);

      if (defaultResult.ok && explicitResult.ok) {
        expect(defaultResult.value).toBe(explicitResult.value);
      }
    });
  });

  describe("mode difference property", () => {
    it("difference is bounded by 50*N cents", () => {
      const linesCents = [25, 25, 25, 25]; // 4 lines
      const result1 = totalEnteredValue(linesCents, "sumOfRoundedLines");
      const result2 = totalEnteredValue(linesCents, "roundSumOfExactLines");

      expect(result1.ok && result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        const diffCents = Math.abs(result1.value - result2.value) * 100;
        const maxBound = 50 * linesCents.length; // 50 * 4 = 200
        expect(diffCents).toBeLessThanOrEqual(maxBound);
      }
    });
  });

  describe("error handling", () => {
    it("throws on non-array input", () => {
      expect(() => {
        totalEnteredValue(123 as any);
      }).toThrow();
    });

    it("returns NeedsReview for negative value", () => {
      const result = totalEnteredValue([-100]);
      expect(result.ok).toBe(false);
    });

    it("returns NeedsReview for any negative in mixed array", () => {
      const result = totalEnteredValue([100, 200, -50, 300]);
      expect(result.ok).toBe(false);
    });
  });
});

describe("summarizeTotals() - Unit Tests", () => {
  it("computes Block 44 correctly from three blocks", () => {
    const result = summarizeTotals(5000, 2000, 1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.block44Total).toBe(8000);
    }
  });

  it("returns NeedsReview if Block 41 (duty) is null", () => {
    const result = summarizeTotals(null, 2000, 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Block 41");
    }
  });

  it("returns NeedsReview if Block 42 (tax) is null", () => {
    const result = summarizeTotals(5000, null, 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Block 42");
    }
  });

  it("returns NeedsReview if Block 43 (other fees) is null", () => {
    const result = summarizeTotals(5000, 2000, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Block 43");
    }
  });

  it("returns NeedsReview if any block is negative", () => {
    const result1 = summarizeTotals(-5000, 2000, 1000);
    const result2 = summarizeTotals(5000, -2000, 1000);
    const result3 = summarizeTotals(5000, 2000, -1000);

    expect(result1.ok).toBe(false);
    expect(result2.ok).toBe(false);
    expect(result3.ok).toBe(false);
  });

  it("includes optional bonded field when provided", () => {
    const result = summarizeTotals(5000, 2000, 1000, 500);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bonded).toBe(500);
    }
  });

  it("includes optional deferred field when provided", () => {
    const result = summarizeTotals(5000, 2000, 1000, undefined, 750);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deferred).toBe(750);
    }
  });

  it("includes both optional fields when provided", () => {
    const result = summarizeTotals(5000, 2000, 1000, 500, 750);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bonded).toBe(500);
      expect(result.value.deferred).toBe(750);
    }
  });

  it("is commutative: block order doesn't matter", () => {
    // This tests the mathematical property that addition is commutative
    const result1 = summarizeTotals(5000, 2000, 1000);
    const result2 = summarizeTotals(2000, 1000, 5000);
    const result3 = summarizeTotals(1000, 5000, 2000);

    expect(result1.ok && result2.ok && result3.ok).toBe(true);

    if (result1.ok && result2.ok && result3.ok) {
      expect(result1.value.block44Total).toBe(result2.value.block44Total);
      expect(result2.value.block44Total).toBe(result3.value.block44Total);
      expect(result3.value.block44Total).toBe(8000);
    }
  });

  it("handles zero values correctly", () => {
    const result = summarizeTotals(0, 0, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.block44Total).toBe(0);
    }
  });

  it("handles large values correctly", () => {
    const result = summarizeTotals(5000000, 2000000, 1000000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.block44Total).toBe(8000000);
    }
  });
});
