import { describe, it } from "vitest";
import fc from "fast-check";
import { formatCharges } from "./charges";

/**
 * Property-Based Tests for formatCharges()
 *
 * These tests validate universal correctness properties across large input spaces.
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 */

describe("formatCharges() - Property Tests", () => {
  /**
   * **Property 11: Charges Format Matches Pattern**
   * For any non-negative charges amount in cents with valid rounding mode,
   * the formatted charges string SHALL match the regex `^C\d+$`.
   *
   * **Validates: Requirements 3.4**
   */
  it("Property 11: Format matches pattern ^C\\d+$", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999999 }), // Non-negative cents
        (cents) => {
          const result = formatCharges(cents);
          return result.ok && /^C\d+$/.test(result.value);
        }
      )
    );
  });

  /**
   * **Property 12: Charges Round-Trip**
   * For any formatted charges string matching `^C\d+$`, parsing the integer suffix
   * SHALL recover the exact rounded dollar amount.
   *
   * **Validates: Requirements 3.5**
   */
  it("Property 12: Round-trip recovers dollar amount", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999999 }), // Non-negative cents
        (cents) => {
          const result = formatCharges(cents);
          if (!result.ok) return true; // Skip failed results

          // Parse the dollar amount from the formatted string
          const parsed = parseInt(result.value.slice(1), 10);

          // The parsed value should be the rounded dollar amount
          const expectedDollars = Math.floor(cents / 100 + 0.5); // half-up rounding
          return parsed === expectedDollars;
        }
      )
    );
  });

  /**
   * **Property 15: Charges NeedsReview Result Narrowing**
   * For any negative charges amount that returns NeedsReview, the result must be narrowed
   * before accessing the reason field to avoid type errors.
   *
   * **Validates: Type safety**
   */
  it("Property 15: Charges NeedsReview properly narrowed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -999999999, max: -1 }), // Negative cents
        (cents) => {
          const result = formatCharges(cents);
          if (result.ok) return true; // Skip ok results

          // After narrowing, we can safely access reason
          return typeof result.reason === "string" && result.reason.length > 0;
        }
      )
    );
  });

  /**
   * **Property 13: Charges Negative Rejected**
   * For any negative charges amount, the charges function SHALL return a NeedsReview result.
   *
   * **Validates: Requirements 3.2**
   */
  it("Property 13: Negative charges rejected", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -999999999, max: -1 }), // Negative cents
        (cents) => {
          const result = formatCharges(cents);
          return !result.ok && result.reason.toLowerCase().includes("negative");
        }
      )
    );
  });

  /**
   * **Property 14: Charges Transport Code 60**
   * For any charges amount and transport code "60", the result SHALL be OkResult("C0").
   *
   * **Validates: Requirements 3.3**
   */
  it("Property 14: Transport code 60 always returns C0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -999999999, max: 999999999 }), // Any integer
        (cents) => {
          const result = formatCharges(cents, "60");
          return result.ok && result.value === "C0";
        }
      )
    );
  });

  /**
   * **Property: Rounding Mode Consistency**
   * For a given cents value and rounding mode, repeated calls SHALL return the same result.
   */
  it("Property: Rounding mode consistency", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999999 }),
        fc.constantFrom("halfUp", "halfDown", "halfEven", "truncate"),
        (cents, mode) => {
          const result1 = formatCharges(cents, undefined, mode as any);
          const result2 = formatCharges(cents, undefined, mode as any);
          return result1.ok === result2.ok && result1.value === result2.value;
        }
      )
    );
  });

  /**
   * **Property: No Dollar Sign or Decimals**
   * For any non-negative charges amount, the result SHALL not contain $, ., or other money formatting.
   */
  it("Property: No dollar sign or decimals in output", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999999 }),
        (cents) => {
          const result = formatCharges(cents);
          if (!result.ok) return true;
          return (
            !result.value.includes("$") &&
            !result.value.includes(".") &&
            !result.value.includes(",")
          );
        }
      )
    );
  });

  /**
   * **Property: Pattern Guarantees All Digits After C**
   * For any valid result, every character after 'C' SHALL be a digit 0-9.
   */
  it("Property: Pattern guarantees all digits after C", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999999 }),
        (cents) => {
          const result = formatCharges(cents);
          if (!result.ok) return true;

          // Extract characters after 'C'
          const digits = result.value.slice(1);
          // All characters should be digits 0-9
          return /^\d+$/.test(digits);
        }
      )
    );
  });

  /**
   * **Property: Determinism**
   * For identical inputs, repeated calls SHALL always produce identical outputs.
   */
  it("Property: Determinism", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999999 }),
        fc.option(fc.constantFrom("60")),
        fc.option(fc.constantFrom("halfUp", "halfDown", "halfEven", "truncate")),
        (cents, code, mode) => {
          const r1 = formatCharges(cents, code || undefined, mode as any);
          const r2 = formatCharges(cents, code || undefined, mode as any);
          const r3 = formatCharges(cents, code || undefined, mode as any);

          return (
            JSON.stringify(r1) === JSON.stringify(r2) &&
            JSON.stringify(r2) === JSON.stringify(r3)
          );
        }
      ),
      { numRuns: 100 } // More runs for determinism verification
    );
  });
});
