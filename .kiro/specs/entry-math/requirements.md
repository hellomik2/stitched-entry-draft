# Requirements Document

## Introduction

This feature implements the pure calculation and validation rules for a draft CBP Form 7501
(Entry Summary) in `src/rules/`. It covers rules P4 through P18 as defined in the
customs-rules.md steering document, plus project setup. All computations are pure
TypeScript functions with no I/O, no network calls, and no UI dependencies. Every
configurable or unconfirmed rule choice lives in `src/rules/config.ts`. The output of
every rule is either a computed value or a needs-review result with a reason. No result is
ever a silent guess.

## Glossary

- **Calculator**: The collection of pure functions in `src/rules/` that perform 7501
  arithmetic and validation.
- **Config**: The module `src/rules/config.ts` that holds every rate, limit, default
  rounding mode, and unconfirmed-rule setting.
- **NeedsReview**: A result type `{ ok: false; reason: string }` returned when a value
  cannot be computed from the available inputs.
- **OkResult**: A result type `{ ok: true; value: T }` returned when a value is
  successfully computed.
- **Cents**: Integer representation of US dollar amounts (100 cents = $1). All money
  inside `src/rules/` is stored and computed as integer cents.
- **PPM**: Parts per million. Percentage rates expressed as integers (0.3464% = 3464 ppm).
- **EnteredValue**: The whole-dollar integer reported for a line in Column 36A. Computed
  from exact cents by P4 rounding.
- **ChargesValue**: The non-negative whole-dollar integer for Column 36B, displayed with a
  leading `C` (e.g. `C550`).
- **LineItem**: One tariff line on the entry summary, carrying an exact value in cents, a
  charges amount, an HTS rate string, and a gross-weight basis.
- **MID**: Manufacturer Identification code, up to 15 uppercase alphanumeric characters,
  built from country code, name, street number, and city per CBP Appendix 2.
- **EntryNumber**: The 11-character string `XXX-NNNNNNN-C` where `XXX` is the filer code,
  `NNNNNNN` is the 7-digit number, and `C` is the check digit.
- **LargestRemainder**: An allocation method that distributes a whole-unit total across
  items proportionally, awarding leftover units to the items with the largest fractional
  remainders so the parts sum exactly to the total.

---

## Requirements

### Requirement 0: Project Setup

**User Story:** As a developer, I want a fully configured Next.js + TypeScript project, so
that I can build, test, and typecheck the application from day one.

#### Acceptance Criteria

1. THE Calculator SHALL have a `package.json` with name `entry-draft-helper`, `private: true`, scripts `dev`, `build`, `start`, `test` (runs `vitest --run`), and `typecheck` (runs `tsc --noEmit`), and dependencies `next`, `react`, `react-dom`, and devDependencies `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `vitest`, `fast-check`.
2. THE Calculator SHALL have a `tsconfig.json` configured for Next.js App Router with `strict: true` and path alias `@/*` mapping to `src/*`.
3. THE Calculator SHALL have a `next.config.ts` file compatible with Next.js App Router.
4. THE Calculator SHALL have a `vitest.config.ts` targeting the `node` environment and including `src/**/*.test.ts` and `src/**/*.property.test.ts`.
5. THE Calculator SHALL have a minimal `src/app/layout.tsx` and `src/app/page.tsx` that render a page titled "7501 Draft Helper" with visible text stating the draft is not for filing and the tool is under construction, where both statements appear as distinct, readable text elements on the page.

---

### Requirement 1: Entered Value Rounding — Column 36A (7501 p.17) — P4

**User Story:** As an Entry Writer, I want each line's value rounded to the nearest whole
dollar, so that Column 36A contains the integer the form requires.

#### Acceptance Criteria

1. WHEN an exact line value in cents is provided and is greater than or equal to 50 cents, THE Calculator SHALL round it to the nearest whole dollar using half-up rounding (exactly 50 cents rounds up) and return an OkResult containing a non-negative integer representing the whole-dollar amount. *(7501 p.17)*
2. WHEN an exact line value is greater than or equal to 0 cents and less than 50 cents, THE Calculator SHALL return an OkResult with value `0`. *(7501 p.17)*
3. WHEN an exact line value is a negative number, THE Calculator SHALL return a NeedsReview result containing a reason indicating the value is invalid. *(7501 p.17)*
4. THE Calculator SHALL guarantee that the absolute difference between the returned whole-dollar value and the original exact dollar value is at most `0.50`. *(P4 property)*
5. WHEN the exact line value is exactly 50 cents (integer value `50`), THE Calculator SHALL return an OkResult with value `1`. *(7501 p.17)*

---

### Requirement 2: Total Entered Value — Block 39 (7501 p.20) — P5

**User Story:** As an Entry Writer, I want Block 39 to show the total entered value for all
lines, so that CBP can verify the aggregate value of the shipment.

#### Acceptance Criteria

1. WHEN a list of line exact values in cents is provided in mode `sumOfRoundedLines`, THE Calculator SHALL return an OkResult equal to the sum of the individually rounded P4 values for each line. *(7501 p.20, Config setting `totalEnteredValueMode`)*
2. WHEN a list of line exact values in cents is provided in mode `roundSumOfExactLines`, THE Calculator SHALL return an OkResult equal to the P4 rounding applied to the exact sum of all line values. *(7501 p.20, Config setting `totalEnteredValueMode`)*
3. THE Calculator SHALL default to mode `sumOfRoundedLines` when no mode is specified. *(Config default)*
4. WHEN a line with a value of zero or more cents is appended to an existing list of lines, THE Calculator SHALL return a total that is greater than or equal to the total for the original list, in both modes. *(P5 property)*
5. THE Calculator SHALL guarantee that a list containing exactly one line returns a total equal to that line's individually rounded P4 value, in both modes. *(P5 property)*
6. THE Calculator SHALL guarantee that reordering the list of lines does not change the total, in both modes. *(P5 property)*
7. THE Calculator SHALL guarantee that the absolute difference between the `sumOfRoundedLines` result and the `roundSumOfExactLines` result for the same list of N lines does not exceed `50 * N` cents. *(P5 property)*
8. WHEN an empty list is provided, THE Calculator SHALL return an OkResult of zero. *(edge case)*
9. IF any line value in the provided list is negative, THEN THE Calculator SHALL return a NeedsReview result indicating that line values must be non-negative. *(input validation)*

---

### Requirement 3: Charges — Column 36B (7501 p.18) — P6

**User Story:** As an Entry Writer, I want freight and other charges formatted as `C<integer>`,
so that Column 36B carries exactly the string CBP requires.

#### Acceptance Criteria

1. WHEN a non-negative charges amount in cents is provided, THE Calculator SHALL round it to a whole number of dollars by dividing by 100 and applying the configured `chargesRounding` mode (default `halfUp`), and return an OkResult with the string `C` followed by that integer with no dollar sign, decimal point, or separator. *(7501 p.18)*
2. WHEN a negative charges amount is provided, THE Calculator SHALL return a NeedsReview result with a reason indicating the value is negative. *(7501 p.18)*
3. WHEN the mode of transportation code is `60` (passenger, hand-carried), THE Calculator SHALL return an OkResult with the string `C0`, regardless of any charges amount provided. *(7501 p.18)*
4. THE Calculator SHALL guarantee that every OkResult string matches the pattern `^C\d+$`. *(P6 property)*
5. THE Calculator SHALL guarantee that parsing the integer from an OkResult string recovers the exact rounded dollar amount. *(P6 round-trip property)*
6. IF the `chargesRounding` mode is not one of `halfUp`, `halfDown`, `halfEven`, or `truncate`, THEN THE Calculator SHALL return a NeedsReview result with a reason indicating the rounding mode is invalid. *(configuration constraint)*

---

### Requirement 4: Duty — Column 38 (7501 p.19) — P7

**User Story:** As an Entry Writer, I want duty computed automatically for `Free` and simple
ad valorem HTS rates, so that Column 38 is populated without manual arithmetic.

#### Acceptance Criteria

1. WHEN the HTS rate string is `Free` (case-insensitive), THE Calculator SHALL return an OkResult with duty of `0` cents. *(7501 p.19)*
2. WHEN the HTS rate string is a simple ad valorem percentage matching the pattern `^\d+(\.\d+)?%$` (e.g. `4%`, `16.5%`) and the duty base value is available, THE Calculator SHALL compute duty as `rate_ppm * dutiableValue / 1_000_000` rounded to cents using the configured `dutyCentsRounding` mode (default `halfUp`), and return an OkResult. *(7501 p.19)*
3. WHEN the HTS rate string is any other format (specific, compound, or unrecognized), THE Calculator SHALL return a NeedsReview result with a reason identifying the unrecognized format. *(7501 p.19)*
4. WHEN the entered value needed as the duty base is unavailable, THE Calculator SHALL return a NeedsReview result with a reason. *(7501 p.19)*
5. THE Calculator SHALL store ad valorem rates as integers in PPM internally (e.g. `16.5% = 165000 ppm`). *(tech.md)*
6. THE Calculator SHALL guarantee that duty is never negative for any non-negative entered value and non-negative rate. *(P7 property)*
7. THE Calculator SHALL guarantee that a higher entered value with the same rate never yields lower duty (monotonic in value). *(P7 property)*
8. THE Calculator SHALL guarantee that a higher ad valorem rate with the same entered value never yields lower duty (monotonic in rate). *(P7 property)*
9. IF the `dutyCentsRounding` mode is not one of `halfUp`, `halfDown`, `halfEven`, or `truncate`, THEN THE Calculator SHALL return a NeedsReview result with a reason indicating the rounding mode is invalid. *(configuration constraint)*

---

### Requirement 5: Merchandise Processing Fee — Block MPF (7501 p.20) — P8

**User Story:** As an Entry Writer, I want the MPF computed and clamped to its fiscal-year
min and max, so that the correct fee is reported without manual lookup.

#### Acceptance Criteria

1. WHEN a non-negative total dutiable value in cents is provided and no lines are FTA-exempt, THE Calculator SHALL compute MPF as `rate_ppm * value / 1_000_000` rounded to cents using the configured `mpfCentsRounding` mode (default `halfUp`), clamp the result to the inclusive range `[minimum, maximum]` cents from config, and return an OkResult. *(7501 p.20, MPF notice CBP Dec. 26-14)*
2. WHEN FTA-exempt line values are provided, THE Calculator SHALL subtract the sum of those exempt line values from the total dutiable value before computing MPF, with the reduced base floored at `0` cents, and return an OkResult. *(7501 p.20)*
3. WHEN the total dutiable value is negative, THE Calculator SHALL return a NeedsReview result with a reason indicating the value is negative. *(P8 constraint)*
4. THE Calculator SHALL store the MPF rate, minimum, maximum, and effective date exclusively in `src/rules/config.ts` as one dated entry: rate `3464 ppm` (0.3464%), minimum `3458 cents` ($34.58), maximum `67086 cents` ($670.86), effective `2026-10-01`. *(MPF notice CBP Dec. 26-14)*
5. THE Calculator SHALL guarantee that every OkResult MPF value is within `[3458, 67086]` cents inclusive. *(P8 property)*
6. THE Calculator SHALL guarantee that MPF does not decrease when the base value increases (monotonic). *(P8 property)*
7. THE Calculator SHALL guarantee that the computed MPF equals the rounded `base * rate` whenever that product lies within `[3458, 67086]` cents. *(P8 property)*

---

### Requirement 6: Summary Totals — Blocks 41–44 (7501 p.20–p.21) — P10

**User Story:** As an Entry Writer, I want Blocks 41–44 computed from their inputs, so that
the totals section of the entry summary is consistent and correct.

#### Acceptance Criteria

1. WHEN duty (Block 41), tax (Block 42), and other fees (Block 43) are all known non-negative integer values in cents, THE Calculator SHALL return an OkResult for Block 44 equal to `Block41 + Block42 + Block43` in cents. *(7501 p.20–p.21)*
2. WHEN any of Block 41, Block 42, or Block 43 is `null` (unknown), THE Calculator SHALL return a NeedsReview result for Block 44 with a reason identifying which block is unknown. *(P10 rule)*
3. WHEN any of Block 41, Block 42, or Block 43 is a negative value, THE Calculator SHALL return a NeedsReview result for Block 44 with a reason indicating which block holds a negative value. *(P10 constraint)*
4. THE Calculator SHALL guarantee that `Block44 = Block41 + Block42 + Block43` for all known non-negative inputs. *(P10 property)*
5. THE Calculator SHALL guarantee that reordering the three input blocks does not change Block 44. *(P10 property)*
6. THE Calculator SHALL guarantee that bonded AD/CVD amounts and 5232(a) deferred tax amounts are accepted as separate inputs and do not affect Block 44. *(7501 p.21)*

---

### Requirement 7: Gross Weight Allocation — Column 34A (7501 p.16–p.17) — P11

**User Story:** As an Entry Writer, I want the shipment's gross weight distributed across
lines proportionally, so that Column 34A is populated for every line and the parts sum to
the total.

#### Acceptance Criteria

1. WHEN a total gross weight in kilograms (a non-negative integer or decimal) and a non-empty list of non-negative numeric basis values per line are provided, THE Calculator SHALL allocate the weight across lines proportionally using the largest remainder method, returning the allocated amount per line in an OkResult. *(7501 p.16–p.17)*
2. THE Calculator SHALL guarantee that the sum of all allocated parts equals the total gross weight exactly. *(P11 property)*
3. THE Calculator SHALL guarantee that every allocated part is a non-negative value with the number of decimal places specified by `grossWeightDecimals`. *(P11 property)*
4. WHEN a line has basis value `0` and at least one other line has a positive basis, THE Calculator SHALL allocate `0` kg to the zero-basis line. *(P11 rule)*
5. WHEN every line has basis value `0`, THE Calculator SHALL return a NeedsReview result with a reason indicating that proportional allocation is not possible because all basis values are zero. *(P11 rule)*
6. THE Calculator SHALL mark every allocated value as estimated in the OkResult. *(7501 p.17)*
7. THE Calculator SHALL guarantee that swapping two lines swaps their allocated weights. *(P11 property)*
8. THE Calculator SHALL allocate weights as whole kilograms (zero decimal places) unless `Config.grossWeightDecimals` is set to a value between `1` and `6` inclusive, in which case THE Calculator SHALL return allocated values rounded to that many decimal places. *(P11 unconfirmed)*
9. WHEN the input line list is empty, THE Calculator SHALL return a NeedsReview result with a reason indicating that allocation requires at least one line. *(P11 rule)*

---

### Requirement 8: Entry Number Check Digit — Block 1 (7501 p.5, p.24–p.25) — P13

**User Story:** As an Entry Writer, I want the check digit computed from the filer code and
entry number, so that Block 1 contains a valid, verifiable entry number.

#### Acceptance Criteria

1. WHEN a 3-character filer code (consisting of uppercase letters A–Z and digits 0–9) and a 7-digit entry number string are provided, THE Calculator SHALL compute the check digit by converting letters to digits (A–I = 1–9, J–R = 1–9, S–Z = 2–9), leaving existing digits unchanged, doubling even-position digits (positions 2, 4, 6, 8, 10 counting from the left across all 10 digits), reducing products greater than 9 by subtracting 9, summing all adjusted digits, and returning `10 - (sum mod 10)` with the result `10` replaced by `0`. *(7501 p.24–p.25)*
2. THE Calculator SHALL return an OkResult with the check digit as a single digit `0`–`9`. *(7501 p.24–p.25)*
3. IF the filer code contains characters outside uppercase letters A–Z and digits 0–9, or the entry number contains characters outside digits 0–9 or is not exactly 7 characters, THEN THE Calculator SHALL return a NeedsReview result with a reason identifying which field failed validation. *(P13 rule)*
4. THE Calculator SHALL produce check digit `8` for filer code `B76` with entry number `0324527`. *(7501 p.24–p.25 mandatory example)*
5. THE Calculator SHALL produce check digit `3` for filer code `RO7` (letter O) with entry number `1010035`. *(7501 p.24–p.25 mandatory example)*
6. THE Calculator SHALL produce check digit `6` for filer code `R07` (digit zero) with entry number `1010035`. *(7501 p.24–p.25 mandatory example)*
7. THE Calculator SHALL guarantee that every OkResult entry number string matches `^[A-Z0-9]{3}-\d{7}-\d$`. *(7501 p.5)*
8. THE Calculator SHALL guarantee that changing any single digit of the 7-digit entry number changes the check digit. *(P13 property)*
9. WHEN a valid filer code and entry number are provided together with an existing check digit to validate, THE Calculator SHALL compare the computed check digit against the provided check digit and, IF they differ, THEN THE Calculator SHALL return a NeedsReview result with the reason "mismatch (an authorized check digit factor may apply)". *(7501 p.25)*

---

### Requirement 9: Manufacturer ID — Block 13 (7501 p.9–p.10, p.26–p.27) — P14

**User Story:** As an Entry Writer, I want the MID generated from supplier name, address,
and country, so that Block 13 is populated consistently with the CBP Appendix 2 rules.

#### Acceptance Criteria

1. WHEN a country code, manufacturer name, street address line, and city are provided, THE Calculator SHALL build the MID by concatenating in uppercase: (a) the two-letter country code or Canadian province code; (b) the first three characters of each of the first two qualifying name words; (c) up to the first four digits of the largest street number found in the address (using all digits if the number has fewer than four); and (d) the first three letters of the city. *(7501 p.9–p.10, p.26–p.27)*
2. THE Calculator SHALL ignore English articles `a`, `an`, `and`, `of`, `the` when identifying name words. *(7501 p.26–p.27)*
3. THE Calculator SHALL ignore punctuation (commas, periods, apostrophes, ampersands) in the manufacturer name. *(7501 p.26–p.27)*
4. THE Calculator SHALL ignore single-character initials in the manufacturer name; two or more consecutive initials are treated as one word. *(7501 p.26–p.27)*
5. THE Calculator SHALL treat hyphenated name parts as one word. *(7501 p.26–p.27)*
6. THE Calculator SHALL treat numbers as characters contributing to name words. *(7501 p.26–p.27)*
7. WHEN the country is Canada (`CA`), THE Calculator SHALL substitute the provincial code (e.g. `XO` for Ontario) for `CA` as the country prefix. *(7501 p.26–p.27)*
8. WHEN the city is a city-state (Hong Kong, Singapore, Macau), THE Calculator SHALL use the country name abbreviation for the city portion (`HON`, `SIN`, `MAC`). *(7501 p.26–p.27)*
9. WHEN the manufacturer name begins with a known generic leading word and the caller provides a list of words to drop, THE Calculator SHALL remove those words before processing. *(7501 p.26–p.27)*
10. WHEN the manufacturer name begins with a known generic leading word and no drop list is provided, THE Calculator SHALL return a NeedsReview result with a reason identifying the leading word that requires confirmation. *(P14 rule)*
11. THE Calculator SHALL return an OkResult with MID `FRLAVIE243BRE` for inputs: name `LA VIE DE FRANCE`, street `243 Rue de la Payees`, city `Bremond`, country `FR`. *(7501 p.27 mandatory example)*
12. THE Calculator SHALL return an OkResult with MID `AUCARJON88SID` for inputs: name `CARDUCCIO AND JONES`, street `88 Canberra Avenue`, city `Sidney`, country `AU`. *(7501 p.27 mandatory example)*
13. THE Calculator SHALL return an OkResult with MID `JPMINCO26KOB` for inputs: name `N. MINAMI & CO., LTD.`, street `2-6, 8-Chome Isogami-Dori`, city `Kobe`, country `JP`. *(7501 p.27 mandatory example)*
14. THE Calculator SHALL return an OkResult with MID `XOHURLAN1840WIN` for inputs: name `HURON LANDMARK`, street `1840 Huron Road`, city `Windsor`, country `CA`, province `ON`. *(7501 p.27 mandatory example)*
15. THE Calculator SHALL guarantee that every OkResult MID length is at most 15 characters. *(P14 property)*
16. THE Calculator SHALL guarantee that every OkResult MID matches `^[A-Z0-9]+$`. *(P14 property)*
17. THE Calculator SHALL guarantee that adding or removing punctuation, extra spaces, or ignored words from the name input does not change the MID. *(P14 property)*
18. THE Calculator SHALL guarantee that the case of input does not affect the MID. *(P14 property)*
19. IF the country is `CA` and no province is provided, THEN THE Calculator SHALL return a NeedsReview result with a reason indicating that a provincial code is required for Canadian addresses. *(P14 rule)*
20. IF the street address contains no numeric component, THEN THE Calculator SHALL omit the street number segment from the MID and continue building the remaining segments. *(P14 rule)*
21. IF after removing articles, punctuation, initials, and generic leading words the manufacturer name yields fewer than two qualifying words, THEN THE Calculator SHALL use the available qualifying words (one or zero) for the name segment and continue building the remaining MID segments. *(P14 rule)*

---

### Requirement 10: Date Formatting and Validation — Blocks 3, 7, 11, 15, 17 (7501 p.6–p.11) — P17

**User Story:** As an Entry Writer, I want dates validated and formatted as `MM/DD/YYYY`, so
that every date block on the form is in the required format and business rules are enforced.

#### Acceptance Criteria

1. WHEN a date string matching the pattern `MM/DD/YYYY` or `M/D/YYYY` (with or without zero-padding) represents a valid calendar date with year in the range 1900–2999, THE Calculator SHALL format it as `MM/DD/YYYY` with zero-padded month and day and return an OkResult. *(7501 p.6–p.11)*
2. WHEN a date string represents an impossible calendar date (e.g. `02/30/2026`) or falls outside the year range 1900–2999, THE Calculator SHALL return a NeedsReview result with a reason identifying the invalid date. *(P17 property)*
3. WHEN a date string does not match the pattern `MM/DD/YYYY` or `M/D/YYYY`, or is empty, THE Calculator SHALL return a NeedsReview result with a reason identifying the unrecognised format. *(P17 property)*
4. WHEN an IT date (Block 17) is earlier than the import date (Block 11), THE Calculator SHALL return a NeedsReview result with a reason. *(7501 p.11)*
5. WHEN an export date (Block 15) is later than the import date (Block 11), THE Calculator SHALL return a NeedsReview result with a reason. *(P17 our reading)*
6. THE Calculator SHALL guarantee that formatting a valid date string and then parsing the resulting `MM/DD/YYYY` string returns the same calendar year, month, and day. *(P17 property)*

---

### Requirement 11: Line Numbers — Column 31 (7501 p.14) — P18

**User Story:** As an Entry Writer, I want line items numbered sequentially from `001`, so
that Column 31 is correct after any insert, delete, or reorder operation.

#### Acceptance Criteria

1. WHEN a non-empty list of line items is provided, THE Calculator SHALL assign sequential three-digit zero-padded numbers starting at `001` and return an OkResult containing the numbered list. *(7501 p.14)*
2. WHEN an empty list of line items is provided, THE Calculator SHALL return an OkResult containing an empty list. *(P18 property)*
3. WHEN a renumber operation is applied after any insert, delete, or reorder, THE Calculator SHALL produce line numbers exactly `001` through `N` with no gaps and no repeats. *(P18 property)*
4. WHEN a renumber operation is applied, THE Calculator SHALL preserve the relative order of line items as supplied. *(P18 property)*
5. WHEN the number of lines exceeds the `maxLineNumber` Config setting (default `999`), THE Calculator SHALL return a NeedsReview result with a reason; no line numbers shall be assigned to that list. *(P18 unconfirmed)*

---

### Requirement 12: Configuration Module

**User Story:** As a developer, I want all rates, limits, rounding modes, and unconfirmed
rule choices in one file, so that fiscal-year updates and rule changes require editing
exactly one place.

#### Acceptance Criteria

1. THE Calculator SHALL have a `src/rules/config.ts` file that is the single source of truth for all rates, minimums, maximums, rounding modes, and unconfirmed-rule settings. *(tech.md, customs-rules.md)*
2. THE Config SHALL contain the MPF fiscal-year 2027 entry with rate `3464 ppm`, minimum `3458 cents`, maximum `67086 cents`, and effective date `2026-10-01`. *(MPF notice CBP Dec. 26-14)*
3. THE Config SHALL contain the setting `totalEnteredValueMode` with default `"sumOfRoundedLines"` and allowed values `"sumOfRoundedLines"` and `"roundSumOfExactLines"`. *(P5 unconfirmed)*
4. THE Config SHALL contain the setting `chargesRounding` with default `"halfUp"`. *(P6 unconfirmed)*
5. THE Config SHALL contain the setting `dutyBase` with default `"roundedEnteredValue"` and allowed values `"roundedEnteredValue"` and `"exactEnteredValue"`. *(P7 unconfirmed)*
6. THE Config SHALL contain the setting `dutyCentsRounding` with default `"halfUp"`. *(P7 unconfirmed)*
7. THE Config SHALL contain the setting `mpfCentsRounding` with default `"halfUp"`. *(P8 unconfirmed)*
8. THE Config SHALL contain the setting `grossWeightDecimals` with default `0`. *(P11 unconfirmed)*
9. THE Config SHALL contain the setting `maxLineNumber` with default `999`. *(P18 unconfirmed)*
10. THE Calculator SHALL guarantee that no rate, minimum, maximum, or unconfirmed-rule constant appears anywhere in `src/rules/` other than `src/rules/config.ts`. *(tech.md)*
11. IF a Config setting is assigned a value outside its defined set of allowed values at runtime, THEN THE Calculator SHALL throw a programmer error identifying the setting name and the invalid value before any rule function executes. *(tech.md)*

---

### Requirement 13: Result Types and Error Handling

**User Story:** As a developer, I want a consistent result type across all rule functions,
so that callers can handle needs-review conditions without catching exceptions.

#### Acceptance Criteria

1. THE Calculator SHALL define and export `OkResult<T>` as `{ ok: true; value: T }` and `NeedsReview` as `{ ok: false; reason: string }` from `src/rules/types.ts`. *(tech.md)*
2. THE Calculator SHALL export a combined type `RuleResult<T>` as `OkResult<T> | NeedsReview`. *(tech.md)*
3. WHEN a rule function receives a value that violates a runtime precondition (e.g. a non-integer supplied where integer cents are required), THE Calculator SHALL throw an `Error` with a message identifying the invalid argument rather than returning a NeedsReview result. *(tech.md)*
4. THE Calculator SHALL re-export all public rule functions from `src/rules/index.ts`. *(structure.md)*
