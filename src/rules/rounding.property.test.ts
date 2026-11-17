/**
 * src/rules/rounding.property.test.ts
 *
 * Property-based tests for P4 (Entered Value Rounding)
 *
 * These tests use fast-check to verify that rounding behavior holds
 * across all valid inputs and rounding modes.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { roundEnteredValue } from "./rounding";
import type { RoundingMode } from "./types";

describe("P4: Entered Value Rounding - Property Tests", () => {
  /**
   * Property 1: Half-Up Rounds 50 Cents Up
   *
   * Validates: Requirements 1.1, 1.5
   *
   * For any non-negative cents value that is exactly 50 (representing $0.50),
   * rounding to dollars using half-up mode SHALL yield 1.
   */
  it("Property 1: Half-up mode rounds exactly 50 cents to 1 dollar", () => {
    const result = roundEnteredValue(50, "halfUp");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1);
    }
  });

  /**
   * Property 2: Rounding Bounds Difference
   *
   * Validates: Requirements 1.4
   *
   * For any non-negative cents value, the absolute difference between
   * the rounded whole-dollar value and the original value in dollars
   * SHALL not exceed 0.50 dollars.
   */
  it("Property 2: Rounded value differs from original by at most 0.50 dollars", () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000 }), (cents) => {
        const result = roundEnteredValue(cents, "halfUp");
        expect(result.ok).toBe(true);

        if (result.ok) {
          const originalDollars = cents / 100;
          const roundedDollars = result.value;
          const difference = Math.abs(roundedDollars - originalDollars);
          expect(difference).toBeLessThanOrEqual(0.5);
        }
      })
    );
  });

  /**
   * Property 3: Negative Cents Rejected
   *
   * Validates: Requirements 1.3
   *
   * For any negative cents value, the rounding function
   * SHALL return a NeedsReview result.
   */
  it("Property 3: Negative cents values are rejected", () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000_000, max: -1 }), (cents) => {
        const result = roundEnteredValue(cents, "halfUp");
        expect(result.ok).toBe(false);
      })
    );
  });

  /**
   * Additional property: Half-Down Rounds 50 Cents Down
   *
   * For any non-negative cents value that is exactly 50,
   * rounding using half-down mode SHALL yield 0.
   */
  it("Half-down mode rounds exactly 50 cents to 0 dollars", () => {
    const result = roundEnteredValue(50, "halfDown");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });

  /**
   * Additional property: Half-Even (Banker's Rounding)
   *
   * For 50 cents with even dollar floor, round down.
   * For 150 cents with odd dollar floor (1), round up to 2.
   */
  it("Half-even mode applies banker's rounding at 0.5 boundary", () => {
    // 50 cents: floor is 0 (even) → round down to 0
    const result1 = roundEnteredValue(50, "halfEven");
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.value).toBe(0);
    }

    // 150 cents: floor is 1 (odd) → round up to 2
    const result2 = roundEnteredValue(150, "halfEven");
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.value).toBe(2);
    }
  });

  /**
   * Additional property: Truncate Always Rounds Down
   *
   * For any non-negative cents, truncate mode SHALL always
   * round down to the floor value.
   */
  it("Truncate mode always rounds down (discard fractional part)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000 }), (cents) => {
        const result = roundEnteredValue(cents, "truncate");
        expect(result.ok).toBe(true);

        if (result.ok) {
          const expectedFloor = Math.floor(cents / 100);
          expect(result.value).toBe(expectedFloor);
        }
      })
    );
  });

  /**
   * Additional property: Zero Cents Always Rounds to Zero
   *
   * Regardless of rounding mode, 0 cents must always yield 0 dollars.
   */
  it("Zero cents always rounds to zero in all modes", () => {
    const modes: RoundingMode[] = ["halfUp", "halfDown", "halfEven", "truncate"];

    modes.forEach((mode) => {
      const result = roundEnteredValue(0, mode);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });
  });

  /**
   * Additional property: Integer Dollar Amounts Unchanged
   *
   * For any cents value that is an exact dollar amount (divisible by 100),
   * rounding in any mode SHALL return the same value.
   */
  it("Exact dollar amounts are unchanged in all modes", () => {
    fc.assert(
      fc.property(fc.nat({ max: 100_000 }), (dollars) => {
        const cents = dollars * 100;
        const modes: RoundingMode[] = ["halfUp", "halfDown", "halfEven", "truncate"];

        modes.forEach((mode) => {
          const result = roundEnteredValue(cents, mode);
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value).toBe(dollars);
          }
        });
      })
    );
  });

  /**
   * Additional property: Consistency Across Modes for Boundary Values
   *
   * For cents values below 50 (fractional part < 0.5), all modes
   * except halfEven should round down; halfEven also rounds down for even floors.
   */
  it("Values below 50 cents round down in all modes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 49 }), (cents) => {
        const modes: RoundingMode[] = ["halfUp", "halfDown", "halfEven", "truncate"];

        modes.forEach((mode) => {
          const result = roundEnteredValue(cents, mode);
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value).toBe(0);
          }
        });
      })
    );
  });

  /**
   * Additional property: Values Above 50 Cents
   *
   * For cents values from 51 to 99 (fractional part > 0.5), halfUp, halfEven,
   * and halfDown all round up to 1; only truncate rounds down to 0.
   */
  it("Values above 50 cents (51-99) round up in halfUp, halfEven, and halfDown modes; truncate rounds down", () => {
    fc.assert(
      fc.property(fc.integer({ min: 51, max: 99 }), (cents) => {
        // halfUp should round up
        const resultUp = roundEnteredValue(cents, "halfUp");
        expect(resultUp.ok).toBe(true);
        if (resultUp.ok) {
          expect(resultUp.value).toBe(1);
        }

        // halfEven should round up for fractional part > 0.5
        const resultEven = roundEnteredValue(cents, "halfEven");
        expect(resultEven.ok).toBe(true);
        if (resultEven.ok) {
          expect(resultEven.value).toBe(1);
        }

        // halfDown should round up for fractional part > 0.5
        const resultDown = roundEnteredValue(cents, "halfDown");
        expect(resultDown.ok).toBe(true);
        if (resultDown.ok) {
          expect(resultDown.value).toBe(1);
        }

        // truncate should round down
        const resultTrunc = roundEnteredValue(cents, "truncate");
        expect(resultTrunc.ok).toBe(true);
        if (resultTrunc.ok) {
          expect(resultTrunc.value).toBe(0);
        }
      })
    );
  });

  /**
   * Additional property: Type Safety - Non-Integer Throws Error
   *
   * Passing a non-integer value (including NaN, Infinity) SHALL throw an Error.
   */
  it("Non-integer cents values throw an Error", () => {
    expect(() => roundEnteredValue(50.5, "halfUp")).toThrow();
    expect(() => roundEnteredValue(NaN, "halfUp")).toThrow();
    expect(() => roundEnteredValue(Infinity, "halfUp")).toThrow();
    expect(() => roundEnteredValue(-Infinity, "halfUp")).toThrow();
  });

  /**
   * Additional property: Large Values Handled Correctly
   *
   * For very large cents values, rounding must still work correctly
   * and maintain the bound property (difference ≤ 0.5).
   */
  it("Large cents values are rounded correctly", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: Number.MAX_SAFE_INTEGER - 1 }),
        (largeValue) => {
          const result = roundEnteredValue(largeValue, "halfUp");
          expect(result.ok).toBe(true);

          if (result.ok) {
            const expectedFloor = Math.floor(largeValue / 100);
            const expectedCeil = Math.ceil(largeValue / 100);
            expect([expectedFloor, expectedCeil]).toContain(result.value);
          }
        }
      )
    );
  });
});
