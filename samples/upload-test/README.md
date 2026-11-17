# Upload test bundle (DEMO / FICTITIOUS)

Three invented shipping documents for testing the upload path (spec `document-intake`), one of each shape the reader accepts:

| File | Shape | Document kind to pick | Pages |
|---|---|---|---|
| `files/invoice.pdf` | text PDF (has a text layer) | Commercial invoice | 1 |
| `files/packing-list-photo.jpg` | phone-style photo, 1200 x 1600 px | Packing list | 1 |
| `files/bill-of-lading-scan.pdf` | scanned PDF (image only, no text layer) | Bill of lading | 1 |

Every company, person, address, vessel and number is invented ("Hollowmere Candle Works Co.", "Willowisp Party Supply LLC", "Pumpkin Tide Shipping (DEMO)") and every page carries `DEMO / FICTITIOUS`. The HTS numbers (7013.99.3500, 9405.50.4000, 9505.90.6000) are in `data/hts/2026HTSRev23-subset.json` (2026 HTS Revision 23).

`recordings/upload-test-hollowmere.json` is the fake reader's recorded answer for exactly these three files (matched by the SHA-256 of each file). It uses the document ids `invoice`, `packingList` and `billOfLading`, so pick the kinds above when uploading. The answer was written by hand for testing; no AI model produced it. The transcripts of the two image pages give one line per printed line, with boxes measured on the rendered page.

Deliberate review items:

1. `packingList.lines.3.grossKg` (5.8) is marked `confidence: "low"`, as if the photo were blurred there. It is rejected with `low_confidence`, so it goes to "Needs review" and the gross weight lines cannot be allocated without a person.
2. Invoice line 3 (9505.90.6000) has a Chapter 99 footnote in the tariff table, so the additional duty is a person's input.

The files were made outside Kiro and outside the app code: the PDF invoice with pdf-lib, the photo and the scan by rendering an HTML page in a headless browser (the scan is that image placed on a PDF page).
