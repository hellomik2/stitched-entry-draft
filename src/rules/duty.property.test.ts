/**
 * src/rules/duty.property.test.ts
 *
 * Property-based tests for P7 (Duty Computation) using fast-check.
 *
 * Tests validate universal correctness properties that should hold across
 * all valid inputs, rates, base modes, and configurations.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeDuty } from "./duty";

describe("computeDuty() - Property-Based Tests", () => {
  /**
   * Property 15: Free Rate Yields Zero Duty
   *
   * For any dutiable value, "Free" (case-insensitive) returns OkResult with value 0.
   *
   * **Validates: Requirement 4.1**
   */
  it("Property 15: Free rate yields zero duty", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1000000000 }), // dutiable value in cents
        (dutiableValue) => {
          // Test each case variation of "Free"
          const freeVariants = ["Free", "free", "FREE", "FrEe"];

          freeVariants.forEach((freeStr) => {
            const result = computeDuty(freeStr, dutiableValue);
            expect(result.ok).toBe(true);

            if (result.ok) {
              expect(result.value).toBe(0);
            }
          });
        }
      )
    );
  });

  /**
   * Property 16: Ad Valorem Computation Correct
   *
   * For any non-negative dutiable value and percentage rate, duty = (rate_ppm × dutiableValue / 1_000_000)
   * rounded using config.dutyCentsRounding (halfUp by default).
   *
   * **Validates: Requirements 4.2, 4.6**
   */
  it("Property 16: Ad valorem duty computation is correct", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1000 }), // percentage whole part (0–1000%)
        fc.integer({ min: 0, max: 4 }), // decimal places (0–4)
        fc.nat({ max: 1000000000 }), // dutiable value in cents
        (percentWhole, decimalPlaces, dutiableValue) => {
          // Build rate string with variable decimal places
          let rateStr: string;
          if (decimalPlaces === 0) {
            rateStr = `${percentWhole}%`;
          } else {
            // Generate decimal part with appropriate precision
            const decimalPart = Math.floor(Math.random() * (10 ** decimalPlaces))
              .toString()
              .padStart(decimalPlaces, "0");
            rateStr = `${percentWhole}.${decimalPart}%`;
          }

          const result = computeDuty(rateStr, dutiableValue, "exactEnteredValue");
          expect(result.ok).toBe(true);

          if (result.ok) {
            // Parse rate string to compute expected value
            const percentageMatch = rateStr.match(/^(\d+(?:\.\d{1,4})?)%$/);
            expect(percentageMatch).not.toBeNull();

            if (percentageMatch) {
              const percentageValue = parseFloat(percentageMatch[1]);
              const ppm = Math.round(percentageValue * 10000);

              // Compute expected: (ppm * dutiableValue) / 1_000_000, then round halfUp
              const dutyExact = (ppm * dutiableValue) / 1_000_000;
              const floor = Math.floor(dutyExact);
              const expectedDuty = dutyExact - floor >= 0.5 ? floor + 1 : floor;

              // Allow ±1 cent tolerance for floating-point rounding artifacts
              expect(Math.abs(result.value - expectedDuty)).toBeLessThanOrEqual(1);
            }
          }
        }
      )
    );
  });

  /**
   * Property 17: Non-Negativity for Non-Negative Inputs
   *
   * For any non-negative dutiable value and non-negative rate, computeDuty returns non-negative value.
   *
   * **Validates: Requirement 4.6**
   */
  it("Property 17: Duty is non-negative for non-negative inputs", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100 }), // percentage 0–100
        fc.nat({ max: 1000000000 }), // dutiable value in cents
        (percentage, dutiableValue) => {
          const rateStr = `${percentage}%`;
          const result = computeDuty(rateStr, dutiableValue);

          expect(result.ok).toBe(true);

          if (result.ok) {
            expect(result.value).toBeGreaterThanOrEqual(0);
          }
        }
      )
    );
  });

  /**
   * Property 18: Monotonic in Value
   *
   * For fixed rate, higher dutiable value never yields lower duty.
   * If A ≥ B, then duty(rateStr, A) ≥ duty(rateStr, B).
   *
   * **Validates: Requirement 4.7**
   */
  it("Property 18: Duty is monotonic in dutiable value", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100 }), // percentage 0–100
        fc.nat({ max: 500000000 }), // value1 in cents
        fc.nat({ max: 100000000 }), // increment
        (percentage, value1, increment) => {
          const value2 = value1 + increment;
          const rateStr = `${percentage}%`;

          const result1 = computeDuty(rateStr, value1, "exactEnteredValue");
          const result2 = computeDuty(rateStr, value2, "exactEnteredValue");

          expect(result1.ok).toBe(true);
          expect(result2.ok).toBe(true);

          if (result1.ok && result2.ok) {
            // Monotonicity: higher value → higher or equal duty
            expect(result2.value).toBeGreaterThanOrEqual(result1.value);
          }
        }
      )
    );
  });

  /**
   * Property 19: Monotonic in Rate
   *
   * For fixed dutiable value, higher rate never yields lower duty.
   * If rate A ≥ rate B, then duty(A, dutiableValue) ≥ duty(B, dutiableValue).
   *
   * **Validates: Requirement 4.8**
   */
  it("Property 19: Duty is monotonic in rate", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 50 }), // rate1: 0–50%
        fc.nat({ max: 50 }), // rate increment
        fc.nat({ max: 1000000000 }), // dutiable value in cents
        (rate1Percent, rateIncrement, dutiableValue) => {
          const rate2Percent = rate1Percent + rateIncrement;
          const rateStr1 = `${rate1Percent}%`;
          const rateStr2 = `${rate2Percent}%`;

          const result1 = computeDuty(rateStr1, dutiableValue, "exactEnteredValue");
          const result2 = computeDuty(rateStr2, dutiableValue, "exactEnteredValue");

          expect(result1.ok).toBe(true);
          expect(result2.ok).toBe(true);

          if (result1.ok && result2.ok) {
            // Monotonicity: higher rate → higher or equal duty
            expect(result2.value).toBeGreaterThanOrEqual(result1.value);
          }
        }
      )
    );
  });
});
