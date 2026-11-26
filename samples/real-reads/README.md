# Recorded real reads (SAMPLE / FICTIONAL documents)

`test-bundle-c.json` is the body that the app's `/api/read` returned on 2026-11-24 for one real call of the AI reader (`claude-haiku-5-5`) on test bundle C, three invented documents made for testing outside this repository:

| Document id | Shape | What is printed |
|---|---|---|
| `invoice` | phone photo (JPEG) | commercial invoice of "Wispwood Lantern Works Co., Ltd." to "Gloamfield Mercantile LLC", 4 item lines, no subtotal or total |
| `packingList` | dark phone photo (PNG) | packing list with 3 item lines and a handwritten note |
| `billOfLading` | text PDF | bill of lading, carrier "Cinderbuoy Lines (SAMPLE)" |

Every company, address, vessel, container and number is invented and every page carries `SAMPLE / FICTIONAL`. Only the answer is kept here, not the documents. The reader read all 77 values right, but its transcripts of the two photos have 6 and 5 lines, so 58 of its quotes are not in its own transcripts. Tests use the two image documents of this answer (Requirement 50, `src/core/reading.notInTranscript.test.ts` and `src/core/draft.notInTranscript.test.ts`).

The file is the response body as it came (`ok`, `mode`, `output`, `remaining`); nothing was changed.

`test-bundle-a.json` is the body that `/api/read` returned on 2026-11-26 for one real call of the AI reader on test bundle A: an invoice text PDF of "Mothlight Ceramics Atelier, Lda." to "Bramblewick Home Goods LLC" (5 item lines), a scanned packing list (`packingList`) and a phone photo of the bill of lading (`billOfLading`), all invented and marked `SAMPLE / FICTIONAL`. The reader gave 8 of the 16 transcript lines of the scanned packing list no box (`b` null), among them the five item rows and the total row, and wrote the bill of lading gross weight "1284.0" for the printed "1,284.0 KGS". Tests use its two image documents (Requirements 58 and 59: `src/core/reading.lineWithoutBox.test.ts`, `src/core/draft.lineWithoutBox.test.ts`, `src/core/reading.thousands.test.ts`, `src/core/reading.before58.test.ts`). The file is the response body as it came; nothing was changed.
