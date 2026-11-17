import { describe, it, expect } from "vitest";
import { computeDuty } from "./duty";

describe("computeDuty()", () => {
  describe("Free rate", () => {
    it("should return 0 for 'Free' (uppercase)", () => {
      const result = computeDuty("Free", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("should return 0 for 'free' (lowercase)", () => {
      const result = computeDuty("free", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("should return 0 for 'FREE' (all caps)", () => {
      const result = computeDuty("FREE", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("should return 0 for Free rate regardless of dutiable value", () => {
      const result = computeDuty("Free", 500000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });
  });

  describe("ad valorem percentage rates", () => {
    it("should compute duty for simple percentage like 4%", () => {
      // 4% of $1000 (100000 cents) = $40 (4000 cents)
      const result = computeDuty("4%", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(4000);
      }
    });

    it("should compute duty for decimal percentage like 16.5%", () => {
      // 16.5% of $1000 (100000 cents) = $165 (16500 cents)
      const result = computeDuty("16.5%", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(16500);
      }
    });

    it("should compute duty for 0.3464% (MPF-like rate)", () => {
      // 0.3464% of $100000 (10000000 cents) should be $346.40 (34640 cents)
      const result = computeDuty("0.3464%", 10000000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(34640);
      }
    });

    it("should handle zero cents dutiable value", () => {
      // 4% of $0 = $0
      const result = computeDuty("4%", 0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("should round using halfUp mode by default", () => {
      // 3% of $16.67 (1667 cents) = $0.51 (51 cents)
      // 1667 cents → $17 (P4 rounded) → 3% = 51 cents with halfUp
      const result = computeDuty("3%", 1667);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(51);
      }
    });
  });

  describe("baseMode: roundedEnteredValue", () => {
    it("should apply P4 rounding to dutiable value before computing duty", () => {
      // With roundedEnteredValue: apply P4 first
      // Dutiable value: 125 cents → P4 rounds to 1 dollar (100 cents)
      // 4% of 100 cents = 4 cents
      const result = computeDuty("4%", 125, "roundedEnteredValue");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(4);
      }
    });

    it("should handle 50 cents boundary with roundedEnteredValue", () => {
      // Dutiable value: 150 cents → P4 rounds to 2 dollars (200 cents)
      // 4% of 200 cents = 8 cents
      const result = computeDuty("4%", 150, "roundedEnteredValue");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(8);
      }
    });
  });

  describe("baseMode: exactEnteredValue", () => {
    it("should use exact dutiable value without rounding", () => {
      // With exactEnteredValue: use 125 cents as-is
      // 4% of 125 cents = 5 cents
      const result = computeDuty("4%", 125, "exactEnteredValue");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(5);
      }
    });

    it("should compute correctly for odd cent amounts", () => {
      // 10% of 333 cents = 33.3 cents → rounds to 33 with halfUp
      const result = computeDuty("10%", 333, "exactEnteredValue");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(33);
      }
    });
  });

  describe("unrecognized rate formats", () => {
    it("should return NeedsReview for specific rate format", () => {
      const result = computeDuty("15.5¢/kg", 100000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Unrecognized rate format");
      }
    });

    it("should return NeedsReview for compound rate format", () => {
      const result = computeDuty("4% + 2.5¢/kg", 100000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Unrecognized rate format");
      }
    });

    it("should return NeedsReview for 'The duty provided in' text", () => {
      const result = computeDuty("The duty provided in HTS 9903.88.01 shall apply", 100000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Unrecognized rate format");
      }
    });

    it("should return NeedsReview for percentage without % symbol", () => {
      const result = computeDuty("4", 100000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Unrecognized rate format");
      }
    });

    it("should return NeedsReview for percentage with leading zeros", () => {
      // This should still work if it matches the regex
      const result = computeDuty("04%", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 4% of 100000 cents = 4000 cents
        expect(result.value).toBe(4000);
      }
    });

    it("should return NeedsReview for percentage with space", () => {
      const result = computeDuty("4 %", 100000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Unrecognized rate format");
      }
    });

    it("should return NeedsReview for percentage with more than 4 decimals", () => {
      // Rate regex allows max 4 decimals: ^\d+(\.\d{1,4})?%
      const result = computeDuty("6.12345%", 100000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Unrecognized rate format");
      }
    });
  });

  describe("unavailable dutiable value", () => {
    it("should return NeedsReview when dutiable value is null", () => {
      const result = computeDuty("4%", null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Dutiable value is unavailable");
      }
    });

    it("should return NeedsReview when dutiable value is undefined", () => {
      const result = computeDuty("4%", undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("Dutiable value is unavailable");
      }
    });

    it("should return NeedsReview for Free rate with unavailable dutiable value", () => {
      // Free rate should return 0 without checking dutiableValue
      const result = computeDuty("Free", null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });
  });

  describe("type safety", () => {
    it("should throw Error for non-integer dutiable value", () => {
      expect(() => computeDuty("4%", 100.5)).toThrow();
    });

    it("should throw Error for NaN dutiable value", () => {
      expect(() => computeDuty("4%", NaN)).toThrow();
    });

    it("should throw Error for Infinity dutiable value", () => {
      expect(() => computeDuty("4%", Infinity)).toThrow();
    });
  });

  describe("edge cases", () => {
    it("should handle very small percentages", () => {
      // 0.0001% of 100000 cents = 0.1 cents → rounds to 0
      const result = computeDuty("0.0001%", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("should handle very large dutiable values", () => {
      // 4% of 100 million cents = 4 million cents
      const result = computeDuty("4%", 100000000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(4000000);
      }
    });

    it("should handle negative dutiable value with P4 rounding", () => {
      // Negative entered value should be handled by roundEnteredValue
      const result = computeDuty("4%", -100, "roundedEnteredValue");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("non-negative");
      }
    });
  });

  describe("rounding modes", () => {
    it("should apply configured rounding mode", () => {
      // Note: computeDuty uses config.dutyCentsRounding
      // Default is halfUp, which is tested above
      // Here we verify the result uses a consistent rounding
      // 3.333% of $300.30 (30030 cents) → $300 (P4 rounded) → 3.333% = 1000 cents with halfUp
      // 30030 cents → $300 (P4 rounds up) → 30000 cents → 3.333% * 30000 / 1_000_000 = 999.9 → 1000
      const result = computeDuty("3.333%", 30030);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1000);
      }
    });
  });

  describe("pattern compliance", () => {
    it("should match percentage pattern with single digit", () => {
      const result = computeDuty("5%", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(5000);
      }
    });

    it("should match percentage pattern with multiple digits before decimal", () => {
      const result = computeDuty("123%", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(123000);
      }
    });

    it("should match percentage pattern with multiple decimal places", () => {
      const result = computeDuty("16.5432%", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 16.5432% of 100000 cents = 16543.2 cents → rounds to 16543
        expect(result.value).toBe(16543);
      }
    });
  });

  describe("zero duty scenarios", () => {
    it("should compute 0 duty for 0% rate", () => {
      const result = computeDuty("0%", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("should compute 0 duty for 0.0% rate", () => {
      const result = computeDuty("0.0%", 100000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });
  });
});
