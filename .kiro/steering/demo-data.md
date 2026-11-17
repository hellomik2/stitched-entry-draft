---
inclusion: fileMatch
fileMatchPattern: "samples/**"
---

# Demo data rules (fictitious documents only)

Everything under `samples/` is invented for demonstration. It must never look like a real
business document of a real company.

## Must

- Invent every company, person, and address. Use clearly playful, seasonal names that do not
  resemble real firms, for example "Lantern Hollow Trading Co." or "Moonlit Bramble
  Textiles". Before using a name, make sure it is not an existing brand you know of.
- Put `DEMO / FICTITIOUS` visibly on every page or sheet.
- Email and web addresses use `example.com`, `example.org`, or `example.net` only.
- Phone numbers use the fictional 555-01xx range, for example `+1 555-0142`.
- Any identifier field that a real document would carry (tax ID, bond number, importer
  number, EIN, SSN) is either left out or filled with an obviously fake value such as
  `DEMO-0000`.
- HTS numbers must exist in the HTS revision we ship with, and the sample must record which
  revision was used. Avoid goods whose classification is commonly disputed (for example
  apparel sets).
- Each demo bundle states, in a README next to it, which deliberate problems it contains so
  tests and the demo can point to them.

## Must not

- No real company names, logos, trademarks, or real people.
- No strings that look like real tax identifiers: no `NN-NNNNNNN` (EIN shape), no
  `NNN-NN-NNNN` (SSN shape), no real-looking bond or importer numbers.
- No real shipment data, no customer documents, no copied invoices from the internet.

## Deliberate problems a demo bundle should include

1. One line where invoice quantity and packing list quantity differ.
2. One invoice line where amount is not quantity times unit price.
3. One HTS number that is not in the tariff schedule.
4. One line with an empty country of origin.
5. One HTS number whose tariff footnote points to Chapter 99 additional duties.
