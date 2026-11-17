/**
 * src/rules/rounding.property.test.ts
 *
 * Property-based tests for P4 (Entered Value Rounding)
 *
 * These tests verify universal properties that hold across all valid inputs
 * using fast-check property testing.
 *
 * **Validates: Requirements 1.1, 1.4, 1.5**
 */

import { describe, it } from "vitest";
import { expect } from "vitest";
import fc from "fast-check";
import { roundEnteredValue } from "./rounding";
import type { RoundingMode } from "./types";

describe("P4: Entered Value Rounding - Property Tests", () => {
  /**
   * Property 1: Half-up rounds 50 cents up
   *
   * For exactly 50 cents using halfUp mode, the result must be 1 dollar.
   * This is the mandatory example from the specification.
   *
   * **Validates: Requirement 1.1**
   */
  it("Property 1: Half-up rounds 50 cents up", () => {
    const result = roundEnteredValue(50, "halfUp");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1);
    }
  });

  /**
   * Property 2: Rounding bounds difference
   *
   * For any non-negative cents value, the absolute difference between
   * the rounded result (in dollars) and the exact value (cents/100) must
   * be at most 0.50 dollars.
   *
   * This property holds for all four rounding modes.
   *
   * **Validates: Requirement 1.4**
   */
  it("Property 2: Rounding bounds difference (halfUp mode)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        (cents) => {
          const result = roundEnteredValue(cents, "halfUp");
          expect(result.ok).toBe(true);

          if (result.ok) {
            const exactDollars = cents / 100;
            const roundedDollars = result.value;
            const difference = Math.abs(roundedDollars - exactDollars);

            // The difference must never exceed 0.50
            expect(difference).toBeLessThanOrEqual(0.5);
          }
        }
      )
    );
  });

  /**
   * Property 2b: Rounding bounds difference (halfDown mode)
   *
   * Same property for halfDown rounding mode.
   *
   * **Validates: Requirement 1.4**
   */
  it("Property 2b: Rounding bounds difference (halfDown mode)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        (cents) => {
          const result = roundEnteredValue(cents, "halfDown");
          expect(result.ok).toBe(true);

          if (result.ok) {
            const exactDollars = cents / 100;
            const roundedDollars = result.value;
            const difference = Math.abs(roundedDollars - exactDollars);

            expect(difference).toBeLessThanOrEqual(0.5);
          }
        }
      )
    );
  });

  /**
   * Property 2c: Rounding bounds difference (halfEven mode)
   *
   * Same property for halfEven (banker's) rounding mode.
   *
   * **Validates: Requirement 1.4**
   */
  it("Property 2c: Rounding bounds difference (halfEven mode)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        (cents) => {
          const result = roundEnteredValue(cents, "halfEven");
          expect(result.ok).toBe(true);

          if (result.ok) {
            const exactDollars = cents / 100;
            const roundedDollars = result.value;
            const difference = Math.abs(roundedDollars - exactDollars);

            expect(difference).toBeLessThanOrEqual(0.5);
          }
        }
      )
    );
  });

  /**
   * Property 2d: Rounding bounds difference (truncate mode)
   *
   * For truncate mode, the difference can reach up to (but not including) 1.00 dollar,
   * since truncate always floors. This differs from the half-* modes which guarantee ≤ 0.50.
   * Truncate is included for completeness but does not satisfy the Requirement 1.4 guarantee.
   *
   * **Validates: Requirement 1.4** (partial coverage for truncate mode)
   */
  it("Property 2d: Truncate mode floors the value", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        (cents) => {
          const result = roundEnteredValue(cents, "truncate");
          expect(result.ok).toBe(true);

          if (result.ok) {
            const exactDollars = cents / 100;
            const roundedDollars = result.value;
            // Truncate always floors, so result <= exact and difference is always < 1.0
            expect(roundedDollars).toBeLessThanOrEqual(Math.floor(exactDollars));
            expect(roundedDollars).toBe(Math.floor(cents / 100));
          }
        }
      )
    );
  });

  /**
   * Property 3: Negative cents rejected
   *
   * For any negative cents value, roundEnteredValue must return
   * NeedsReview (ok: false) with a reason that mentions "non-negative".
   *
   * **Validates: Requirement 1.5**
   */
  it("Property 3: Negative cents rejected", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000000, max: -1 }),
        (cents) => {
          const result = roundEnteredValue(cents, "halfUp");
          expect(result.ok).toBe(false);

          if (!result.ok) {
            // Reason should explain the issue
            expect(result.reason).toBeDefined();
            expect(result.reason.toLowerCase()).toContain("non-negative");
          }
        }
      )
    );
  });

  /**
   * Property 3b: Negative cents rejected (all modes)
   *
   * Verify that negative rejection applies to all rounding modes.
   *
   * **Validates: Requirement 1.5**
   */
  it("Property 3b: Negative cents rejected (all rounding modes)", () => {
    const modes: RoundingMode[] = ["halfUp", "halfDown", "halfEven", "truncate"];

    modes.forEach((mode) => {
      fc.assert(
        fc.property(
          fc.integer({ min: -1000000, max: -1 }),
          (cents) => {
            const result = roundEnteredValue(cents, mode);
            expect(result.ok).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 4: Results are non-negative integers
   *
   * For any non-negative cents value, the result must be a non-negative integer.
   *
   * **Validates: Requirement 1.1**
   */
  it("Property 4: Results are non-negative integers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        (cents) => {
          const result = roundEnteredValue(cents, "halfUp");
          expect(result.ok).toBe(true);

          if (result.ok) {
            expect(Number.isInteger(result.value)).toBe(true);
            expect(result.value).toBeGreaterThanOrEqual(0);
          }
        }
      )
    );
  });

  /**
   * Property 5: Round-trip consistency
   *
   * For different rounding modes on the same input, the result differences
   * are predictable and fall within the valid range.
   *
   * **Validates: Requirement 1.4**
   */
  it("Property 5: Round-trip consistency", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        (cents) => {
          const modes: RoundingMode[] = ["halfUp", "halfDown", "halfEven", "truncate"];

          const results = modes.map((mode) => {
            const res = roundEnteredValue(cents, mode);
            return res.ok ? res.value : null;
          });

          // All results should be successfully computed (ok: true)
          results.forEach((val) => {
            expect(val).not.toBeNull();
          });

          // All results should be non-negative
          results.forEach((val) => {
            if (val !== null) {
              expect(val).toBeGreaterThanOrEqual(0);
            }
          });

          // Truncate should always be the floor
          const [halfUpRes, halfDownRes, halfEvenRes, truncateRes] = results;
          if (truncateRes !== null && halfUpRes !== null) {
            expect(truncateRes).toBeLessThanOrEqual(halfUpRes);
          }
        }
      )
    );
  });

  /**
   * Property 6: Values under 50 cents round to 0 (halfUp)
   *
   * For any value strictly less than 50 cents using halfUp mode,
   * the result must be 0 dollars.
   *
   * **Validates: Requirement 1.1**
   */
  it("Property 6: Values under 50 cents round to 0 (halfUp)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 49 }),
        (cents) => {
          const result = roundEnteredValue(cents, "halfUp");
          expect(result.ok).toBe(true);

          if (result.ok) {
            expect(result.value).toBe(0);
          }
        }
      )
    );
  });

  /**
   * Property 7: Values 50-99 cents round to 1 (halfUp)
   *
   * For any value in [50, 99] cents using halfUp mode, the result must be 1 dollar.
   *
   * **Validates: Requirement 1.1**
   */
  it("Property 7: Values 50-99 cents round to 1 (halfUp)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 99 }),
        (cents) => {
          const result = roundEnteredValue(cents, "halfUp");
          expect(result.ok).toBe(true);

          if (result.ok) {
            expect(result.value).toBe(1);
          }
        }
      )
    );
  });

  /**
   * Property 8: Exact dollars (divisible by 100)
   *
   * For any value that is exactly divisible by 100 (n * 100),
   * all rounding modes should return n (the dollar amount).
   *
   * **Validates: Requirement 1.1**
   */
  it("Property 8: Exact dollars (divisible by 100)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10000 }),
        (dollars) => {
          const cents = dollars * 100;
          const modes: RoundingMode[] = ["halfUp", "halfDown", "halfEven", "truncate"];

          modes.forEach((mode) => {
            const result = roundEnteredValue(cents, mode);
            expect(result.ok).toBe(true);

            if (result.ok) {
              expect(result.value).toBe(dollars);
            }
          });
        }
      )
    );
  });

  /**
   * Property 9: HalfDown vs HalfUp differ only at 50 cents
   *
   * For any non-negative cents, halfUp and halfDown differ only when
   * the cents are exactly 50 (mod 100).
   *
   * **Validates: Requirement 1.4**
   */
  it("Property 9: HalfDown vs HalfUp differ only at 50 cents", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        (cents) => {
          const resultHalfUp = roundEnteredValue(cents, "halfUp");
          const resultHalfDown = roundEnteredValue(cents, "halfDown");

          expect(resultHalfUp.ok).toBe(true);
          expect(resultHalfDown.ok).toBe(true);

          if (resultHalfUp.ok && resultHalfDown.ok) {
            const remainder = cents % 100;
            if (remainder === 50) {
              // They should differ: halfUp rounds to ceil, halfDown rounds to floor
              expect(resultHalfUp.value).toBe(resultHalfDown.value + 1);
            } else {
              // They should be the same
              expect(resultHalfUp.value).toBe(resultHalfDown.value);
            }
          }
        }
      )
    );
  });

  /**
   * Property 10: Truncate mode is always floor
   *
   * For any non-negative cents, truncate mode must return floor(cents / 100).
   *
   * **Validates: Requirement 1.1**
   */
  it("Property 10: Truncate mode is always floor", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000000 }),
        (cents) => {
          const result = roundEnteredValue(cents, "truncate");
          expect(result.ok).toBe(true);

          if (result.ok) {
            const expected = Math.floor(cents / 100);
            expect(result.value).toBe(expected);
          }
        }
      )
    );
  });
});
