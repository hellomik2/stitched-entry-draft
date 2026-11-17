/**
 * src/rules/rounding.test.ts
 *
 * Unit tests for P4 (Entered Value Rounding)
 *
 * These tests verify specific examples and edge cases
 * as defined in Requirement 1.
 */

import { describe, it, expect } from "vitest";
import { roundEnteredValue } from "./rounding";

describe("P4: Entered Value Rounding - Unit Tests", () => {
  describe("Basic rounding behavior", () => {
    it("should round 50 cents to 1 dollar (halfUp)", () => {
      const result = roundEnteredValue(50, "halfUp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });

    it("should round 49 cents to 0 dollars (halfUp)", () => {
      const result = roundEnteredValue(49, "halfUp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("should round 150 cents to 2 dollars (halfUp)", () => {
      const result = roundEnteredValue(150, "halfUp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }
    });

    it("should round 149 cents to 1 dollar (halfUp)", () => {
      const result = roundEnteredValue(149, "halfUp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });
  });

  describe("Edge cases", () => {
    it("should handle 0 cents", () => {
      const result = roundEnteredValue(0, "halfUp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });

    it("should handle exact dollar amounts", () => {
      const result = roundEnteredValue(100, "halfUp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });

    it("should handle large values", () => {
      const result = roundEnteredValue(123456789, "halfUp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1234567);
      }
    });
  });

  describe("Negative values", () => {
    it("should reject negative cents", () => {
      const result = roundEnteredValue(-100, "halfUp");
      expect(result.ok).toBe(false);
    });

    it("should return NeedsReview with reason for negative values", () => {
      const result = roundEnteredValue(-50, "halfUp");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("non-negative");
      }
    });
  });

  describe("Type validation", () => {
    it("should throw Error for non-integer values", () => {
      expect(() => roundEnteredValue(50.5, "halfUp")).toThrow();
    });

    it("should throw Error for NaN", () => {
      expect(() => roundEnteredValue(NaN, "halfUp")).toThrow();
    });

    it("should throw Error for Infinity", () => {
      expect(() => roundEnteredValue(Infinity, "halfUp")).toThrow();
    });
  });

  describe("Rounding modes", () => {
    describe("halfUp", () => {
      it("should round 50 cents up to 1 dollar", () => {
        const result = roundEnteredValue(50, "halfUp");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(1);
        }
      });

      it("should round 51 cents up to 1 dollar", () => {
        const result = roundEnteredValue(51, "halfUp");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(1);
        }
      });

      it("should round 99 cents up to 1 dollar", () => {
        const result = roundEnteredValue(99, "halfUp");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(1);
        }
      });
    });

    describe("halfDown", () => {
      it("should round 50 cents down to 0 dollars", () => {
        const result = roundEnteredValue(50, "halfDown");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(0);
        }
      });

      it("should round 49 cents down to 0 dollars", () => {
        const result = roundEnteredValue(49, "halfDown");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(0);
        }
      });

      it("should round 51 cents up to 1 dollar", () => {
        const result = roundEnteredValue(51, "halfDown");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(1);
        }
      });
    });

    describe("halfEven (banker's rounding)", () => {
      it("should round 50 cents to 0 (even) when floor is 0", () => {
        const result = roundEnteredValue(50, "halfEven");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(0);
        }
      });

      it("should round 150 cents to 2 (even) when floor is 1", () => {
        const result = roundEnteredValue(150, "halfEven");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(2);
        }
      });

      it("should round 250 cents to 2 (even) when floor is 2", () => {
        const result = roundEnteredValue(250, "halfEven");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(2);
        }
      });
    });

    describe("truncate", () => {
      it("should truncate 50 cents to 0 dollars", () => {
        const result = roundEnteredValue(50, "truncate");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(0);
        }
      });

      it("should truncate 99 cents to 0 dollars", () => {
        const result = roundEnteredValue(99, "truncate");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(0);
        }
      });

      it("should truncate 150 cents to 1 dollar", () => {
        const result = roundEnteredValue(150, "truncate");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(1);
        }
      });
    });
  });

  describe("Default rounding mode", () => {
    it("should use halfUp as default when mode not specified", () => {
      const result = roundEnteredValue(50);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // halfUp should round 50 cents to 1
        expect(result.value).toBe(1);
      }
    });
  });

  describe("Return value correctness", () => {
    it("should return integer values", () => {
      const result = roundEnteredValue(150, "halfUp");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Number.isInteger(result.value)).toBe(true);
      }
    });

    it("should guarantee difference from original is at most 0.50", () => {
      const testCases = [0, 1, 25, 49, 50, 51, 75, 99, 100, 500, 9999];
      testCases.forEach((cents) => {
        const result = roundEnteredValue(cents, "halfUp");
        expect(result.ok).toBe(true);
        if (result.ok) {
          const original = cents / 100;
          const rounded = result.value;
          const difference = Math.abs(rounded - original);
          expect(difference).toBeLessThanOrEqual(0.5);
        }
      });
    });
  });
});
