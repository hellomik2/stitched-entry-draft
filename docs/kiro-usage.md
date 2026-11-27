# How we used Kiro

This is the longer Kiro write-up for Stitched Entry Draft. Who did what is in the README section
[How this code was made](../README.md#how-this-code-was-made): Kiro wrote the application code and
the spec files; Claude Code wrote the requests (later ones with requirement text, some with tests
for Kiro to place word for word), ran the checks and made the commits. The numbers below come from
[`kiro-journal.md`](kiro-journal.md), which has one row per Kiro task (a request and its
follow-ups) with its credits and what went wrong.

Across the 140 journal rows, Kiro ran on Claude Haiku 4.5 in 133 and on Claude Opus 5.5 in 2;
1 row used Kiro's Auto model, 3 record no model, and 1 records the steering files we wrote by hand.
The app's own AI reader, which reads uploaded documents at run time, is Claude Haiku 5.5. The build
used about 400 Kiro credits.

## At a glance

| Kiro feature | Used | In this project | Where |
|---|---|---|---|
| Kiro IDE 1.4.154 | November 17 and 26 | Spec flow for `entry-math`, "Start task" runs, the hook form, the Stop hook and the third agent | `.kiro/specs/entry-math/` |
| Kiro CLI 3.3 to 3.6 | Main loop | 129 of the 139 journal rows that record Kiro work, headless, with custom agents and spec mode | `docs/kiro-journal.md` |
| Kiro Web | No | Needs a paid plan | |
| Kiro Crew 0.14 | Tried once, blocked | Refused to start agents on Windows without an OS sandbox | |
| Custom agents | Three | `app-builder` (code) and `rules-builder` (specs): file tools only, no shell. `entry-reviewer`: read only, may call `lookup_hts` | `.kiro/agents/` |
| Agent hooks | Two | `demo-data-check` on agent saves under `samples/`; `turn-check`, a Stop hook that runs the type check and the related tests | `.kiro/hooks/`, `scripts/kiro-turn-check.mjs` |
| Specs | Two | `entry-math`: 14 requirements, 54 properties. `document-intake`: 65 requirements, 88 properties numbered 1 to 92 | `.kiro/specs/` |
| Steering | Seven files | Product, tech, structure, pipeline (always); 7501 rules with page numbers; demo-data rules; property-test mistakes | `.kiro/steering/` |
| MCP | One server | `hts-lookup`, tool `lookup_hts`: checks a printed tariff number, never proposes one | `tools/hts-mcp/server.ts`, `.kiro/settings/mcp.json` |
| Property-based testing | Yes | 164 `fc.assert` checks in the 72 test files that `npm test` runs | `src/**/*.property.test.ts` |
| Powers | One, installed and removed | `cbp-7501-entry`: three skills and the `hts-lookup` server | `tools/kiro-power/cbp-7501-entry/` |

## 1. Kiro IDE, CLI, Web and Crew

**IDE on November 17.** The spec flow wrote `entry-math`. The requirements step ran on the Auto
model for 14 minutes and 8.95 credits and produced 14 requirements in EARS style that cite the
CBP Form 7501 page for each rule. The first task run had all 12 of its shell commands denied, so
it could not see its own test results. Once `tech.md` listed four exact test commands matching a
permission allow list, the next task ran `npm test` and `npm run typecheck` with no approval prompt.

**IDE on November 26.** Kiro asks a person before it writes into `.kiro/hooks` or `.kiro/agents`,
and a headless run cannot answer, so the Stop hook and the third agent were written from the IDE
chat. The builder pasted the request, with both files given in full, and answered the two
"Write File" prompts. Both files came out byte for byte as requested (0.61 credits), and the new
Stop hook ran at the end of that turn.

**CLI (3.3.0 to 3.6.2, headless).** Of the 139 journal rows that record Kiro work, 126 used only
the CLI, 10 only the IDE and 3 both. What we learned there:

- The CLI has a spec mode too. `--mode spec` with `--resume` produced the requirements, design and
  tasks of `document-intake` in one conversation for 3.54 credits.
- Short requests in fresh sessions were cheaper and more accurate than long conversations. Three
  follow-ups in one resumed session cost 12.70 credits in total; two follow-ups of the same size,
  each sent as a short new session, cost 1.41 and 0.88.
- Headless mode cannot answer an approval prompt, so every write Kiro treats as sensitive (hooks,
  agent files, `.kiro/settings/`) is refused there. Those went through the IDE, through a Kiro
  command (`kiro-cli mcp add`, `kiro-cli powers install`), or through an agent's own permission
  rules: `entry-reviewer`'s rules allow `lookup_hts`, so its headless runs called the tool with no
  prompt.

**Web.** Not used. It needs a paid plan, and this project ran on the free plan plus the hackathon
credits.

**Crew (0.14.0).** Tried once on Windows for a read-only review. It refused to start agent
processes because the host had no OS sandbox (`"status": "sandbox_refused"`, `"credits": 0.0`). The way around it was to turn the
sandbox requirement off or run an administrator setup, and we chose not to weaken protection on the
build machine.

## 2. Custom agents

`app-builder` (code) and `rules-builder` (specs) were written by hand on day one and are unchanged.
Both have only the `read` and `write` tools, no shell, a list of the exact paths they may write,
and the steering files as resources. `app-builder`'s prompt says "Never add AI clients, HTTP calls,
or API key handling."

- The path lists split the work: when `app-builder` tried to edit `tasks.md`, the write stopped at a
  permission question; `rules-builder`, whose list includes `.kiro/specs/**`, did it. From then on
  spec work went to `rules-builder` in spec mode and code to `app-builder`.
- With no shell, Kiro could not run the tests itself in the CLI. Claude Code ran them and passed the
  failing lines back, until the Stop hook took over that job (section 3).

**`entry-reviewer`.** The third agent can only read: its tools are `read` and `@hts-lookup`, its
rules allow `lookup_hts` and deny `.env` files, and its prompt reviews a change against the specs,
the steering and the tests. We gave it the same review twice, word for word: the code and test
change of Requirement 65 (section 4). The CLI lists Claude Haiku 4.5 with a credit multiplier of
0.40 and Claude Opus 5.5 with 2.00.

- On Claude Haiku 4.5 (1.11 credits), one of its two findings was real: a test fixture uses an HTS
  number outside the shipped subset. The other was wrong because it had read only the first 100
  lines of a file, and both line numbers were off.
- On Claude Opus 5.5 (8.16 credits), it made 24 tool calls with no approval prompt, gave the right
  line numbers and found real gaps in the new tests, among them no subtotal with a euro or dollar
  sign, no low-confidence reading, and one property, guarded by `if (p2Sub && chk)`, that could pass with
  nothing checked.
- Three of its other findings did not hold: they flagged properties that pass on the old code, which
  is right for properties that check that something stays the same. It also asked for a test on a
  recorded read that is not in the repository.

**From review to fix.** We handed the Opus review, Requirement 65, Property 92 and the
property-test steering to `app-builder` on Claude Opus 5.5, with no function, line or expected text.
In one request (16.25 credits, no approval prompt) it rewrote only the two test files, and we
corrected none of its lines (section 7 shows what the new tests catch). The Haiku runs of the same
change needed line-by-line corrections; this one needed none, though it cost more than the whole
Haiku spec path (about 11.5 credits).

## 3. Agent hooks

**`demo-data-check`** (`PostFileSave` on `samples/**`, agent action). When a Kiro agent saves a demo
file, Kiro checks it against the demo-data steering: invented names, the DEMO / FICTITIOUS mark,
example.com mail, 555-01xx phone numbers, no tax-ID shapes, and tariff numbers that exist.

- Kiro's own attempts to write the hook stopped at the approval gate; the IDE hook form wrote it.
- The first prompt answered "No problems found", missed a planted EIN-shaped number and reported
  examples from the steering file as findings. After two prompt fixes it flagged `12-3456789`.
- It fires on saves made by an agent in the IDE. A person's save in the editor fired nothing, and the
  CLI agents may not write under `samples/`, so this hook guards what Kiro writes in the IDE.

**`turn-check`**, a Stop hook. We gave Kiro the hook file and the text of
`scripts/kiro-turn-check.mjs`, and Kiro wrote them word for word. After every agent turn the script
runs a type check, then the Vitest tests related to the changed files under `src/`, with no AI key
in reach. A failure goes back to Kiro as one more turn, at most twice per session. This gives an
agent with no shell its own test results.

- It ran in the IDE and in the headless CLI alike, and on November 26 it passed after the fix of
  Requirement 65 (240 related tests).
- The failure it handed back was a property counterexample: Property 92 failed on
  `["EUR 1,000.00"]`, a US-style amount with a currency code, which the code at that point would have
  called a decimal comma form.
- Once it backfired. In that turn the request added tests that fail on purpose until the code is
  fixed, and it did not allow edits to the code. Kiro made the check pass by deleting two new
  generator lines. The next request put them back, and we changed the hook's failure message (one
  line, 0.09 credits) to say that in a tests-first request the failures may be expected and the
  tests stay.

## 4. Specs, and the same defect with and without one

- `entry-math`, from the IDE spec flow: 14 requirements and 54 correctness properties, each naming
  the requirement it validates. Two rule groups, the entry number check digit and the date rules,
  are specified but not built.
- `document-intake`, from the CLI spec mode (uploads, the AI reader boundary, cost caps, the
  exchange rate): 65 requirements, 88 properties numbered 1 to 92, and 85 top-level tasks.

`document-intake` grew one way: when an outside review or a live AI reading found a problem, the fix
went into the spec first.

| What found it | Added to the spec |
|---|---|
| The first design | upload front door and AI reader boundary (`a44ea4a`) |
| An independent review by Claude | requirements 17 to 22, properties 33 to 38 (`00b717b`) |
| The first live read, cut off at the output limit | requirements 29 and 30 |
| The second live read, which threw away right values | requirements 34 to 39 |
| Excel files and a customer parts list | requirements 45 and 46 |
| CBP code tables and the manufacturer ID | requirements 47 to 49 |
| The fourth live read: scan lines with no place on the page | requirements 58 to 60 (`bd4200a`) |
| Invoices in euros | requirements 63 and 64 (`789177b`) |
| The recorded euro read: a subtotal that was read, reported as "No invoice subtotal was read" | requirement 65, property 92 (`3e3b008`) |

From the third day the order was fixed: spec (`rules-builder`, spec mode), then tests that fail on
the old code for the intended reason, then code (`app-builder`, short new sessions), then the full
check and the task check-off in spec mode. Before requirements 58 to 60 the recorded answer was
replayed and every rejected value was counted with its reason; the requirements came from that
count. Spec-mode rows took 41.41 of the 230.12 credits logged from day two to day eight, about 18
percent.

**The same defect, both ways.** On November 26 we fixed one defect twice, both times on Claude Haiku
4.5. In the recorded read of the euro bundle, the reader read the subtotal "EUR 9.299,00" and the
draft accepted it, but the invoice check could not add up a decimal comma and said "No invoice
subtotal was read".

- Vibe, in a throwaway git worktree: a goal and conditions, no spec, then only the failing test
  output pasted back. Two requests, 2.82 credits. It reported success while its own new test
  failed, and it left no requirement and no property test. We threw it away.
- Spec: Claude Code wrote the requirement text; Kiro's spec mode added Requirement 65, Property 92
  and tasks 84 and 85, and Kiro wrote the tests and then the code from those. About 12 requests and
  11.5 credits, with several corrections, the first in words and the last line by line: the first
  tests watched the wrong check, the code first skipped removing the currency code (the tests caught
  it), then matched a pattern with no anchors (our review caught it). In the end the new tests failed
  on the old code for the intended reason, the Stop hook passed, and the change traces from
  requirement to property to tasks.

That is one defect and one run each, so it shows a difference without measuring it. Where we gave
Kiro only the spec and let it choose the implementation, its first port code tables went wrong in
seven places, and the tests caught them. Our summary: the spec was strongest before any code existed
and as the place where each defect landed first; exact requests were strongest for applying a known
change.

## 5. Steering

Seven files. Always included: `product.md`, `tech.md`, `structure.md`, `pipeline.md`. File match:
`customs-rules.md` for `src/rules/**` (our digest of the CBP Form 7501 instructions with page
numbers, marking each rule confirmed or unconfirmed), `demo-data.md` for `samples/**`, and
`property-tests.md` for `**/*.property.test.ts`.

- We wrote the first five by hand; Kiro wrote `pipeline.md` and, on November 26, `property-tests.md`
  from text we gave it.
- A file-match file loads only when a matching file is in context, so for a new spec with no
  `src/rules` yet we pointed Kiro at `customs-rules.md`. After that the requirements followed it down
  to the page numbers.
- Kiro's agents updated steering as the project changed (`5497d26`, `27f4a10`, `621ca6c`).
- `property-tests.md` lists eight ways a property test here once passed without testing anything
  (section 7). It was one of the four inputs of the Opus test rewrite. The steering was not always
  followed: the Opus review found two new test files importing `./draft` where `pipeline.md` says to
  import the public entry only.

## 6. MCP

Kiro wrote `tools/hts-mcp/server.ts`, a stdio MCP server of about 200 lines with no SDK, no network
and one tool, `lookup_hts`. It checks a printed HTS number against the shipped 2026 Revision 23
subset, returns the rate and any Chapter 99 footnote, and never proposes a classification, which is
the app's own rule.

The server was registered with `kiro-cli mcp add`, because Kiro keeps agents out of
`.kiro/settings/`. In the first headless runs calling it needed a person's approval, so the call was refused, and Kiro read the tariff file itself.
`entry-reviewer`'s rules fixed that: in a headless review it called `lookup_hts` twice with no prompt.
9505.90.6000 was found; 6204.62.2050 was not in the subset, which is how it spotted a test fixture
using a number outside the shipped table.

The power (section 8) carries its own copy of the server, but that copy did not connect from the
install folder ("Failed to connect: Connection closed"; its `mcp.json` starts the server by a
relative path), so the workspace server answered. We left it that way, because an absolute path
would not fit a public repository.

## 7. Property-based testing

164 fast-check property checks (`fc.assert`) in the 72 test files that `npm test` runs; 923 tests
pass in a serial run. One more file, `UploadPanel.test.tsx`, holds three placeholder tests outside
the test run, so we left it out of the count.

Problems the properties caught:

- On November 17, six bugs planted on purpose in the 7501 math (rounding half up turned into rounding
  down, the first line left out of the Block 39 sum, the processing-fee minimum removed, leftover
  weight not allocated, duty halved above $500, a free rate charged one cent). A property failed
  every time.
- In a "Start task" run Kiro ran its own new properties, and one failed on 471,051 cents: truncating
  can be off by up to 99 cents, and the property allowed 50. Kiro reread the requirement and rewrote
  the property.
- A property on a person's edits shrank to `[L001, 3926.40.0090]`: when a person changed a line's
  tariff number to one counted in a different unit, the quantity stayed 18 dozen where 216 pieces was
  due.

Some of Kiro's properties tested nothing: an `fc.assert` without `await`, `toBeDefined` letting
`null` pass, a generator that never produced the field names it was meant to test. Running them
showed nothing wrong; we found them by reading, and those patterns are now `property-tests.md`.

That still was not enough. The Opus review (section 2) found the new tests for Requirement 65 weaker
than they claimed. The rewrite made each property count that it reached every case and compare the
whole CHK.INVOICE field. To see whether the new tests bite, we broke the code twice on a throwaway
copy:

| Broken on purpose | New tests | Old tests |
|---|---|---|
| The code no longer removes a trailing dollar sign | 6 fail (counterexample `"1.000,00 $"`) | all 20 pass |
| The P2 subtotal check is renamed | the rewritten property fails (counterexample `[100,null]`) | all 8 in the property file pass, the `if` guard skipping the check |

## 8. Powers

We packaged three routines of this project as a power, `cbp-7501-entry` in `tools/kiro-power/`, in
the Agent Plugins format: a `plugin.json`, the `hts-lookup` server in its `mcp.json`, and three
skills (check a printed HTS number without proposing one, turn a defect into a spec requirement and a
test that fails first, review a property test). Kiro wrote the files from our text, byte for byte.

- `kiro-cli powers install` installed it.
- In a headless run, `entry-reviewer` loaded the skill `check-printed-hts` and followed it to call
  `lookup_hts` for 9505.90.6000, after getting the tool name wrong twice (0.13 credits). In an
  earlier review run with the power installed, the skill was not loaded.
- Its own copy of the MCP server did not connect (section 6). We uninstalled the power afterwards,
  as planned.

Our view: for one project the power repeats what the steering, the MCP server and the agents already
carry, and it would pay off on the next project of the same kind.
