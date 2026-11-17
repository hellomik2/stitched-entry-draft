# Design Document: Entry Math Calculator

## Overview

The Entry Math Calculator (`src/rules/`) is a pure TypeScript calculation engine for CBP Form 7501 Entry Summary rules P4–P18. It provides deterministic, configuration-driven computation of entry values, charges, duties, fees, weights, identifiers, and validation logic. All functions are pure (no I/O, no state mutation), accept typed inputs, and return result types (`OkResult<T>` or `NeedsReview`) that prevent silent failures. Configuration is centralized in `config.ts`, enabling fiscal-year and rule-change updates without code modification.

**Key Design Principles:**
- **Pure Functions**: No I/O, network calls, or side effects
- **Result Types**: Every function returns `RuleResult<T> = OkResult<T> | NeedsReview`
- **Type Safety**: Integer cents for money, PPM for rates; strict TypeScript mode
- **Configuration Driven**: All rates, limits, rounding modes, and unconfirmed choices in one file
- **Extensibility**: New rules added without modifying existing rule logic
- **Transparency**: NeedsReview explains why a value cannot be computed; no silent guesses

---

## Architecture

### Module Organization

The `src/rules/` directory is organized by concern, with each rule group in its own file:

```
src/rules/
├── index.ts              # Public re-exports
├── types.ts              # OkResult, NeedsReview, RuleResult
├── config.ts             # All rates, limits, rounding modes, unconfirmed choices
├── rounding.ts           # P4 entered value rounding (half-up by default)
├── totals.ts             # P5 total entered value, P10 summary totals
├── charges.ts            # P6 charges formatting (C<int> format)
├── duty.ts               # P7 duty computation for Free and ad valorem rates
├── fees.ts               # P8 merchandise processing fee (MPF)
├── weights.ts            # P11 gross weight allocation (largest remainder)
├── checkDigit.ts         # P13 entry number check digit computation
├── manufacturerId.ts     # P14 MID generation from name, address, country
├── dates.ts              # P17 date formatting and validation
├── lines.ts              # P18 sequential line numbering
└── tests/                # Property-based and unit tests
    ├── rounding.property.test.ts
    ├── totals.property.test.ts
    ├── charges.property.test.ts
    ├── duty.property.test.ts
    ├── fees.property.test.ts
    ├── weights.property.test.ts
    ├── checkDigit.property.test.ts
    ├── checkDigit.test.ts         # Mandatory example tests for P13
    ├── manufacturerId.property.test.ts
    ├── manufacturerId.test.ts     # Mandatory example tests for P14
    ├── dates.property.test.ts
    └── lines.property.test.ts
```

### Type Hierarchy

```typescript
// From src/rules/types.ts
type OkResult<T> = { ok: true; value: T };
type NeedsReview = { ok: false; reason: string };
type RuleResult<T> = OkResult<T> | NeedsReview;
```

**Rules for Result Types:**
- Functions return `RuleResult<T>` to handle business-logic impossibilities (e.g., no rate specified, negative input)
- Functions **throw** `Error` for programmer violations (e.g., wrong type, missing argument) to fail fast
- Callers pattern-match on `result.ok` to dispatch on success or review need

### Mapping Requirements to Modules

| Requirement | Module | Function(s) | Purpose |
|-------------|--------|-------------|---------|
| R1 (P4) | rounding.ts | `roundEnteredValue(cents, mode?)` | Half-up rounding to whole dollars |
| R2 (P5) | totals.ts | `totalEnteredValue(linesCents, mode?)` | Sum of individually rounded or round-sum |
| R3 (P6) | charges.ts | `formatCharges(centsCents, transportCode?, mode?)` | Format charges as C<int> |
| R4 (P7) | duty.ts | `computeDuty(rate, dutiableValue, base?)` | Duty for Free and ad valorem rates |
| R5 (P8) | fees.ts | `computeMPF(value, ftaExemptValues?)` | MPF computation and clamping |
| R6 (P10) | totals.ts | `summarizeTotals(duty, tax, otherFees)` | Block 41+42+43 = Block 44 |
| R7 (P11) | weights.ts | `allocateGrossWeight(totalKg, linesBasis)` | Largest remainder method |
| R8 (P13) | checkDigit.ts | `computeCheckDigit(filer, entry)` `formatEntryNumber(filer, entry, digit)` | Check digit algorithm |
| R9 (P14) | manufacturerId.ts | `generateMID(country, name, street, city, province?, dropWords?)` | MID construction |
| R10 (P17) | dates.ts | `formatDate(dateStr)`, `validateDateOrdering(import, export, it)` | Date formatting and validation |
| R11 (P18) | lines.ts | `numberLines(items)` | Sequential line numbering |

---

## Components and Interfaces

### 1. Rounding Module (P4)

**Purpose**: Implement half-up rounding for currency.

**Public Interface**:
```typescript
function roundEnteredValue(
  cents: number,
  mode?: RoundingMode  // default: Config.chargesRounding
): RuleResult<number>
```

**Algorithm** (half-up):
1. Divide cents by 100 to get dollars
2. Round using the specified mode (default halfUp: round 0.5 up)
3. Return integer dollar amount
4. If cents < 0, return NeedsReview

**Guarantees**:
- Result is non-negative whole number
- |result - (cents/100)| ≤ 0.50
- 50 cents exactly rounds to 1 dollar
- 49 cents rounds to 0 dollars

---

### 2. Totals Module (P5, P10)

**Purpose**: Compute total entered values in two modes; summarize duty, tax, and fees.

**Public Interface**:
```typescript
function totalEnteredValue(
  linesCents: number[],
  mode?: "sumOfRoundedLines" | "roundSumOfExactLines"
): RuleResult<number>

function summarizeTotals(
  block41Duty: number | null,
  block42Tax: number | null,
  block43OtherFees: number | null,
  block34BondedADCVD?: number,
  block34B5232a?: number
): RuleResult<{ block44Total: number; bonded?: number; deferred?: number }>
```

**Algorithm** (Total Entered Value):
- **Mode `sumOfRoundedLines`**: For each line, apply P4 rounding; sum results
- **Mode `roundSumOfExactLines`**: Sum all lines in cents; apply P4 rounding to total

**Algorithm** (Summarize Totals):
- If any of Block 41, 42, 43 is null, return NeedsReview naming the block
- If any is negative, return NeedsReview identifying which
- Otherwise, return Block 44 = Block 41 + Block 42 + Block 43

**Guarantees** (Total Entered Value):
- Reordering lines does not change result
- Single-line list returns same as P4(line)
- Empty list returns 0
- Adding non-negative value increases or maintains total
- `|sumOfRoundedLines - roundSumOfExactLines| ≤ 50 * N` where N = line count

**Guarantees** (Summarize Totals):
- Block 44 = Block 41 + Block 42 + Block 43 for all valid inputs
- Order of inputs does not matter

---

### 3. Charges Module (P6)

**Purpose**: Format freight and charges as `C<dollars>`.

**Public Interface**:
```typescript
function formatCharges(
  cents: number,
  transportCode?: string,
  mode?: RoundingMode
): RuleResult<string>
```

**Algorithm**:
1. If transportCode === "60", return OkResult("C0") regardless of cents
2. If cents < 0, return NeedsReview
3. Round cents/100 using configured mode (default halfUp)
4. Return OkResult(`C${dollars}`)

**Guarantees**:
- Every OkResult matches regex `^C\d+$`
- Parsing `C<n>` recovers exact rounded dollar amount
- Negative input always returns NeedsReview
- Transport code 60 always returns C0

---

### 4. Duty Module (P7)

**Purpose**: Compute duty for Free and simple ad valorem HTS rates.

**Public Interface**:
```typescript
function computeDuty(
  rateStr: string,
  dutiableValueCents: number,
  baseMode?: "roundedEnteredValue" | "exactEnteredValue"
): RuleResult<number>
```

**Algorithm**:
1. "Free" (any case) → OkResult(0)
2. Only rates matching regex `^\d+(\.\d{1,4})?%$` are valid (e.g., "6.6%", "5.3%", "30%")
   - Convert percentage to integer PPM: 6.6% = 66000 ppm; 5.3% = 53000 ppm
   - Anything else ("2.5¢/kg", "6.12345%", compound text) → NeedsReview
3. With "roundedEnteredValue" mode: first apply roundEnteredValue (P4) to the value, then multiply by 100 to get dollars as cents
4. With "exactEnteredValue" mode: use dutiableValueCents directly
5. Compute: duty = ppm × base / 1_000_000, rounded with config.dutyCentsRounding (halfUp by default), integer math only
6. Return OkResult(duty in cents)

**Examples**:
- computeDuty("6.6%", 42000) → OkResult(2772)
- computeDuty("5.3%", 48600) → OkResult(2576)
- computeDuty("30%", 28500) → OkResult(8550)
- computeDuty("6%", 43520) → OkResult(2610)
- computeDuty("6%", 43520, "exactEnteredValue") → OkResult(2611)
- computeDuty("Free", 43520) → OkResult(0)

**Guarantees**:
- Duty ≥ 0 for non-negative value and rate
- Duty is monotonic in value (higher value ≥ same or higher duty)
- Duty is monotonic in rate (higher rate ≥ same or higher duty)

---

### 5. Fees Module (P8)

**Purpose**: Compute merchandise processing fee (MPF) with clamping.

**Public Interface**:
```typescript
function computeMPF(
  totalDutiableValueCents: number,
  ftaExemptValues?: number[]
): RuleResult<number>
```

**Configuration** (src/rules/config.ts):
```typescript
const mpfConfig = {
  rate: 3464,           // PPM (0.3464%)
  minimumCents: 3458,   // $34.58
  maximumCents: 67086,  // $670.86
  effectiveDate: "2026-10-01"
};
```

**Algorithm**:
1. If totalDutiableValueCents < 0 or is not an integer → NeedsReview
2. base = max(0, totalDutiableValueCents - sum(ftaExemptValues or []))
3. raw = 3464 × base / 1_000_000, rounded halfUp (config.mpfCentsRounding)
4. Clamp result to [3458, 67086]
5. Return OkResult(clamped result)

**Examples**:
- computeMPF(330600) → OkResult(3458)
- computeMPF(2000000) → OkResult(6928)
- computeMPF(50000000) → OkResult(67086)
- computeMPF(-1) → NeedsReview

**Guarantees**:
- Result is always within [3458, 67086] cents
- Monotonic: higher base ≥ higher or equal MPF
- When unclamped result is in range, it equals direct computation

---

### 6. Weights Module (P11)

**Purpose**: Allocate shipment gross weight across lines using largest remainder method.

**Public Interface**:
```typescript
interface AllocatedWeight {
  kilograms: number;
  estimated: boolean;
}

function allocateGrossWeight(
  totalKg: number,
  lineBasis: number[],
  decimals?: number
): RuleResult<AllocatedWeight[]>
```

**Algorithm** (Largest Remainder):
1. NeedsReview cases:
   - lineBasis is empty
   - All lineBasis are 0
   - Any lineBasis is negative or not an integer
   - totalKg is negative or has more than `decimals` decimal places
2. Convert totalKg to units: units = round(totalKg × 10^decimals) (an integer)
3. Compute total basis: sum = sum(lineBasis)
4. For each line i, compute:
   - floor_i = floor(units × basis_i / sum) (integer part to allocate)
   - remainder_i = units × basis_i - floor_i × sum (fractional part for tie-breaking)
5. Allocate integer parts to each line: units_i = floor_i
6. Compute leftover: leftover = units - sum(floor_i)
7. Distribute leftover kilograms one by one to lines with largest remainder_i; ties go to the earlier line
8. Convert back: kilograms_i = units_i / 10^decimals
9. Mark all as estimated = true
10. Return OkResult(array of AllocatedWeight)

**Examples**:
- allocateGrossWeight(286, [886, 472, 131, 528, 336, 194, 315], 0) → [89, 47, 13, 53, 34, 19, 31]
- allocateGrossWeight(10, [0, 0], 0) → NeedsReview
- allocateGrossWeight(10, [], 0) → NeedsReview

**Guarantees**:
- sum(allocated) = totalKg exactly
- Each allocated weight is non-negative
- Each allocated weight has exactly `decimals` decimal places
- Swapping lines i and j swaps their allocations
- Zero-basis line gets 0 kg (when other lines have positive basis)

---

### 7. Check Digit Module (P13)

**Purpose**: Compute 11-digit entry number including check digit.

**Public Interface**:
```typescript
function computeCheckDigit(
  filerCode: string,    // 3 chars: A–Z, 0–9
  entryNumber: string   // 7 digits: 0–9
): RuleResult<string>   // single digit 0–9

function formatEntryNumber(
  filerCode: string,
  entryNumber: string,
  checkDigit?: string
): RuleResult<string>   // "XXX-NNNNNNN-C"

function validateEntryNumber(
  entryNumber: string,
  providedCheckDigit: string
): RuleResult<void>
```

**Algorithm** (Check Digit):
1. Validate filerCode: exactly 3 chars, each is A–Z or 0–9; return NeedsReview if not
2. Validate entryNumber: exactly 7 digits; return NeedsReview if not
3. Concatenate filerCode + entryNumber = 10 chars
4. Convert letters to digits: A–I→1–9, J–R→1–9, S–Z→2–9 (per CBP rules)
5. For each digit in positions 2, 4, 6, 8, 10 (even positions, 1-indexed):
   - Double the digit
   - If result > 9, subtract 9
6. Sum all 10 adjusted digits
7. Compute check = (10 - (sum % 10)) % 10 (ensures 10 becomes 0)
8. Return OkResult(check as string)

**Mandatory Examples**:
- B76-0324527 → check digit 8
- RO7-1010035 → check digit 3 (O is letter)
- R07-1010035 → check digit 6 (0 is digit)

**Guarantees**:
- Check digit is single character 0–9
- Formatted entry number matches `^[A-Z0-9]{3}-\d{7}-\d$`
- Changing any digit in entry number changes check digit
- Validation detects any single-digit error

---

### 8. Manufacturer ID Module (P14)

**Purpose**: Generate 15-character alphanumeric MID from supplier details.

**Public Interface**:
```typescript
function generateMID(
  country: string,              // "FR", "AU", "JP", "CA", etc.
  manufacturerName: string,     // e.g. "LA VIE DE FRANCE"
  street: string,               // e.g. "243 Rue de la Payees"
  city: string,                 // e.g. "Bremond"
  province?: string,            // for Canada: "ON", "QC", etc.
  dropWords?: string[]          // generic leading words to remove
): RuleResult<string>
```

**Algorithm**:
1. **Country Prefix** (2 chars):
   - If country is "CA" and province provided: use provincial code (e.g., "XO" for Ontario)
   - If country is "CA" and no province: return NeedsReview
   - If country in city-state map (HK→HON, SG→SIN, MO→MAC): use city code later
   - Otherwise: use country code as-is

2. **Name Segment** (up to 6 chars = 2 words × 3 chars):
   - Split name on whitespace; normalize to uppercase
   - Remove punctuation: commas, periods, apostrophes, ampersands
   - Identify qualifying words:
     - Remove articles: a, an, and, of, the (case-insensitive)
     - Remove single-character initials; consecutive initials count as one word
     - Treat hyphenated parts as one word (keep hyphens internally, trim when extracting)
   - If name begins with generic leading word (e.g., "INC", "LTD") and dropWords list provided: remove it
   - If generic leading word without dropWords: return NeedsReview
   - Extract first two qualifying words; take first 3 chars each (uppercase)
   - If fewer than two words, use available words (may be 0, 1, or 2)

3. **Street Number Segment** (up to 4 chars):
   - Find largest numeric substring in street address
   - Take up to first 4 digits (fewer if number has fewer)
   - If no number found, omit this segment

4. **City Segment** (3 chars):
   - For city-states: use mapped abbreviation (HK→HON, SG→SIN, MO→MAC)
   - Otherwise: take first 3 chars of city name, uppercase

5. **Concatenate**: countryPrefix + nameWords + streetNumber + cityChars
6. Ensure all uppercase; length ≤ 15 chars
7. Return OkResult(mid)

**Mandatory Examples**:
- FR + LA VIE DE FRANCE + 243 Rue de la Payees + Bremond → FRLAVIE243BRE
- AU + CARDUCCIO AND JONES + 88 Canberra Avenue + Sidney → AUCARJON88SID
- JP + N. MINAMI & CO., LTD. + 2-6, 8-Chome Isogami-Dori + Kobe → JPMINCO26KOB
- CA/ON + HURON LANDMARK + 1840 Huron Road + Windsor → XOHURLAN1840WIN (XO = Ontario)

**Guarantees**:
- MID length ≤ 15 chars
- MID matches `^[A-Z0-9]+$`
- Adding/removing punctuation or ignored words doesn't change MID
- Input case doesn't affect MID
- Normalization of whitespace doesn't affect MID

---

### 9. Dates Module (P17)

**Purpose**: Format and validate dates; check date ordering constraints.

**Public Interface**:
```typescript
function formatDate(dateStr: string): RuleResult<string>  // MM/DD/YYYY

function validateDateOrdering(
  importDate: string,   // MM/DD/YYYY
  exportDate?: string,  // MM/DD/YYYY
  itDate?: string       // MM/DD/YYYY (issuance of title)
): RuleResult<void>
```

**Algorithm** (Format Date):
1. Parse dateStr as MM/DD/YYYY or M/D/YYYY (with or without zero-padding)
2. Validate: month 1–12, day 1–31 (calendar-aware for February, etc.), year 1900–2999
3. If invalid, return NeedsReview identifying the issue
4. If format doesn't match pattern, return NeedsReview
5. Return OkResult formatted as MM/DD/YYYY with zero-padded month and day

**Algorithm** (Validate Date Ordering):
1. Parse all provided dates
2. If importDate is not provided, return NeedsReview
3. If exportDate is provided and exportDate > importDate, return NeedsReview
4. If itDate is provided and itDate < importDate, return NeedsReview
5. Return OkResult(void)

**Guarantees**:
- Format then parse returns same calendar date
- Invalid dates caught and explained
- Date ordering enforced consistently

---

### 10. Lines Module (P18)

**Purpose**: Assign sequential line numbers.

**Public Interface**:
```typescript
interface NumberedLineItem {
  lineNumber: string;  // "001", "002", ..., "999"
  // ... line fields ...
}

function numberLines<T extends { lineNumber?: string }>(
  items: T[]
): RuleResult<(T & { lineNumber: string })[]>
```

**Algorithm**:
1. If items is empty, return OkResult([])
2. If items.length > config.maxLineNumber (default 999), return NeedsReview
3. For each item i (0-indexed), assign lineNumber = `${String(i + 1).padStart(3, '0')}`
4. Return OkResult with updated items

**Guarantees**:
- Line numbers are sequential 001–N with no gaps
- Relative order of items is preserved
- Empty list returns empty OkResult
- Exceeding maxLineNumber returns NeedsReview

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Rounding Half-Up Rounds 50 Cents Up

*For any non-negative cents value that is exactly 50 (representing $0.50), rounding to dollars using half-up mode SHALL yield 1.*

**Validates: Requirements 1.1, 1.5**

### Property 2: Rounding Bounds Difference

*For any non-negative cents value, the absolute difference between the rounded whole-dollar value and the original value in dollars SHALL not exceed 0.50 dollars.*

**Validates: Requirements 1.4**

### Property 3: Negative Cents Rejected

*For any negative cents value, the rounding function SHALL return a NeedsReview result.*

**Validates: Requirements 1.3**

### Property 4: Total Entered Value — Sum of Rounded Lines

*For any non-empty list of non-negative cents values, computing the total in `sumOfRoundedLines` mode SHALL equal the sum of individually rounded values.*

**Validates: Requirements 2.1**

### Property 5: Total Entered Value — Round Sum of Exact Lines

*For any non-empty list of non-negative cents values, computing the total in `roundSumOfExactLines` mode SHALL equal the result of rounding the sum of all exact values.*

**Validates: Requirements 2.2**

### Property 6: Total Entered Value — Monotonicity

*For any list of lines and any non-negative cents value v, the total for the list with v appended SHALL be greater than or equal to the total for the original list (in both modes).*

**Validates: Requirements 2.4**

### Property 7: Total Entered Value — Single Line Equivalence

*For any single-line list, the total in either mode SHALL equal the individually rounded value of that line.*

**Validates: Requirements 2.5**

### Property 8: Total Entered Value — Commutativity

*For any list of lines, reordering the list SHALL not change the total in either mode.*

**Validates: Requirements 2.6**

### Property 9: Total Entered Value — Mode Difference Bound

*For any list of N lines, the absolute difference between `sumOfRoundedLines` and `roundSumOfExactLines` modes SHALL not exceed 50 * N cents.*

**Validates: Requirements 2.7**

### Property 10: Total Entered Value — Empty List

*For an empty list of lines, the total SHALL be 0 in either mode.*

**Validates: Requirements 2.8**

### Property 11: Charges Format Matches Pattern

*For any non-negative charges amount in cents with valid rounding mode, the formatted charges string SHALL match the regex `^C\d+$`.*

**Validates: Requirements 3.4**

### Property 12: Charges Round-Trip

*For any formatted charges string matching `^C\d+$`, parsing the integer suffix SHALL recover the exact rounded dollar amount.*

**Validates: Requirements 3.5**

### Property 13: Charges Negative Rejected

*For any negative charges amount, the charges function SHALL return a NeedsReview result.*

**Validates: Requirements 3.2**

### Property 14: Charges Transport Code 60

*For any charges amount and transport code "60", the result SHALL be OkResult("C0").*

**Validates: Requirements 3.3**

### Property 15: Duty Free Rate Yields Zero

*For any dutiable value and HTS rate string "free" (case-insensitive), duty SHALL be 0 cents.*

**Validates: Requirements 4.1**

### Property 16: Duty Ad Valorem Computation

*For any ad valorem percentage rate matching `^\d+(\.\d+)?%$`, dutiable value, and valid base mode, duty SHALL be computed as ppm * dutiableValue / 1_000_000 and rounded correctly.*

**Validates: Requirements 4.2**

### Property 17: Duty Non-Negativity

*For any non-negative dutiable value and non-negative rate, duty SHALL be non-negative.*

**Validates: Requirements 4.6**

### Property 18: Duty Monotonic in Value

*For any rate, if dutiable value A ≥ dutiable value B, then duty(A) ≥ duty(B).*

**Validates: Requirements 4.7**

### Property 19: Duty Monotonic in Rate

*For any dutiable value, if rate A ≥ rate B, then duty(A) ≥ duty(B).*

**Validates: Requirements 4.8**

### Property 20: MPF Result Within Bounds

*For any non-negative dutiable value, the MPF result SHALL be within the configured minimum and maximum bounds [3458, 67086] cents.*

**Validates: Requirements 5.5**

### Property 21: MPF Monotonicity

*For any FTA exempt values, if base value A ≥ base value B, then MPF(A) ≥ MPF(B).*

**Validates: Requirements 5.6**

### Property 22: MPF Unclamped Computation

*For any non-negative base where the computed MPF (before clamping) lies within [3458, 67086] cents, the result SHALL equal the direct computation.*

**Validates: Requirements 5.7**

### Property 23: MPF Negative Base Rejected

*For any negative dutiable value, the MPF function SHALL return a NeedsReview result.*

**Validates: Requirements 5.3**

### Property 24: Summary Totals Arithmetic

*For any non-negative duty, tax, and other fees, Block 44 SHALL equal duty + tax + otherFees.*

**Validates: Requirements 6.1, 6.4**

### Property 25: Summary Totals Commutativity

*For any three non-negative input blocks, reordering them SHALL not change Block 44.*

**Validates: Requirements 6.5**

### Property 26: Summary Totals — Missing Input

*If any of duty, tax, or other fees is null, the summary total function SHALL return a NeedsReview result identifying the missing block.*

**Validates: Requirements 6.2**

### Property 27: Gross Weight Allocation Sum Exactness

*For any total gross weight and non-empty list of basis values, the sum of all allocated weights SHALL equal the total weight exactly.*

**Validates: Requirements 7.2**

### Property 28: Gross Weight Allocation Non-Negativity

*For any total gross weight and basis values, every allocated weight SHALL be non-negative and formatted to the configured decimal places.*

**Validates: Requirements 7.3**

### Property 29: Gross Weight Zero-Basis Allocation

*For a line with basis 0 and at least one line with positive basis, that line's allocation SHALL be 0 kg.*

**Validates: Requirements 7.4**

### Property 30: Gross Weight All-Zero Basis Rejected

*If all basis values are 0, the allocation function SHALL return a NeedsReview result.*

**Validates: Requirements 7.5**

### Property 31: Gross Weight Order Preservation

*If lines are swapped, their allocated weights SHALL also be swapped in the result.*

**Validates: Requirements 7.7**

### Property 32: Gross Weight Empty List Rejected

*If the input line list is empty, the allocation function SHALL return a NeedsReview result.*

**Validates: Requirements 7.9**

### Property 33: Entry Number Format

*For any valid filer code and entry number, the formatted entry number string SHALL match `^[A-Z0-9]{3}-\d{7}-\d$`.*

**Validates: Requirements 8.7**

### Property 34: Check Digit Single Digit Output

*For any valid filer code and entry number, the computed check digit SHALL be a single character from 0–9.*

**Validates: Requirements 8.2**

### Property 35: Check Digit Sensitivity

*For any valid filer code and entry number, changing any single digit of the entry number SHALL change the computed check digit.*

**Validates: Requirements 8.8**

### Property 36: Check Digit Validation Mismatch

*For any valid filer code and entry number with a provided check digit, if the provided digit differs from the computed digit, the validation function SHALL return NeedsReview.*

**Validates: Requirements 8.9**

### Property 37: MID Length

*For any valid inputs (country, name, street, city), every generated MID SHALL have length ≤ 15 characters.*

**Validates: Requirements 9.15**

### Property 38: MID Character Set

*For any valid inputs, every generated MID SHALL match the regex `^[A-Z0-9]+$`.*

**Validates: Requirements 9.16**

### Property 39: MID Punctuation Insensitivity

*For any manufacturer name, adding or removing punctuation (commas, periods, apostrophes, ampersands) SHALL not change the generated MID.*

**Validates: Requirements 9.3, 9.17**

### Property 40: MID Article Insensitivity

*For any manufacturer name, adding or removing articles (a, an, and, of, the) SHALL not change the generated MID.*

**Validates: Requirements 9.2**

### Property 41: MID Case Insensitivity

*For any inputs, the generated MID is identical regardless of the case of the input strings.*

**Validates: Requirements 9.18**

### Property 42: MID Canadian Province Required

*For country "CA" without a province code, the MID function SHALL return a NeedsReview result.*

**Validates: Requirements 9.19**

### Property 43: MID Missing Street Number

*For any address with no numeric component, the MID SHALL omit the street number segment and continue building the remaining segments.*

**Validates: Requirements 9.20**

### Property 44: MID Insufficient Name Words

*For any manufacturer name yielding fewer than two qualifying words after normalization, the MID function SHALL use the available words and continue building the remaining segments.*

**Validates: Requirements 9.21**

### Property 45: Date Format Validation

*For any string matching `MM/DD/YYYY` or `M/D/YYYY` representing a valid calendar date with year in [1900, 2999], the format function SHALL return OkResult formatted as zero-padded MM/DD/YYYY.*

**Validates: Requirements 10.1**

### Property 46: Date Invalid Dates Rejected

*For any impossible calendar date (e.g., 02/30/2026) or year outside [1900, 2999], the format function SHALL return a NeedsReview result.*

**Validates: Requirements 10.2**

### Property 47: Date Format Unrecognized

*For any string not matching `MM/DD/YYYY` or `M/D/YYYY`, or an empty string, the format function SHALL return a NeedsReview result.*

**Validates: Requirements 10.3**

### Property 48: Date Round-Trip

*For any valid date string, formatting then parsing SHALL return the same calendar year, month, and day.*

**Validates: Requirements 10.6**

### Property 49: Date Ordering — IT Before Import

*For any import date and IT date where the IT date is earlier than the import date, the ordering validation function SHALL return a NeedsReview result.*

**Validates: Requirements 10.4**

### Property 50: Date Ordering — Export After Import

*For any import date and export date where the export date is later than the import date, the ordering validation function SHALL return a NeedsReview result.*

**Validates: Requirements 10.5**

### Property 51: Line Numbering Sequential

*For any non-empty list of line items not exceeding maxLineNumber, the numbering function SHALL assign sequential numbers 001–N with no gaps.*

**Validates: Requirements 11.1, 11.3**

### Property 52: Line Numbering Order Preservation

*For any list of line items, the numbering operation SHALL preserve the relative order of items as supplied.*

**Validates: Requirements 11.4**

### Property 53: Line Numbering Empty List

*For an empty list of line items, the numbering function SHALL return an empty list.*

**Validates: Requirements 11.2**

### Property 54: Line Numbering Exceeds Max

*If the line count exceeds maxLineNumber (default 999), the numbering function SHALL return a NeedsReview result.*

**Validates: Requirements 11.5**

---

## Error Handling

### Result Type Pattern

All rule functions return `RuleResult<T>`:

```typescript
function ruleFunction(...): RuleResult<T> {
  // Business-logic impossibility → return NeedsReview
  if (!dataAvailable) {
    return { ok: false, reason: "Explanation for human" };
  }
  
  // Type or precondition violation → throw Error
  if (typeof cents !== "number" || cents % 1 !== 0) {
    throw new Error(`Expected integer cents, got ${cents}`);
  }
  
  // Computation succeeds → return OkResult
  return { ok: true, value: computedResult };
}
```

### NeedsReview vs. Exception

| Scenario | Response | Rationale |
|----------|----------|-----------|
| Rate unspecified; cannot compute duty | NeedsReview | Business rule: user must provide rate |
| Rounding mode invalid (e.g., "wiggle") | NeedsReview or throw | If from config, throw (programmer error); if from caller, NeedsReview |
| Cents is string, not number | throw Error | Type violation; fail fast |
| Negative entered value | NeedsReview | Business rule: entered values must be non-negative |
| Date is invalid calendar date | NeedsReview | Business rule: only valid dates allowed |

### Configuration Validation

At module load time, `config.ts` is validated:

```typescript
// In config.ts
export function validateConfig(): void {
  const allowed = ["halfUp", "halfDown", "halfEven", "truncate"];
  if (!allowed.includes(chargesRounding)) {
    throw new Error(`Invalid chargesRounding: ${chargesRounding}`);
  }
  if (maxLineNumber < 1 || maxLineNumber > 999) {
    throw new Error(`maxLineNumber must be in [1, 999]`);
  }
  // ... other validations
}

// Call at module load
validateConfig();
```

---

## Testing Strategy

### Test Philosophy

- **Unit Tests** (example-based): Specific inputs, concrete expected outputs. Cover edge cases (empty, zero, boundary values) and mandatory examples.
- **Property-Based Tests** (using fast-check): Universal properties across generated inputs. Discover edge cases the author didn't think of.
- Both complement each other; neither alone is sufficient.

### Mandatory Example Tests

**P13 (Check Digit)** — File: `src/rules/tests/checkDigit.test.ts`
Three examples from CBP specification:
1. Filer B76, Entry 0324527 → Check digit 8
2. Filer RO7, Entry 1010035 → Check digit 3 (O is letter O)
3. Filer R07, Entry 1010035 → Check digit 6 (0 is digit zero)

**P14 (Manufacturer ID)** — File: `src/rules/tests/manufacturerId.test.ts`
Four examples from CBP specification:
1. FR, "LA VIE DE FRANCE", "243 Rue de la Payees", "Bremond" → FRLAVIE243BRE
2. AU, "CARDUCCIO AND JONES", "88 Canberra Avenue", "Sidney" → AUCARJON88SID
3. JP, "N. MINAMI & CO., LTD.", "2-6, 8-Chome Isogami-Dori", "Kobe" → JPMINCO26KOB
4. CA/ON, "HURON LANDMARK", "1840 Huron Road", "Windsor" → XOHURLAN1840WIN

### Property-Based Test Structure

Each property test file (e.g., `rounding.property.test.ts`) follows this pattern:

```typescript
import { fc } from "fast-check";
import { describe, it, expect } from "vitest";
import { roundEnteredValue } from "../rounding";

describe("P4 Rounding — Correctness Properties", () => {
  // Property 1: Half-up rounding at 50 cents
  it("Property 1: Rounding Half-Up Rounds 50 Cents Up", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0 }), (cents) => {
        if (cents === 50) {
          const result = roundEnteredValue(cents);
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value).toBe(1);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  // Property 2: Rounding bounds difference
  it("Property 2: Rounding Bounds Difference", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (cents) => {
        const result = roundEnteredValue(cents);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const difference = Math.abs(result.value - cents / 100);
          expect(difference).toBeLessThanOrEqual(0.50);
        }
      }),
      { numRuns: 100 }
    );
  });

  // ... additional properties
});
```

### Test Configuration

**vitest.config.ts**:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.property.test.ts"],
    globals: true
  }
});
```

**Property Test Generators** (via fast-check):
- `fc.integer()`: Random integers for cents, counts, basis values
- `fc.float()`: Decimal weights
- `fc.string()`: Names, addresses, date strings
- `fc.tuple()`: Multiple inputs for complex functions
- `fc.array()`: Line lists, basis arrays

**Test Naming Convention**:
- File: `{module}.property.test.ts`
- Test: `Property N: {Title}` (matching design document)
- Comment: `**Feature: entry-math, Property N: {property_text}**`

### Dual Block 39 Mode Testing

Every total-entered-value test runs twice:
```typescript
["sumOfRoundedLines", "roundSumOfExactLines"].forEach((mode) => {
  it(`Property 4 (${mode}): Total equals sum of individually rounded`, () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0 })), (linesCents) => {
        const result = totalEnteredValue(linesCents, mode as any);
        // ... assertions
      }),
      { numRuns: 100 }
    );
  });
});
```

### Edge Case Coverage

- Empty inputs (empty name, empty line list)
- Zero values (zero basis, zero cents, zero duty)
- Boundary values (exactly 50 cents, 999 lines, year 2999)
- Maximum values (16 digits PPM, 67086 cents)
- Negative inputs (where applicable, should return NeedsReview)
- Unusual but valid strings (names with only articles, dates with extra spaces)

---

## Configuration and Extensibility

### Configuration Module (config.ts)

The `src/rules/config.ts` file is the single source of truth for all rates, limits, rounding modes, and unconfirmed-rule settings:

```typescript
// Rounding modes
export type RoundingMode = "halfUp" | "halfDown" | "halfEven" | "truncate";

export const config = {
  // P5: Total entered value mode
  totalEnteredValueMode: "sumOfRoundedLines" as const,
  
  // P6: Charges rounding
  chargesRounding: "halfUp" as RoundingMode,
  
  // P7: Duty computation
  dutyBase: "roundedEnteredValue" as "roundedEnteredValue" | "exactEnteredValue",
  dutyCentsRounding: "halfUp" as RoundingMode,
  
  // P8: MPF configuration (fiscal year 2027)
  mpf: {
    rate: 3464,           // PPM (0.3464%)
    minimumCents: 3458,   // $34.58
    maximumCents: 67086,  // $670.86
    effectiveDate: "2026-10-01"
  },
  mpfCentsRounding: "halfUp" as RoundingMode,
  
  // P11: Gross weight
  grossWeightDecimals: 0, // 0–6 decimal places
  
  // P18: Line numbering
  maxLineNumber: 999
};

export function validateConfig(): void {
  const allowedModes: RoundingMode[] = ["halfUp", "halfDown", "halfEven", "truncate"];
  if (!allowedModes.includes(config.chargesRounding)) {
    throw new Error(`Invalid chargesRounding: ${config.chargesRounding}`);
  }
  // ... validate other fields
}
```

### Adding New Rules

To add a new rule (e.g., P2 — not yet implemented):
1. Create `src/rules/p2.ts` with public function(s)
2. Define `RuleResult<T>` return type
3. Add property-based tests in `src/rules/tests/p2.property.test.ts`
4. Re-export from `src/rules/index.ts`
5. Add any configuration to `config.ts` if needed

**No existing rule logic is modified.**

### Updating for Fiscal Year

To update MPF for fiscal year 2028:
1. Edit `src/rules/config.ts`: change `mpf.rate`, `mpf.minimumCents`, `mpf.maximumCents`, `mpf.effectiveDate`
2. Run test suite
3. No rule functions are edited

### Changing Rounding Strategy

To change the default rounding mode for all duties:
1. Edit `src/rules/config.ts`: change `dutyCentsRounding`
2. Re-run tests
3. All duty computations automatically use the new mode

---

## Type Safety

### Integer Cents Representation

All currency inside `src/rules/` is stored as integer cents to eliminate floating-point errors:

```typescript
// Correct
const dutyInCents: number = 15750; // $157.50

// Never
const dutyInDollars: number = 157.50; // ❌ floating-point error risk
```

**Conversion**:
- Cents to dollars: `cents / 100` (used only for display or final output)
- Dollars to cents: `Math.round(dollars * 100)` (used only for input)
- Percent to PPM: `percent * 10000` (e.g., 3.464% = 34640 ppm)
- PPM to percent: `ppm / 10000`

### Rounding Mode Type Safety

```typescript
type RoundingMode = "halfUp" | "halfDown" | "halfEven" | "truncate";

function roundCents(cents: number, mode: RoundingMode): number {
  // TypeScript prevents invalid modes at compile time
  // Runtime validation in config.ts catches invalid config values
}
```

### Strict TypeScript

`tsconfig.json` enforces:
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noImplicitThis": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictPropertyInitialization": true,
    "noImplicitReturns": true
  }
}
```

---

## Data Models

### Line Item Structure

Lines are not stored in the calculator; callers provide raw data and receive computed values:

```typescript
// Input (partial line data)
interface LineInput {
  exactValueCents: number;
  chargesCents: number;
  htsRate: string;
  grossWeightBasis: number;
}

// Computed results
interface LineComputed {
  enteredValue: number;          // P4
  charges: string;                // P6
  duty: number;                   // P7
  grossWeightKg: number;          // P11
  lineNumber: string;             // P18
}
```

### Result Wrapper

```typescript
type RuleResult<T> = 
  | { ok: true; value: T }
  | { ok: false; reason: string };

// Usage
const result = computeDuty("16.5%", 100_000);
if (result.ok) {
  console.log(`Duty: ${result.value / 100}%`);
} else {
  console.log(`Cannot compute: ${result.reason}`);
}
```

---

## Design Decisions and Rationale

1. **Pure Functions**: No I/O or state ensures determinism, testability, and composability. Rules can be sequenced without hidden dependencies.

2. **Result Types**: `RuleResult<T>` makes business-logic impossibilities (NeedsReview) a first-class concept, avoiding exceptions for expected conditions and null-checks.

3. **Integer Cents**: Eliminates floating-point arithmetic errors that plague currency calculations.

4. **Largest Remainder Weighting**: Guarantees exact sum (no rounding loss) and fair allocation (largest fractional parts awarded first).

5. **Configuration Centralization**: All rates, limits, and unconfirmed choices in `config.ts` means fiscal-year updates and rule changes are single-location edits with full test coverage.

6. **Dual Block 39 Modes**: Supporting both `sumOfRoundedLines` and `roundSumOfExactLines` tests a specific CBP ambiguity and helps stakeholders decide which is correct.

7. **Property-Based Testing**: For algorithms like check digit, MID construction, and weight allocation, PBT discovers edge cases and verifies universal properties that example tests miss.

8. **Mandatory Examples**: CBP provides worked examples for P13 and P14; hard-coding them as test cases ensures the implementation matches CBP's own computation.

---

## Summary

The Entry Math Calculator provides a complete, tested, and extensible collection of pure functions for CBP Form 7501 arithmetic and validation. By centralizing configuration, using result types to prevent silent failures, and combining property-based and example-based testing, the design ensures correctness, maintainability, and future-proofing for fiscal-year updates and rule clarifications.
