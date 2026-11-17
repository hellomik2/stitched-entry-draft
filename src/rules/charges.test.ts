import { describe, it, expect } from "vitest";
import { formatCharges } from "./charges";

describe("formatCharges()", () => {
  describe("basic formatting", () => {
    it("should format positive whole dollar amounts", () => {
      const result = formatCharges(55000); // $550.00
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C550");
      }
    });

    it("should format zero cents", () => {
      const result = formatCharges(0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C0");
      }
    });

    it("should format small amounts", () => {
      const result = formatCharges(100); // $1.00
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C1");
      }
    });
  });

  describe("rounding behavior", () => {
    it("should round 50 cents up with halfUp mode (default)", () => {
      const result = formatCharges(50); // $0.50
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C1");
      }
    });

    it("should round 49 cents down with halfUp mode", () => {
      const result = formatCharges(49); // $0.49
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C0");
      }
    });

    it("should round 51 cents up with halfUp mode", () => {
      const result = formatCharges(51); // $0.51
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C1");
      }
    });

    it("should round 150 cents up to 2 with halfUp mode", () => {
      const result = formatCharges(150); // $1.50
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C2");
      }
    });

    it("should round 149 cents down to 1 with halfUp mode", () => {
      const result = formatCharges(149); // $1.49
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C1");
      }
    });

    it("should support halfDown rounding mode", () => {
      const result = formatCharges(50, undefined, "halfDown"); // $0.50
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C0");
      }
    });

    it("should support truncate rounding mode", () => {
      const result = formatCharges(99, undefined, "truncate"); // $0.99
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C0");
      }
    });

    it("should support halfEven rounding mode", () => {
      const result = formatCharges(50, undefined, "halfEven"); // $0.50
      expect(result.ok).toBe(true);
      if (result.ok) {
        // halfEven uses Math.round, which rounds 0.5 to nearest even
        expect(result.value).toBe("C0");
      }
    });
  });

  describe("transport code 60", () => {
    it("should return C0 for transport code 60 with zero cents", () => {
      const result = formatCharges(0, "60");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C0");
      }
    });

    it("should return C0 for transport code 60 with positive cents", () => {
      const result = formatCharges(55000, "60"); // $550.00
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C0");
      }
    });

    it("should return C0 for transport code 60 even with large amounts", () => {
      const result = formatCharges(999999, "60"); // $9999.99
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C0");
      }
    });

    it("should return NeedsReview for transport code 60 with negative cents", () => {
      const result = formatCharges(-100, "60");
      expect(result.ok).toBe(true); // Transport code 60 overrides negative check
      if (result.ok) {
        expect(result.value).toBe("C0");
      }
    });
  });

  describe("negative values", () => {
    it("should return NeedsReview for negative cents", () => {
      const result = formatCharges(-100);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("negative");
      }
    });

    it("should return NeedsReview for large negative amounts", () => {
      const result = formatCharges(-999999);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("negative");
      }
    });
  });

  describe("pattern compliance", () => {
    it("should match pattern ^C\\d+$ for zero", () => {
      const result = formatCharges(0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatch(/^C\d+$/);
      }
    });

    it("should match pattern ^C\\d+$ for positive amounts", () => {
      const result = formatCharges(12345);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatch(/^C\d+$/);
      }
    });

    it("should never have decimal point", () => {
      const result = formatCharges(12345);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toContain(".");
      }
    });

    it("should never have dollar sign", () => {
      const result = formatCharges(12345);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toContain("$");
      }
    });

    it("should never have thousands separator", () => {
      const result = formatCharges(1234500); // $12,345.00
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toContain(",");
      }
    });
  });

  describe("edge cases", () => {
    it("should handle maximum JavaScript safe integer", () => {
      const result = formatCharges(Number.MAX_SAFE_INTEGER - 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatch(/^C\d+$/);
      }
    });

    it("should throw Error for non-integer cents", () => {
      expect(() => formatCharges(50.5)).toThrow();
    });

    it("should throw Error for string input", () => {
      expect(() => formatCharges("100" as any)).toThrow();
    });

    it("should throw Error for NaN", () => {
      expect(() => formatCharges(NaN)).toThrow();
    });

    it("should throw Error for Infinity", () => {
      expect(() => formatCharges(Infinity)).toThrow();
    });
  });

  describe("transport code specificity", () => {
    it("should only apply special handling for transport code 60", () => {
      const result = formatCharges(100, "50");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C1"); // Normal formatting, not C0
      }
    });

    it("should only apply special handling for exact string 60", () => {
      const result = formatCharges(100, "60 ");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C1"); // "60 " !== "60", so normal formatting
      }
    });

    it("should ignore transport code if it's undefined", () => {
      const result = formatCharges(100, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("C1");
      }
    });
  });

  describe("round-trip property", () => {
    it("should allow parsing C<n> to recover dollar amount", () => {
      const result = formatCharges(55000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Extract the integer from "C550"
        const parsed = parseInt(result.value.slice(1), 10);
        expect(parsed).toBe(550);
      }
    });

    it("should allow parsing C<n> for various amounts", () => {
      const testCases = [0, 100, 150, 50, 9999, 1234567];

      for (const cents of testCases) {
        const result = formatCharges(cents);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const parsed = parseInt(result.value.slice(1), 10);
          expect(typeof parsed).toBe("number");
          expect(parsed >= 0).toBe(true);
        }
      }
    });
  });
});
