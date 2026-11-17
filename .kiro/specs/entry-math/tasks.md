# Implementation Plan: Entry Math Calculator

## Overview

This implementation plan breaks down the Entry Math Calculator feature into manageable incremental steps. We start by setting up the project structure and configuration, define core types, then implement each rule function in dependency order (rounding first, as it's used by other rules), and finally add comprehensive property-based tests. All testing tasks are marked optional but highly recommended. Each task builds on previous work and integrates cleanly into the final module.

## Tasks

- [ ] 1. Project Setup
  - [x] 1.1 Create package.json with next, react, react-dom, typescript, vitest, fast-check
    - Add name `entry-draft-helper` with `private: true`
    - Add scripts: `dev`, `build`, `start`, `test` (runs `vitest --run`), `typecheck` (runs `tsc --noEmit`)
    - Add all dependencies and devDependencies per Requirement 0
    - _Requirements: 0.1_

  - [x] 1.2 Create tsconfig.json with strict mode and path aliases
    - Configure for Next.js App Router
    - Enable `strict: true`
    - Set path alias `@/*` mapping to `src/*`
    - _Requirements: 0.2_

  - [x] 1.3 Create next.config.ts
    - Configure for Next.js App Router compatibility
    - _Requirements: 0.3_

  - [x] 1.4 Create vitest.config.ts
    - Set environment to `node`
    - Include test patterns for `**/*.test.ts` and `**/*.property.test.ts`
    - _Requirements: 0.4_

  - [ ] 1.5 Create src/app/layout.tsx with page title "7501 Draft Helper"
    - Minimal Next.js layout
    - Set document title
    - _Requirements: 0.5_

  - [x] 1.6 Create src/app/page.tsx with visible disclaimer
    - Render text stating draft is not for filing
    - Render text stating tool is under construction
    - Both statements must be distinct, readable elements
    - _Requirements: 0.5_

- [x] 2. Core Types and Configuration
  - [x] 2.1 Create src/rules/types.ts with result types
    - Define `OkResult<T> = { ok: true; value: T }`
    - Define `NeedsReview = { ok: false; reason: string }`
    - Export `RuleResult<T> = OkResult<T> | NeedsReview`
    - _Requirements: 13.1, 13.2_

  - [x] 2.2 Create src/rules/config.ts with all settings
    - Export rounding modes: `halfUp`, `halfDown`, `halfEven`, `truncate`
    - Export MPF config: rate 3464 ppm, min 3458 cents, max 67086 cents, effective 2026-10-01
    - Export `totalEnteredValueMode` default `sumOfRoundedLines`
    - Export `chargesRounding` default `halfUp`
    - Export `dutyBase` default `roundedEnteredValue`
    - Export `dutyCentsRounding` default `halfUp`
    - Export `mpfCentsRounding` default `halfUp`
    - Export `grossWeightDecimals` default `0`
    - Export `maxLineNumber` default `999`
    - Export `validateConfig()` function to validate all settings at load time
    - Call `validateConfig()` at module load
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11_

- [ ] 3. Entered Value Rounding — P4
  - [x] 3.1 Implement src/rules/rounding.ts with roundEnteredValue()
    - Accept cents (integer) and optional RoundingMode
    - Return NeedsReview if cents is negative
    - Throw Error if cents is not an integer
    - Divide cents by 100 to get dollars
    - Apply specified rounding mode (default halfUp from config)
    - Return OkResult with integer dollar amount
    - Support halfUp: 50 cents rounds to 1 dollar
    - Support other modes: halfDown, halfEven, truncate
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ] 3.2 Write property tests for rounding in src/rules/rounding.property.test.ts
    - **Property 1: Half-up rounds 50 cents up**
    - **Property 2: Rounding bounds difference**
    - **Property 3: Negative cents rejected**
    - Use fast-check to generate non-negative cents values
    - Test all rounding modes (halfUp, halfDown, halfEven, truncate)
    - Verify properties hold for cents in range [0, 1000000]
    - _Requirements: 1.1, 1.4, 1.5_

- [ ] 4. Total Entered Value — P5
  - [x] 4.1 Implement src/rules/totals.ts with totalEnteredValue()
    - Accept linesCents array and optional mode
    - Default mode to config.totalEnteredValueMode
    - For `sumOfRoundedLines`: round each line individually using P4, sum results
    - For `roundSumOfExactLines`: sum all cents first, then apply P4
    - Return NeedsReview if any line value is negative
    - Return OkResult(0) for empty array
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [ ] 4.2 Write property tests for total entered value in src/rules/totals.property.test.ts
    - **Property 4: Sum of rounded lines equals summed P4 results**
    - **Property 5: Round sum of exact lines equals P4(sum)**
    - **Property 6: Monotonicity: adding non-negative value increases total**
    - **Property 7: Single-line equivalence to P4**
    - **Property 8: Commutativity: reordering doesn't change total**
    - **Property 9: Mode difference bounded by 50*N cents**
    - **Property 10: Empty list returns 0**
    - Use fast-check to generate arrays of non-negative cents
    - Test both modes exhaustively
    - Verify properties for arrays up to 100 lines
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

- [ ] 5. Charges Format — P6
  - [ ] 5.1 Implement src/rules/charges.ts with formatCharges()
    - Accept cents, optional transportCode, optional rounding mode
    - Return OkResult("C0") if transportCode === "60"
    - Return NeedsReview if cents is negative
    - Round cents/100 using specified mode (default config.chargesRounding)
    - Return OkResult(`C${dollars}`)
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 5.2 Write property tests for charges in src/rules/charges.property.test.ts
    - **Property 11: Format matches pattern ^C\d+$**
    - **Property 12: Round-trip recovers dollar amount**
    - **Property 13: Negative charges rejected**
    - **Property 14: Transport code 60 always returns C0**
    - Use fast-check to generate non-negative cents and rounding modes
    - Test pattern matching for various dollar amounts
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 6. Duty Computation — P7
  - [x] 6.1 Implement src/rules/duty.ts with computeDuty()
    - Signature: computeDuty(rateStr: string, dutiableValueCents: number, baseMode: "roundedEnteredValue" | "exactEnteredValue" = config.dutyBase): RuleResult<number>
    - "Free" (any case) → ok(0)
    - Only rates matching regex ^\d+(\.\d{1,4})?%$ are valid; convert to integer ppm
    - Anything else ("2.5¢/kg", compound text, "6.12345%") → NeedsReview
    - With "roundedEnteredValue" first round the value with roundEnteredValue (P4) and use dollars*100 as the base
    - duty = ppm * base / 1_000_000, rounded with config.dutyCentsRounding (halfUp), integer math only
    - Examples: ("6.6%", 42000) -> 2772; ("5.3%", 48600) -> 2576; ("30%", 28500) -> 8550; ("6%", 43520) -> 2610; ("6%", 43520, "exactEnteredValue") -> 2611; ("Free", 43520) -> 0
    - Export computeDuty from src/rules/index.ts
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 6.2 Write property tests for duty in src/rules/duty.property.test.ts
    - **Property 15: Free rate yields zero duty**
    - **Property 16: Ad valorem computation correct**
    - **Property 17: Non-negativity for non-negative inputs**
    - **Property 18: Monotonic in value**
    - **Property 19: Monotonic in rate**
    - Use the same fast-check call shape as src/rules/totals.property.test.ts: fc.assert(fc.property(arb1, arb2, (a, b) => { ... }))
    - Example-based tests go in <name>.test.ts, property tests in <name>.property.test.ts
    - The maintainer runs the tests; do not ask to run shell commands
    - _Requirements: 4.1, 4.2, 4.6, 4.7, 4.8_

- [x] 7. Merchandise Processing Fee — P8
  - [x] 7.1 Implement src/rules/fees.ts with computeMPF()
    - Signature: computeMPF(totalDutiableValueCents: number, ftaExemptValues: number[] = []): RuleResult<number>
    - Negative or non-integer total → NeedsReview
    - base = max(0, total - sum(exempt))
    - raw = 3464 * base / 1_000_000 rounded halfUp (config.mpfCentsRounding)
    - Clamp to [3458, 67086]
    - Examples: 330600 -> 3458; 2000000 -> 6928; 50000000 -> 67086; -1 -> NeedsReview
    - Export computeMPF from src/rules/index.ts
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 7.2 Write property tests for MPF in src/rules/fees.property.test.ts
    - **Property 20: Result within [3458, 67086] cents**
    - **Property 21: Monotonic in base value**
    - **Property 22: Unclamped computation equals direct calculation when in range**
    - **Property 23: Negative base rejected**
    - Use the same fast-check call shape as src/rules/totals.property.test.ts: fc.assert(fc.property(arb1, arb2, (a, b) => { ... }))
    - Example-based tests go in <name>.test.ts, property tests in <name>.property.test.ts
    - The maintainer runs the tests; do not ask to run shell commands
    - _Requirements: 5.1, 5.3, 5.5, 5.6, 5.7_

- [ ] 8. Summary Totals — P10
  - [ ] 8.1 Implement src/rules/totals.ts with summarizeTotals()
    - Extend totals.ts (same file as P5)
    - Accept block41Duty, block42Tax, block43OtherFees (all nullable cents)
    - Accept optional block34BondedADCVD and block34B5232a
    - Return NeedsReview if any required block is null (identify which)
    - Return NeedsReview if any block is negative
    - Compute Block44 = Block41 + Block42 + Block43
    - Return OkResult with block44Total and optional bonded/deferred fields
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ] 8.2 Write property tests for summary totals in src/rules/totals.property.test.ts
    - **Property 24: Block 44 arithmetic correct**
    - **Property 25: Commutativity of blocks**
    - **Property 26: Missing input rejected**
    - Extend existing totals.property.test.ts
    - Test with various combinations of null/valid blocks
    - Verify arithmetic exhaustively
    - _Requirements: 6.1, 6.4, 6.5_

- [x] 9. Gross Weight Allocation — P11
  - [x] 9.1 Implement src/rules/weights.ts with allocateGrossWeight()
    - Signature: allocateGrossWeight(totalKg: number, lineBasis: number[], decimals: number = config.grossWeightDecimals): RuleResult<AllocatedWeight[]>, AllocatedWeight = { kilograms: number; estimated: boolean }
    - NeedsReview when: lineBasis is empty, every basis is 0, a basis is negative or not an integer, or totalKg is negative or has more than `decimals` decimals
    - units = round(totalKg * 10^decimals) (an integer)
    - sum = sum(lineBasis)
    - floor_i = floor(units * basis_i / sum), remainder_i = units * basis_i - floor_i * sum (integers)
    - Give the leftover units (units - sum(floor_i)) one by one to the largest remainders; ties go to the earlier line
    - kilograms_i = units_i / 10^decimals, estimated = true
    - The results always add up to totalKg exactly
    - Examples: allocateGrossWeight(286, [886, 472, 131, 528, 336, 194, 315], 0) -> kilograms [89, 47, 13, 53, 34, 19, 31]; allocateGrossWeight(10, [0, 0], 0) -> NeedsReview; allocateGrossWeight(10, [], 0) -> NeedsReview
    - Replace the old AllocatedWeight { kg, lineIndex, estimated } in src/rules/types.ts with { kilograms: number; estimated: boolean }
    - Export allocateGrossWeight and the type AllocatedWeight from src/rules/index.ts
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [x] 9.2 Write property tests for gross weight in src/rules/weights.property.test.ts
    - **Property 27: Sum exactness: allocated sum equals total**
    - **Property 28: Non-negativity and decimal places**
    - **Property 29: Zero-basis allocation is zero**
    - **Property 30: All-zero basis rejected**
    - **Property 31: Order preservation: swapping lines swaps allocations**
    - **Property 32: Empty list rejected**
    - Use the same fast-check call shape as src/rules/totals.property.test.ts: fc.assert(fc.property(arb1, arb2, (a, b) => { ... }))
    - Example-based tests go in <name>.test.ts, property tests in <name>.property.test.ts
    - The maintainer runs the tests; do not ask to run shell commands
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.7, 7.9_

- [ ] 10. Entry Number Check Digit — P13
  - [ ] 10.1 Implement src/rules/checkDigit.ts with computeCheckDigit() and formatEntryNumber()
    - computeCheckDigit(filerCode, entryNumber):
      - Validate filerCode: exactly 3 chars (A–Z, 0–9), return NeedsReview if invalid
      - Validate entryNumber: exactly 7 digits, return NeedsReview if invalid
      - Convert letters to digits: A–I→1–9, J–R→1–9, S–Z→2–9
      - Double even-position digits (positions 2, 4, 6, 8, 10)
      - If doubled result > 9, subtract 9
      - Sum all 10 adjusted digits
      - Compute check = (10 - (sum % 10)) % 10
      - Return OkResult(check as string)
    - formatEntryNumber(filerCode, entryNumber, checkDigit?):
      - If checkDigit not provided, compute it
      - Return OkResult(`${filerCode}-${entryNumber}-${checkDigit}`)
    - Mandatory examples: B76+0324527→8, RO7+1010035→3, R07+1010035→6
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [ ] 10.2 Write mandatory example tests for check digit in src/rules/checkDigit.test.ts
    - Test CBP mandatory examples:
      - B76-0324527 → check digit 8
      - RO7-1010035 → check digit 3 (letter O)
      - R07-1010035 → check digit 6 (digit zero)
    - Import computeCheckDigit and verify each example
    - _Requirements: 8.4, 8.5, 8.6_

  - [ ] 10.3 Write property tests for check digit in src/rules/checkDigit.property.test.ts
    - **Property 33: Format matches ^[A-Z0-9]{3}-\d{7}-\d$**
    - **Property 34: Check digit is single 0–9**
    - **Property 35: Sensitivity: changing entry digit changes check**
    - **Property 36: Validation detects mismatch**
    - Use fast-check to generate filer codes and entry numbers
    - Test format validation for all outputs
    - Test digit sensitivity exhaustively
    - _Requirements: 8.2, 8.7, 8.8, 8.9_

- [ ] 11. Manufacturer ID Generation — P14
  - [ ] 11.1 Implement src/rules/manufacturerId.ts with generateMID()
    - Accept country, manufacturerName, street, city, optional province, optional dropWords
    - Country prefix logic:
      - Canada + province: use provincial code (XO for ON, XQ for QC, etc.)
      - Canada without province: return NeedsReview
      - City-states (HK→HON, SG→SIN, MO→MAC): map to abbreviation
      - Otherwise: use country code
    - Name segment logic:
      - Split on whitespace; normalize to uppercase
      - Remove punctuation: commas, periods, apostrophes, ampersands
      - Remove articles: a, an, and, of, the
      - Skip single-char initials; consecutive initials = one word
      - Hyphenated parts = one word
      - If name starts with generic word and dropWords provided: remove it
      - If name starts with generic word and no dropWords: return NeedsReview
      - Extract first two qualifying words, 3 chars each
      - If fewer than 2 words: use available (0, 1, or 2)
    - Street number segment:
      - Find largest numeric substring
      - Take up to 4 digits (fewer if number has fewer)
      - If no number: omit this segment
    - City segment: 3 chars of city name (or mapped abbreviation for city-states)
    - Concatenate: countryPrefix + nameWords + streetNumber + cityChars
    - All uppercase, length ≤ 15
    - Mandatory examples: FRLAVIE243BRE, AUCARJON88SID, JPMINCO26KOB, XOHURLAN1840WIN
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.14_

  - [ ] 11.2 Write mandatory example tests for MID in src/rules/manufacturerId.test.ts
    - Test CBP mandatory examples:
      - FR + LA VIE DE FRANCE + 243 Rue de la Payees + Bremond → FRLAVIE243BRE
      - AU + CARDUCCIO AND JONES + 88 Canberra Avenue + Sidney → AUCARJON88SID
      - JP + N. MINAMI & CO., LTD. + 2-6, 8-Chome Isogami-Dori + Kobe → JPMINCO26KOB
      - CA/ON + HURON LANDMARK + 1840 Huron Road + Windsor → XOHURLAN1840WIN
    - Import generateMID and verify each example
    - _Requirements: 9.11, 9.12, 9.13, 9.14_

  - [ ] 11.3 Write property tests for MID in src/rules/manufacturerId.property.test.ts
    - **Property 37: Length ≤ 15 characters**
    - **Property 38: Matches ^[A-Z0-9]+$**
    - **Property 39: Punctuation insensitivity**
    - **Property 40: Article insensitivity**
    - **Property 41: Case insensitivity**
    - **Property 42: Canadian province required for CA**
    - **Property 43: Missing street number handled gracefully**
    - **Property 44: Insufficient name words handled gracefully**
    - Use fast-check to generate company names and addresses
    - Test normalization (punctuation, articles, case)
    - Test Canadian province requirement
    - Test edge cases (no street number, minimal name)
    - _Requirements: 9.15, 9.16, 9.17, 9.18, 9.19, 9.20, 9.21_

- [ ] 12. Date Formatting and Validation — P17
  - [ ] 12.1 Implement src/rules/dates.ts with formatDate() and validateDateOrdering()
    - formatDate(dateStr):
      - Parse MM/DD/YYYY or M/D/YYYY
      - Validate month 1–12, day 1–31 (calendar-aware), year 1900–2999
      - Return NeedsReview for invalid dates or unrecognized format
      - Return OkResult formatted as MM/DD/YYYY zero-padded
    - validateDateOrdering(importDate, exportDate?, itDate?):
      - importDate is required; return NeedsReview if missing
      - If exportDate > importDate: return NeedsReview
      - If itDate < importDate: return NeedsReview
      - Return OkResult(void)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [ ] 12.2 Write property tests for dates in src/rules/dates.property.test.ts
    - **Property 45: Format validation accepts MM/DD/YYYY and M/D/YYYY**
    - **Property 46: Invalid dates rejected**
    - **Property 47: Unrecognized format rejected**
    - **Property 48: Format round-trip preserves date**
    - **Property 49: IT before import rejected**
    - **Property 50: Export after import rejected**
    - Use fast-check to generate valid and invalid dates
    - Test format validation exhaustively
    - Test date ordering constraints
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

- [ ] 13. Line Numbering — P18
  - [ ] 13.1 Implement src/rules/lines.ts with numberLines()
    - Accept items array (generic type with optional lineNumber field)
    - Return OkResult([]) for empty array
    - Return NeedsReview if items.length > config.maxLineNumber
    - Assign lineNumber = `${String(i+1).padStart(3, '0')}` for each item
    - Return OkResult with numbered items
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ] 13.2 Write property tests for lines in src/rules/lines.property.test.ts
    - **Property 51: Sequential numbering 001–N**
    - **Property 52: Order preservation**
    - **Property 53: Empty list returns empty**
    - **Property 54: Exceeds maxLineNumber rejected**
    - Use fast-check to generate arrays of items
    - Test numbering for arrays up to maxLineNumber
    - Test order preservation exhaustively
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ] 14. Public Exports
  - [ ] 14.1 Create src/rules/index.ts with all public re-exports
    - Re-export types: OkResult, NeedsReview, RuleResult, AllocatedWeight, NumberedLineItem, RoundingMode
    - Re-export functions:
      - roundEnteredValue, totalEnteredValue, summarizeTotals
      - formatCharges, computeDuty, computeMPF
      - allocateGrossWeight
      - computeCheckDigit, formatEntryNumber
      - generateMID
      - formatDate, validateDateOrdering
      - numberLines
    - Re-export config and validateConfig
    - _Requirements: 13.4_

- [ ] 15. Checkpoint — Ensure all tests pass
  - Ensure all unit tests pass with `npm run test`
  - Ensure all property tests pass without counterexamples
  - Ensure TypeScript strict mode check passes with `npm run typecheck`
  - Ask the user if questions arise about test failures or type issues

- [ ] 16. Test Infrastructure Verification
  - [ ] 16.1 Verify fast-check integration in vitest
    - Ensure fast-check generators available: integer, float, nat, array, string, stringOf, etc.
    - Confirm tests run in Node environment
    - Verify property tests detect counterexamples on failure
    - _Requirements: 0.4, 0.7_

## Notes

- Tasks marked with `*` are optional sub-tasks but highly recommended for comprehensive validation
- All rule implementations (non-asterisked top-level tasks) are required
- Mandatory example tests (10.2, 11.2) are required per CBP standards in Requirement 8 and 9
- Each task references specific requirements for full traceability
- Property-based tests validate universal correctness properties and catch edge cases
- Checkpoint task ensures incremental validation and catches regressions early
- Config module is foundational—must be complete before rule implementations
- All dependencies between tasks are captured in the Task Dependency Graph below
- Type system (TypeScript strict mode) validates correctness at compile time
- Result types (OkResult, NeedsReview) prevent silent failures and enable consistent error handling

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"] },
    { "id": 1, "tasks": ["2.1", "2.2"] },
    { "id": 2, "tasks": ["3.1", "4.1", "5.1", "6.1", "7.1", "8.1", "9.1", "10.1", "11.1", "12.1", "13.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "5.2", "6.2", "7.2", "8.2", "9.2", "10.2", "10.3", "11.2", "11.3", "12.2", "13.2"] },
    { "id": 4, "tasks": ["14.1"] },
    { "id": 5, "tasks": ["16.1"] }
  ]
}
```
