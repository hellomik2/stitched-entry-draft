# Recorded real reads (SAMPLE / FICTIONAL documents)

`test-bundle-c.json` is the body that the app's `/api/read` returned on 2026-11-24 for one real call of the AI reader (`claude-haiku-5-5`) on test bundle C, three invented documents made for testing outside this repository:

| Document id | Shape | What is printed |
|---|---|---|
| `invoice` | phone photo (JPEG) | commercial invoice of "Wispwood Lantern Works Co., Ltd." to "Gloamfield Mercantile LLC", 4 item lines, no subtotal or total |
| `packingList` | dark phone photo (PNG) | packing list with 3 item lines and a handwritten note |
| `billOfLading` | text PDF | bill of lading, carrier "Cinderbuoy Lines (SAMPLE)" |

Every company, address, vessel, container and number is invented and every page carries `SAMPLE / FICTIONAL`. Only the answer is kept here, not the documents. The reader read all 77 values right, but its transcripts of the two photos have 6 and 5 lines, so 58 of its quotes are not in its own transcripts. Tests use the two image documents of this answer (Requirement 50, `src/core/reading.notInTranscript.test.ts` and `src/core/draft.notInTranscript.test.ts`).

The file is the response body as it came (`ok`, `mode`, `output`, `remaining`); nothing was changed.
