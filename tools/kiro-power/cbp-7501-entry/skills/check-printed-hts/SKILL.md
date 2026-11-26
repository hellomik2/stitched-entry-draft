---
name: check-printed-hts
description: Check that an HTS number printed on an invoice, packing list or test fixture exists in the shipped 2026 HTS subset, without proposing a number.
---

# Check a printed HTS number

The app never chooses a tariff number. It only checks that the number a document prints exists in
the shipped revision (2026 HTS, Revision 23, subset in `data/hts/2026HTSRev23-subset.json`).

## Steps

1. Quote the number exactly as it is printed, with its file and line (or JSON path).
2. Call the `lookup_hts` tool with that text as `number`. It accepts the entry form
   (`6913.90.5000`) and the schedule form (`6913.90.50.00`). The tool comes from the `hts-lookup`
   server of this repository (`tools/hts-mcp/server.ts`), started from the workspace folder.
3. Report what the tool returned and nothing more: `found` true or false, the description, the
   general rate and `rateFrom` (the row the rate was inherited from), the unit, and the Chapter 99
   footnotes; or the `reason` when it was not found.
4. If the tool is missing or the call is rejected, do not call it again. Read
   `data/hts/2026HTSRev23-subset.json` with the file read tool instead (it stores the schedule
   form) and say that you did.
5. A number that is not found and is listed in the "Deliberate problems" table of
   `samples/<bundle>/README.md` is reported as "deliberate, listed in README".

## Never

- Never suggest a different or "correct" number, a classification, or a rate the tool did not
  return.
- Never edit files under `data/` or `samples/`.
