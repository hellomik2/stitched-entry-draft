# Demo bundle: lantern-hollow (DEMO / FICTITIOUS)

Everything here is invented: companies, people, addresses, B/L and container numbers. The
`Importer No.` and `Seal No.` fields carry the obvious fake value `DEMO-0000`. E-mail uses
`example.com`, the phone number uses the fictional 555-01xx range.

Files:

- `bundle.json`: the three documents of the bundle (commercial invoice, packing list, bill of lading).
- `layout.json`: every text run and rule line of the three PDFs with its position (PDF points,
  origin bottom-left, y is the baseline, standard Helvetica fonts). `npm run samples` draws the
  PDFs into `public/samples/lantern-hollow/` from this file.
- `reading.json`: the frozen reader answer (what the AI reader would return) for this bundle:
  135 field readings, each with value, quote, document and page.
- `overrides-demo.json`: test answers a person might type in the review screen. Used by tests and
  the "Use test answers for this demo" button. Not real decisions.

HTS numbers were checked against `2026HTSRev23` (2026 HTS Revision 23, current from 2026-11-10)
with `https://hts.usitc.gov/reststop/search?keyword=<number>` on 2026-11-17.

## Deliberate problems

| # | Where | What | Expected result |
|---|---|---|---|
| 1 | Invoice line 3 (LH-103) vs packing list | Invoice 240 PCS, packing list 216 PCS | `L003.35` needs review (P3) |
| 2 | Invoice line 4 (LH-104) | 150 x 3.20 = 480.00 but the amount says 468.00 | `L004.36A` needs review (P1), totals wait |
| 3 | Invoice line 6 (LH-106) | HTS `7013.99.9500` is not in the schedule | `L006.33A` needs review (P15) |
| 4 | Invoice line 7 (LH-107) | Origin cell is empty | `L007.10` needs review (P20) |
| 5 | Invoice line 5 (LH-105) | HTS `9505.90.6000` has footnote "See 9903.90.08." | `L005.ch99` needs review |
| 6 | `reading.json` | The reader "fills" line 7 origin with `CN` and cites a row text that is not on the page | reading rejected (`quote_not_found`) |

Also on purpose: invoice lines 1 and 8 share HTS `6913.90.5000` and origin PT, so they become one
7501 line (001); `3926.40.0090` has no rate on its 10-digit row, so the rate comes from its parent
`3926.40.00` (P16).
