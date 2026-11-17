/**
 * src/rules/weights.ts
 *
 * P11: Gross Weight Allocation (Column 34A on CBP Form 7501)
 *
 * Allocates shipment gross weight across lines proportionally using the
 * largest remainder method, ensuring all parts sum exactly to the total.
 */

import type { RuleResult, AllocatedWeight } from "./types";
import { grossWeightDecimals as defaultDecimals } from "./config";

/**
 * Allocate shipment gross weight across lines using the largest remainder method.
 *
 * This implements P11 (Gross Weight Allocation) from CBP Form 7501, Column 34A.
 *
 * Given a total gross weight in kilograms and a list of basis values per line,
 * this function distributes the weight proportionally across lines such that:
 * - The sum of allocated weights equals the total exactly
 * - Each allocated weight has the specified number of decimal places
 * - Lines with higher basis values receive proportionally more weight
 * - All allocated values are marked as estimated
 *
 * **Algorithm** (Largest Remainder Method):
 * 1. Convert totalKg to integer units: units = round(totalKg * 10^decimals)
 * 2. Compute total basis: sum = sum(lineBasis)
 * 3. For each line i, compute:
 *    - floor_i = floor(units * basis_i / sum) (integer part to allocate)
 *    - remainder_i = units * basis_i - floor_i * sum (fractional remainder for tie-breaking)
 * 4. Allocate integer parts: units_i = floor_i
 * 5. Compute leftover units: leftover = units - sum(floor_i)
 * 6. Distribute leftover one by one to lines with largest remainders; ties go to earlier line
 * 7. Convert back: kilograms_i = units_i / 10^decimals
 * 8. Mark all as estimated = true
 *
 * @param totalKg - Total gross weight in kilograms (non-negative number or decimal)
 * @param lineBasis - Array of non-negative numeric basis values per line
 * @param decimals - Number of decimal places for output (default: config.grossWeightDecimals)
 * @returns RuleResult<AllocatedWeight[]>
 *   - OkResult: Array of allocated weights with kilograms and estimated flag
 *   - NeedsReview: If input violates constraints (see below)
 *
 * **NeedsReview cases:**
 * - lineBasis is empty
 * - Every element in lineBasis is 0
 * - Any element in lineBasis is negative or not an integer
 * - totalKg is negative or has more than `decimals` decimal places
 *
 * **Guarantees:**
 * - sum(allocated kilograms) = totalKg exactly
 * - Each allocated weight is non-negative
 * - Each allocated weight has exactly `decimals` decimal places
 * - All allocated weights are marked estimated = true
 * - Zero-basis line gets 0 kg (when other lines have positive basis)
 * - Swapping two lines swaps their allocated weights
 *
 * **Examples:**
 * - allocateGrossWeight(286, [886, 472, 131, 528, 336, 194, 315], 0)
 *   → OkResult([
 *       { kilograms: 89, estimated: true },
 *       { kilograms: 47, estimated: true },
 *       { kilograms: 13, estimated: true },
 *       { kilograms: 53, estimated: true },
 *       { kilograms: 34, estimated: true },
 *       { kilograms: 19, estimated: true },
 *       { kilograms: 31, estimated: true }
 *     ])  // Sum: 89+47+13+53+34+19+31 = 286
 *
 * - allocateGrossWeight(10, [0, 0], 0)
 *   → NeedsReview("All basis values are 0; proportional allocation is not possible")
 *
 * - allocateGrossWeight(10, [], 0)
 *   → NeedsReview("Line basis list is empty; allocation requires at least one line")
 *
 * - allocateGrossWeight(10.5, [1, 1], 1)
 *   → OkResult([
 *       { kilograms: 5.3, estimated: true },
 *       { kilograms: 5.2, estimated: true }
 *     ])  // Sum: 5.3 + 5.2 = 10.5
 */
export function allocateGrossWeight(
  totalKg: number,
  lineBasis: number[],
  decimals: number = defaultDecimals
): RuleResult<AllocatedWeight[]> {
  // Validate lineBasis is not empty
  if (!Array.isArray(lineBasis) || lineBasis.length === 0) {
    return {
      ok: false,
      reason: "Line basis list is empty; allocation requires at least one line.",
    };
  }

  // Validate each basis value: must be non-negative integer
  for (let i = 0; i < lineBasis.length; i++) {
    const basis = lineBasis[i];

    if (!Number.isInteger(basis)) {
      return {
        ok: false,
        reason: `Basis value at line ${i} is not an integer: ${basis}. All basis values must be non-negative integers.`,
      };
    }

    if (basis < 0) {
      return {
        ok: false,
        reason: `Basis value at line ${i} is negative: ${basis}. All basis values must be non-negative.`,
      };
    }
  }

  // Validate that not all basis values are zero
  const sumBasis = lineBasis.reduce((sum, basis) => sum + basis, 0);
  if (sumBasis === 0) {
    return {
      ok: false,
      reason: "All basis values are 0; proportional allocation is not possible.",
    };
  }

  // Validate totalKg: must be non-negative and have at most `decimals` decimal places
  if (totalKg < 0) {
    return {
      ok: false,
      reason: `Total gross weight is negative: ${totalKg} kg. Gross weight must be non-negative.`,
    };
  }

  // Check decimal places: multiply by 10^decimals and verify it's an integer
  // Use a small tolerance for floating-point comparison
  const multiplier = Math.pow(10, decimals);
  const unitsExact = totalKg * multiplier;
  const units = Math.round(unitsExact);

  // Check if totalKg has more decimal places than allowed
  // Use tolerance of 1e-6 to account for floating-point precision
  if (Math.abs(unitsExact - units) > 1e-6) {
    const actualDecimals = countDecimalPlaces(totalKg);
    return {
      ok: false,
      reason: `Total gross weight has ${actualDecimals} decimal places, but only ${decimals} are allowed. Gross weight: ${totalKg} kg.`,
    };
  }

  // Apply largest remainder method
  const allocations: number[] = new Array(lineBasis.length);
  let totalAllocated = 0;

  // Step 1: Compute floor values and remainders
  const floors: number[] = new Array(lineBasis.length);
  const remainders: number[] = new Array(lineBasis.length);

  for (let i = 0; i < lineBasis.length; i++) {
    const numerator = units * lineBasis[i];
    floors[i] = Math.floor(numerator / sumBasis);
    remainders[i] = numerator - floors[i] * sumBasis;
    allocations[i] = floors[i];
    totalAllocated += floors[i];
  }

  // Step 2: Distribute leftover units to lines with largest remainders
  const leftover = units - totalAllocated;

  if (leftover > 0) {
    // Create array of indices sorted by remainder (descending), with ties going to earlier index
    const indicesByRemainder = Array.from({ length: lineBasis.length }, (_, i) => i)
      .sort((a, b) => {
        const remainderDiff = remainders[b] - remainders[a];
        if (remainderDiff !== 0) return remainderDiff;
        // Tie: earlier index wins
        return a - b;
      });

    // Distribute leftover units one by one
    for (let i = 0; i < leftover; i++) {
      allocations[indicesByRemainder[i]]++;
    }
  }

  // Step 3: Convert back to kilograms and create result
  const result: AllocatedWeight[] = allocations.map((units) => ({
    kilograms: units / multiplier,
    estimated: true,
  }));

  return {
    ok: true,
    value: result,
  };
}

/**
 * Helper: Count the number of decimal places in a number.
 * @param num - The number to check
 * @returns Number of decimal places
 *
 * Examples:
 * - countDecimalPlaces(10) → 0
 * - countDecimalPlaces(10.5) → 1
 * - countDecimalPlaces(10.123) → 3
 */
function countDecimalPlaces(num: number): number {
  // Convert to string and check if it contains a decimal point
  const str = num.toString();
  const decimalIndex = str.indexOf(".");

  if (decimalIndex === -1) {
    return 0; // No decimal point
  }

  // Count digits after decimal point
  const afterDecimal = str.substring(decimalIndex + 1);

  // Handle scientific notation (e.g., 1e-10)
  if (afterDecimal.includes("e") || afterDecimal.includes("E")) {
    // For scientific notation, use a different approach
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
