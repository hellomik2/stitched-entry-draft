# Entry Draft Helper (working title)

A draft-preparation helper for small U.S. customs brokerage offices.

It reads mismatched commercial invoices and packing lists and prepares a
line-by-line **draft** of CBP Form 7501 (Entry Summary):

- every value on the draft links back to the place in the source document it came from;
- computed fields (rounding, totals, fees, check digits) are produced by small pure
  rules that are verified with property-based tests;
- fields that are uncertain or that need a professional decision are left blank and
  flagged for the Entry Writer instead of being guessed;
- it never chooses an HTS classification. It only checks that the number printed on
  the invoice exists in the public Harmonized Tariff Schedule.

The output is a draft for review by a licensed customs broker. It is not filed with CBP.

## Status

Early development. The project was started in November 2026.

## Development

- TypeScript, Next.js, Vitest, fast-check.
- Built with Kiro (specs, steering, property-based tests). Kiro project files live in `/.kiro`.
- Development notes: `docs/kiro-journal.md`.

## License

To be decided before publishing.
