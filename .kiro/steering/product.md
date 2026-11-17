---
inclusion: always
---

# Product: CBP Form 7501 draft helper

## Who it is for

A small U.S. customs brokerage office. The user is the **Entry Writer**, the person who
types invoice and packing list data into the entry summary. A **licensed customs broker**
reviews and is responsible for what is filed (19 CFR 111.1, "responsible supervision and
control").

## What it does

1. Takes a bundle of shipping documents for one shipment: commercial invoice, packing
   list, bill of lading. They arrive in mixed shapes (text PDF, scan, phone photo, Excel).
2. Reads the fields and builds a line-by-line **draft** of CBP Form 7501 (Entry Summary).
3. **Every value on the draft carries its source**: document, page, and position (or cell
   address), or an explicit "entered by a person" mark. A value with neither is a bug.
4. Computed fields (rounding, totals, fees, check digit, manufacturer ID) come from small
   pure rules in `src/rules/`, verified with property-based tests.
5. Uncertain or conflicting fields are **left blank and flagged** "Needs review" with the
   reason (for example: invoice says 120 PCS, packing list says 108 PCS).
6. Hands off a review package: the draft, a value-to-source table (CSV), the list of
   fields a person must fill, and suggested questions for the importer.

## What it must never do

- **Never choose or suggest an HTS classification.** It copies the number printed on the
  invoice and only checks whether that number exists in the public Harmonized Tariff
  Schedule (and shows which HTS revision it checked against).
- **Never guess.** Low confidence, missing data, or documents that disagree mean the field
  stays empty with a "Needs review" flag. No silent defaults that look like real data.
- **Never file or sign.** No ABI transmission, no signature, no "ready to file" wording.
  Every draft and every export is marked `DRAFT, NOT FOR FILING`.
- Never decide entered value, related-party status, origin or preference eligibility,
  AD/CVD, Chapter 99 duties, or currency conversion. Show candidates and the reason; a
  person decides.
- Never read, store, or display tax identifiers (7501 Blocks 26 and 27, EIN, SSN).
- Never invent numbers that the official sources do not give. If a rate or rounding
  method is not confirmed, it is a configuration value or a person's input, not a constant
  made up in code.

## Tone in the UI

Plain, calm, precise. Say what is known, what is not, and who should decide.
