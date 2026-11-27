# Stitched Entry Draft

A line-by-line **draft of CBP Form 7501** (Entry Summary), stitched from the shipping documents a
small U.S. customs brokerage receives: a commercial invoice, a packing list and a bill of lading,
as a text PDF, a scan, a phone photo or an Excel sheet.

Every value on the draft is tied to the words it came from. Totals and fees come from small rules
checked by property-based tests. Anything uncertain is left blank and handed to the Entry Writer
with a reason. It never chooses a tariff classification or an exchange rate.

**Live demo:** https://stitched-entry-draft.netlify.app (no sign-up, no login)

> This is a draft for review by a licensed customs broker. Every screen and CSV is marked
> "DRAFT, NOT FOR FILING". It does not connect to CBP systems.

## Try it in two minutes

The page opens on an invented sample shipment (every page is marked DEMO / FICTITIOUS).

1. **Click any value** on the right. A stitched thread runs to the exact words on the document page
   on the left. A computed value gets gold threads to the values it was computed from.
2. **Read the Needs review list.** Each item says why it waits: a mismatch between documents, a
   reading whose quote is not on the page, a tariff number that is not in the schedule, a
   Chapter 99 footnote, a value read from an image.
3. **Fill a gap.** Type the entered value of line 004 and watch the duty, the totals and the review
   list update. "Use test answers for this demo" fills every gap with test answers;
   "Clear person answers" removes them.
4. **Download CSV**: one row per field with its status, rule, sources and inputs.
5. **Upload documents** (optional, uses the AI reader). Pick up to three files and their kinds,
   then "Read documents". Invented files to try are in
   [`samples/upload-test/files/`](samples/upload-test/files/).
6. **Exchange rate** (an uploaded invoice in another currency). An "Exchange rate (USD per 1 …)"
   box appears above the line items. Enter the rate, its date and where it came from; Column 36A,
   the duties and the totals are then computed from it, and the rate shows as a value entered by a
   person. Customs accepts only a proclaimed or certified rate (19 CFR 159.31), so the app never
   chooses, suggests or looks up a rate. To see it, upload the invented euro bundle
   `samples/upload-test/files/duskhaven-*` (invoice, packing list, bill of lading); reading it uses
   one of the day's real AI reads.

**AI reading limits on the public site.** Each read is one paid AI call, so the reader runs inside
fixed caps: 3 reads per visitor per day, 30 per day for the whole site, 500 in total, plus a cost
cap and a per-call cost limit. The upload panel shows how many reads are left today. When a cap is
reached, the reader turns off and the sample keeps working. Uploaded files are not stored (the
usage log keeps only their SHA-256 fingerprints, token counts and cost), but their page text and
page images are sent to the AI model, so **do not upload real or confidential documents**. The
per-visitor count keeps only a salted, per-day hash of the connecting address.

## How it works

```
documents ──► page text and page images (in the browser: pdf.js, Excel cells, photos)
          ──► AI reader (one server file, structured JSON, no retries)   ← only for uploads
          ──► quote check: the quote must appear exactly once on the cited page,
              and the value must sit inside the quote; otherwise the reading is rejected
          ──► buildDraft (src/core): cross-document checks, 7501 lines, totals
          ──► rules (src/rules): pure functions, integer cents, property-based tests
          ──► board (threads to sources) and CSV
```

- **Tariff numbers are checked, never chosen.** The HTS number printed on the invoice is looked up
  in a subset of the 2026 HTS Revision 23 that ships with the app.
- **Values read from images always wait for a person** ("Confirm this value"), because there is no
  text layer to check the quote against.
- The same `buildDraft` and `draftToCsv` run in the browser and on the command line, so the CSV
  from the screen and the CSV from `npm run draft` are the same file.
- The AI reader is Claude Haiku 5.5. It is separate from the models Kiro used to write the code
  (see below).

## How we used Kiro (a tour of `/.kiro`)

Kiro wrote the application files; [How this code was made](#how-this-code-was-made) says who did
what. The journal of the Kiro work, one row per task (a request and its follow-ups) with what we
asked, what changed, credits, what went well and what did not, is in
[`docs/kiro-journal.md`](docs/kiro-journal.md). A longer write-up with tables and commit numbers is
in [`docs/kiro-usage.md`](docs/kiro-usage.md).

| Where | What it is |
|---|---|
| [`.kiro/specs/entry-math/`](.kiro/specs/entry-math/) | Spec for the 7501 math: requirements, design with correctness properties, tasks. |
| [`.kiro/specs/document-intake/`](.kiro/specs/document-intake/) | Spec for the upload path and the AI reader boundary, grown requirement by requirement after each real read and each outside review. |
| [`.kiro/steering/`](.kiro/steering/) | Product, tech, structure and pipeline rules (always included), CBP Form 7501 rules with page numbers (for `src/rules/**`), demo data rules (for `samples/**`), and eight ways a property test here once passed without testing anything (for `**/*.property.test.ts`). |
| [`.kiro/hooks/demo-data-check.json`](.kiro/hooks/demo-data-check.json) | Agent hook on file save under `samples/`: checks that names are invented, pages are marked DEMO / FICTITIOUS, mail uses example.com, phones use 555-01xx, and HTS numbers exist. |
| [`.kiro/hooks/turn-check.json`](.kiro/hooks/turn-check.json) | Stop hook: after each agent turn, [`scripts/kiro-turn-check.mjs`](scripts/kiro-turn-check.mjs) type-checks the project and runs the Vitest tests related to the changed files under `src/`, with no AI key in reach. A failure goes back to the agent for one more turn, at most twice per session. |
| [`.kiro/agents/`](.kiro/agents/) | Three custom agents for the Kiro CLI. `app-builder` and `rules-builder` write, with file tools only and write paths limited per agent. `entry-reviewer` only reads: it reviews a change against the specs, steering and tests, its rules let it call `lookup_hts` without asking, and it may not read `.env` files. |
| [`.kiro/settings/mcp.json`](.kiro/settings/mcp.json) | The `hts-lookup` MCP server ([`tools/hts-mcp/server.ts`](tools/hts-mcp/server.ts)) that answers tariff lookups from the shipped HTS subset. |
| [`tools/kiro-power/cbp-7501-entry/`](tools/kiro-power/cbp-7501-entry/) | A Kiro power in the Agent Plugins format: three skills (check a printed HTS number, turn a defect into a spec requirement and a test that fails first, review a property test) and the `hts-lookup` server. We installed it with `kiro-cli powers install` and `entry-reviewer` loaded its skill. Its copy of the MCP server does not start from the install folder (the path in its `mcp.json` is relative), so the workspace server answered. |
| `*.property.test.ts` and other tests | Property-based tests with fast-check. Each property names the requirement it validates. |

Counted on 2026-11-26: 2 specs with 79 requirements and 142 correctness properties in their
designs, 7 steering files, 2 hooks, 3 custom agents, 1 MCP server, 1 power, 72 test files that
`npm test` runs, with 164 `fc.assert` properties.

## Run it yourself

Requirements: Node.js 20 or newer, npm.

```bash
npm ci
npm run dev          # http://localhost:3000, the sample works without any key
npm test             # unit and property-based tests (no network, no AI)
npm run typecheck
npm run draft -- lantern-hollow out   # the same draft and CSV from the command line (bundle name under samples/)
```

The AI reader is off unless you turn it on. Server-side settings (for example in `.env.local`,
which git ignores):

| Variable | Meaning |
|---|---|
| `DOCUMENT_INTAKE_MODE=fake` | Recorded answers for the files in `samples/upload-test/files/`, no AI call. The screen says "Test mode: recorded answers, no AI call." |
| `DOCUMENT_INTAKE_ANTHROPIC_KEY` | Your Anthropic API key. The reader uses only this variable. |
| `DOCUMENT_INTAKE_STORE=file` | Where usage caps are counted (`file` writes to `logs/`; the public site uses `netlify-blobs`). The reader stays off without a store. |
| `DOCUMENT_INTAKE_VISITOR_SALT` | Salt for the per-visitor count. |
| `DOCUMENT_INTAKE_TOTAL_CAP`, `DOCUMENT_INTAKE_DAILY_CAP`, `DOCUMENT_INTAKE_VISITOR_DAILY_CAP`, `DOCUMENT_INTAKE_COST_CAP_KRW` | Override the caps in [`src/core/intakeConfig.ts`](src/core/intakeConfig.ts). |
| `DOCUMENT_INTAKE_KILL_SWITCH` | Any value turns the reader off. |

## Project layout

```
.kiro/        specs, steering, hooks, custom agents, MCP settings
src/rules/    pure 7501 rules (rounding, totals, duty, MPF, weights) and their property tests
src/core/     reading check, HTS lookup, parsers, buildDraft, exchange rate, CSV, PDF and sheet text
src/server/   the AI reader, usage caps and the cost ledger
src/app/      Next.js board, upload panel, /api/read and /api/reader-status
data/         HTS 2026 Rev. 23 subset, CBP port code tables, country codes
samples/      invented documents, recorded reader answers, sample layout
scripts/      command-line draft, sample builder, PDF worker copy, the Stop hook's turn check
tools/        hts-lookup MCP server, the cbp-7501-entry Kiro power
docs/         Kiro journal and the longer Kiro write-up
```

## Known limits

- It does not choose HTS numbers. Numbers outside the shipped subset go to Needs review.
- The HTS table is a 33-row subset for the sample documents, not the full schedule.
- Up to 3 documents per upload, at most 4 pages in each PDF and 6 image pages in all, and up to 8
  invoice lines.
- A packing-list quantity with a unit word, such as `120 DZ`, is not compared with the invoice; the
  line waits for a person, and the message calls it not fully read.
- Exchange rate: one currency per invoice and one rate for all its lines. Amounts with a decimal
  comma are read only as `1.234,56` or `234,56`; other number forms wait for a person. The rate is
  not saved and must be entered again after a new upload.
- Two rule groups of the `entry-math` spec are not built: the entry number check digit (Block 1)
  and the date rules.
- We have not measured time saved with working entry writers.

## How this code was made

This repository was written from scratch for the Kiroween 2026 hackathon. Its first commit is
dated 2026-11-17, after the submission period opened on 2026-10-30, and every file in it was added
in this history. No code was brought in from earlier projects. The outside material is the
frameworks and libraries in [`package.json`](package.json), the public data files listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), and the CBP Form 7501 instructions and 19 CFR
sections that the steering files and specs cite by page and section.

One person directed the work with two AI tools, Kiro and Claude Code:

- **Kiro wrote the application files.** The repository had 146 commits by 2026-11-26; the commits
  after that date change only documentation. Each of the 67 commits that change
  code under `src/`, `scripts/` or `tools/` names the Kiro run that wrote it: 60 in the commit
  message, 7 only in the matching row of `docs/kiro-journal.md`. The runs used the Kiro IDE spec flow
  and two CLI custom agents, `app-builder` and `rules-builder`; a third, read-only agent,
  `entry-reviewer`, reviewed one change, once on Claude Haiku 4.5 and once on Claude Opus 5.5. Kiro's
  spec mode also wrote the spec files. Across the journal, Kiro ran on Claude Haiku 4.5 in 133 of the
  140 rows and on Claude Opus 5.5 in 2 (one review, one test rewrite); of the other 5 rows, 2 used
  Kiro's Auto model, 2 record no model and 1 records the five steering files we wrote by hand.
- **What Kiro designed itself:** the first spec, `entry-math` (from a short request and the
  steering files, it wrote 14 requirements, a design with 54 correctness properties and a task list
  of 16 tasks with 34 sub-tasks, then the project skeleton and the first rule modules with their tests); the first
  draft of the second spec, `document-intake`, which we corrected in a 13-point review; and the
  prompt of the demo-data hook, revised twice on our instructions; and the rewrite of the tests of
  Requirement 65 after the Opus review, from the review and the spec alone. Where a request gave only the
  spec, Kiro also chose the implementation; for the port code tables, the tests caught seven
  places where its first version went wrong.
- **What Claude Code did.** It planned the other changes and wrote the requests that Kiro carried
  out. The first requests named the files, functions, algorithms and expected values, after the
  approach had been tried in a throwaway prototype (made on 2026-11-17, not in this repository). Later requests
  gave new files in full and edits as line numbers with the current and the new text, and later
  requirements came as text in those requests, which Kiro's spec mode added to the spec. Some
  tests were written by Kiro from the spec; others were written by Claude Code and placed by Kiro
  word for word. Claude Code ran the tests, type checks, builds and screen checks that decided
  whether a task was done, and made every commit, which is why each commit carries a
  `Co-Authored-By: Claude` line.
- **Written outside Kiro:** the first five steering files, the first two custom agent files, the
  sample documents and the data files (the custom agents cannot write to `samples/` or `data/`), and
  `docs/kiro-journal.md` (25 commits change only the journal). Reviews by Claude and by a second
  AI coding tool (agy) found problems that became new `document-intake` requirements before any
  code changed.

## Data and notices

- U.S. Harmonized Tariff Schedule, 2026 Revision 23 (USITC), a subset in `data/hts/`: U.S.
  government work.
- CBP port code tables (Schedule D and Schedule K) in `data/codes/`: U.S. government work published
  by U.S. Customs and Border Protection.
- Country names in `data/codes/iso-3166-1.json` come from Unicode CLDR 48.0. See
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- Every company, person, address and number in `samples/` and `public/samples/` is invented.

## License

[MIT](LICENSE) for the code in this repository. Third-party data keeps its own terms, listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
