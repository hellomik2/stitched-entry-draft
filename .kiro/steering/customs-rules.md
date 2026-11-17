---
inclusion: fileMatch
fileMatchPattern: "src/rules/**"
---

# CBP Form 7501 calculation rules (source digest)

Sources:

- **[7501]** CBP Form 7501 (02/26), "CBP Form 7501 Instructions", 27 pages, published at
  cbp.gov (forms page "Form 7501 Entry Summary with Continuation Sheets"). Page numbers below
  are "Page N of 27" in that PDF.
- **[MPF]** CBP Dec. 26-14, Merchandise Processing Fee for fiscal year 2027 (Federal
  Register public inspection document 2026-15530).

Labels: **[confirmed]** the rule is written in the source. **[our reading]** our
interpretation of a confirmed rule. **[unconfirmed]** the source does not say. Unconfirmed
choices must be a setting in `src/rules/config.ts` or a person's input, never a hidden
constant, and the draft must show which setting was used.

All money inside `src/rules/` is integer cents. All results that cannot be computed return
a "needs review" result with a reason instead of a number.

## P4. Entered value, Column 36A (7501 p.17) [confirmed]

"Report the value in whole dollars rounded off to the nearest whole dollar (if the total
entered value for a line item is less than 50 cents report as "0"). Dollar signs are
omitted."

- Exactly 50 cents rounds up (so 0.50 becomes 1). [our reading, consistent with the
  "less than 50 cents" sentence]
- Result: a non-negative whole-dollar integer.
- Properties: `|rounded - exact| <= 0.50`; values under 0.50 give 0; result is an integer.

## P5. Total entered value, Block 39 (7501 p.20) [confirmed]

"Report the total entered value for all line items."

- Whether Block 39 adds the already-rounded line values or rounds the exact sum is
  **[unconfirmed]**. Setting `totalEnteredValueMode`: `"sumOfRoundedLines"` (default) or
  `"roundSumOfExactLines"`. Test both modes.
- Properties for both modes: order of lines does not change the total; adding a line with
  a non-negative value never decreases the total; one line gives that line's rounded value.
- In `"sumOfRoundedLines"` mode the total equals the sum of the P4 results exactly.
  The two modes differ by at most `0.5 * number of lines` dollars.

## P6. Charges, Column 36B (7501 p.18) [confirmed]

Freight, insurance, and other charges from alongside the carrier at the port of export to
alongside the carrier at the first U.S. port. "This value shall be shown in whole numbers
for each HTS number. It is to be placed beneath the entered value and identified with the
letter 'C' (e.g., C550). Dollar signs are omitted."

- Display format: `C` followed by a non-negative integer, no `$`, no separators: `C550`.
- How cents are rounded to whole numbers is **[unconfirmed]**. Setting
  `chargesRounding`, default `"halfUp"` (same as P4).
- Not required for mode of transportation code 60 (passenger, hand-carried). [confirmed]
- Properties: output always matches `^C\d+$`; parsing the output gives back the integer.

## P7. Duty, Column 38 (7501 p.19) [confirmed]

"Record the estimated duty ... calculated by applying the rate times the dutiable value or
quantity."

- Automatic only for two HTS rate shapes: `Free` and a simple ad valorem percent such as
  `4%` or `16.5%`. Any other text (specific, compound, "The duty provided in ...") returns
  needs review. [our rule]
- `Free` gives 0 duty.
- Dutiable value used as the base: the line's entered value (the P4 whole-dollar value).
  **[our reading, unconfirmed]** Setting `dutyBase`: `"roundedEnteredValue"` (default) or
  `"exactEnteredValue"`.
- Rounding of duty to cents is **[unconfirmed]**. Setting `dutyCentsRounding`, default
  `"halfUp"`. Store rates exactly (parts per million: 16.5% = 165000 ppm).
- Properties: Free or 0% gives 0; duty is never negative; higher value never gives lower
  duty (monotonic); higher rate never gives lower duty.

## P8. Merchandise Processing Fee, MPF (7501 p.20, MPF notice) [confirmed]

- Formal entries from 2026-10-01 (fiscal year 2027): ad valorem rate **0.3464%**, minimum
  **$34.58**, maximum **$670.86**. [confirmed, MPF notice]
- "There is no de minimis collection for the MPF." "Report the actual MPF due unless the
  perspective amount due is less than the established minimum (record the minimum), or
  exceeds the established maximum (record the maximum)." [confirmed, 7501 p.20]
- Goods under a Free Trade Agreement may be exempt; the importer must show the SPI per line.
  [confirmed, 7501 p.20] Deciding eligibility is a person's job; the function takes which
  lines are excluded as input.
- Rate, minimum, maximum, effective date, and source live only in `src/rules/config.ts`
  as one dated entry, so a new fiscal year is a config change.
- Cents rounding of the percent result is **[unconfirmed]**. Setting `mpfCentsRounding`,
  default `"halfUp"`.
- Properties: result always within [min, max]; never decreases when the base increases;
  equals the rounded `base * rate` whenever that is inside the range.

## HMF (Harbor Maintenance Fee): not computed

The HMF rate is **[unconfirmed]** in our sources. The app does not compute HMF. HMF is a
person's input or empty. (Known rule for later: if HMF is the only payment due and is $3 or
less it is not collected and Block 43 shows 0. 7501 p.20.)

## P10. Summary totals, Blocks 41 to 44 (7501 p.20 to p.21) [confirmed]

- Block 41 Duty: total estimated duty paid, excluding AD/CVD.
- Block 42 Tax: total estimated tax paid, including deferred amounts except tax deferred
  under 26 U.S.C. 5232(a).
- Block 43 Other: total AD/CVD and other fees actually paid. Bonded AD/CVD is not shown.
- Block 44 Total: "Record the sum of blocks 41, 42, and 43." Do not include I.R. tax
  deferred under 5232(a) or bonded AD/CVD. "If no duty, tax, or other charges apply to the
  transaction, record "0" in this block."
- Our rule: tax and AD/CVD values come from a person. If any input needed for a block is
  unknown (`null`), that block and Block 44 are needs review, not 0.
- Properties: `44 = 41 + 42 + 43` for any known inputs; bonded and 5232(a) deferred
  amounts never change Block 44; line order does not matter.

## P11. Gross weight per line, Column 34A (7501 p.16 to p.17) [confirmed]

"Report gross shipping weight in kilograms." "If the gross weight is not available for each
line item, the approximate shipping weight shall be estimated and reported. The total of the
estimated weights should equal the actual gross shipping weight." Container weight (lift
vans, cargo vans, similar outer containers) is not included.

- Allocation (our rule): split the shipment's gross kg across lines in proportion to a
  given non-negative basis per line (for example net weight or value), in whole kg, using
  the largest remainder method so the parts add up exactly. Mark every allocated value as
  "estimated". Decimal places for kg are **[unconfirmed]**; whole kg is the default.
- Properties: parts always sum exactly to the total; every part is a non-negative integer;
  a line with basis 0 gets 0 (unless every basis is 0, which is needs review); swapping
  two lines swaps their parts.

## P13. Entry number check digit, Block 1 and Appendix 1 (7501 p.5, p.24 to p.25) [confirmed]

- Entry number = 3-character filer code + 7-digit entry number (leading zeros are
  significant) + 1 check digit, displayed `XXX-NNNNNNN-C`.
- Letters become digits: A=1 B=2 C=3 D=4 E=5 F=6 G=7 H=8 I=9, J=1 K=2 L=3 M=4 N=5 O=6
  P=7 Q=8 R=9, S=2 T=3 U=4 V=5 W=6 X=7 Y=8 Z=9.
- Take the 10 digits. Multiply every even position (2nd, 4th, ... counted from the left) by
  2; if a product is greater than 9, add 1 and drop the tens digit (same as digit sum).
  Add those results and the odd-position digits. Check digit = 10 minus the units digit of
  the sum; if the units digit is 0, the check digit is 0.
- **Mandatory examples:**
  - `B76` + `0324527` gives **8** (digits 2 7 6 0 3 2 4 5 2 7, 15 + 17 = 32).
  - The second example is printed as "R07-1010035", but its worked table uses the letter
    **O** (value 6): digits 9 6 7 1 0 1 0 0 3 5, 8 + 19 = 27, check digit **3**.
    So filer code `RO7` (letter O) + `1010035` gives **3**. With a digit zero (`R07`) the
    same formula gives 6. Tests must cover both facts.
- Some filers are authorized to add a "check digit factor" of 1 or 2 (p.25). Out of scope:
  when a check digit does not match, report "mismatch (an authorized check digit factor may
  apply)" instead of calling it wrong.
- Properties: result is a single digit 0 to 9; changing any one digit of the 7-digit
  number changes the check digit; formatting then parsing returns the same parts.

## P14. Manufacturer ID (MID), Block 13 and Appendix 2 (7501 p.9 to p.10, p.26 to p.27) [confirmed]

Up to 15 characters, uppercase, no spaces, built from:

1. **Country**: ISO 2-letter code of the actual country of origin. Canada is not `CA`;
   use the province code: Alberta XA, British Columbia XC, Manitoba XM, New Brunswick XB,
   Newfoundland (Labrador) XW, Northwest Territories XT, Nova Scotia XN, Nunavut XV,
   Ontario XO, Prince Edward Island XP, Quebec XQ, Saskatchewan XS, Yukon Territory XY.
2. **Name**: first three characters of each of the first two "words" of the manufacturer
   name (only one word: its first three characters).
   - Ignore the English words a, an, and, of, the.
   - Ignore punctuation (commas, periods, apostrophes, ampersands).
   - Ignore single-character initials ("S" in "Thomas S. Delvaux Company").
   - Two or more initials together are one word: "A.B.C. Company" and "A B C Company" give
     `ABCCOM`; "O.A.S.I.S. Corp." gives `OASCOR`; "Dr. S.A. Smith" gives `DRSA`;
     "Shavings B L Inc." gives `SHABL`.
   - Hyphenated parts are one word: "Rawles-Aden Corp." and "Rawles - Aden Corp." give
     `RAWCOR`.
   - Numbers count as characters: "20th Century Fox" gives `20TCEN`, "Concept 2000" gives
     `CON200`. "The Embassy of Spain" gives `EMBSPA`. "Amalgamated Plastics Corp." gives
     `AMAPLA`; "Bergstrom" gives `BER`.
   - Generic leading words that do not identify the firm are removed ("PT", "JSC", "OAO",
     "OOO", "ZAO", "Fabrica de Artigos de Vestuario"). Which words are generic is a
     **person's decision**: accept a list of words to drop as input, and flag needs review
     when the name starts with a known generic prefix but no decision was given.
3. **Street number**: the largest number on the street address line, first four digits
   only. "11455 Main Street Suite 9999" gives `1145`; "232 Main Street Suite 1234" gives
   `1234`. Commas or hyphens between digits are removed ("12,34,56 Alaska Road" and
   "12-34-56 Alaska Road" give `1234`). A space separates numbers ("Apt. 509  2727
   Cleveland St." gives `2727`). Spelled-out numbers give nothing ("One Thousand Century
   Plaza" gives no digits; "... Suite 345" gives `345`).
4. **City**: first three letters of the city name; ignore numerals, punctuation, spaces,
   and a leading "The": "Tokyo" `TOK`, "St. Michel" `STM`, "18-Mile High" `MIL`, "The
   Hague" `HAG`. City-states use the country name: Hong Kong `HON`, Singapore `SIN`,
   Macau `MAC`.

**Mandatory examples** (from the Appendix 2 table, p.27):

| Name | Street line | City | Country | MID |
|---|---|---|---|---|
| LA VIE DE FRANCE | 243 Rue de la Payees | Bremond | FR | `FRLAVIE243BRE` |
| CARDUCCIO AND JONES | 88 Canberra Avenue | Sidney | AU | `AUCARJON88SID` |
| N. MINAMI & CO., LTD. | 2-6, 8-Chome Isogami-Dori | Kobe | JP | `JPMINCO26KOB` |
| HURON LANDMARK | 1840 Huron Road | Windsor | CA, province ON | `XOHURLAN1840WIN` |

Additional examples from the same table (the PDF text extraction scrambles some address
lines, so these pairings are our reconstruction; each one is consistent with the rules):

| Name | Street line | City | Country | MID |
|---|---|---|---|---|
| 20TH CENTURY TECHNOLOGIES | 5 Ricardo Munoz, Suite 5880 | Caracas | VE | `VE20TCEN5880CAR` |
| THE E.K. RODGERS COMPANIES | One Hawthorne Lane | London | GB | `GBEKRODLON` |
| THE GREENHOUSE | 45 Royal Crescent | Birmingham | US | `USGRE45BIR` |
| BOCCHACCIO S.P.A. | Visa Mendotti, 61 | Verona | IT | `ITBOCSPA61VER` |
| MURLA-PRAXITELES INC. | (none) | Athens | GR | `GRMURINCATH` |
| SIGMA COY E.X.T | 1640 Delgado | 4000 Smyrna | IT | `ITSIGCOY1640SMY` |
| COMPANHIA TEXTIL KARSTEN (person drops "COMPANHIA TEXTIL") | Calle Grande, 25-27 | Lisbon | PT | `PTKAR2527LIS` |

- Properties: length at most 15; matches `^[A-Z0-9]+$`; starts with the country or
  province code; adding or removing punctuation, extra spaces, or ignored words in the
  name does not change the result; case of the input does not change the result.

## P17. Dates (7501 p.6 to p.11) [confirmed]

- Every date block is MM/DD/YYYY (Blocks 3, 7, 11, 15, 17 and the declaration date).
- Block 17: "Note: IT date cannot be prior to import date." (p.11) [confirmed]
- Export date (Block 15) after import date (Block 11) is flagged for review. [our reading]
- Properties: format then parse returns the same calendar date; invalid dates
  (02/30/2026) are rejected; an IT date earlier than the import date is always flagged.

## P18. Line numbers, Column 31 (7501 p.14) [confirmed]

"Record the appropriate line number, in sequence, beginning with the number 001."

- Three digits, zero padded: 001, 002, ...
- More than 999 lines is **[unconfirmed]** formatting: return needs review.
- Properties: after any insert, delete, or reorder, renumbering gives exactly 001..N with
  no gaps or repeats and keeps the relative order of lines.

## Not in this rule set yet

P1 to P3 (invoice arithmetic and invoice vs packing list), P9 (HMF), P12 (HTS units),
P15 and P16 (HTS lookup and parent rates), P19 and P20 (every value has a source; no
guessing) come in later specs.
