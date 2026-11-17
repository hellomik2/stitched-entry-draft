---
inclusion: always
---

# Tech

## Stack

- **TypeScript** everywhere, `strict: true`. One repository.
- **Next.js** (App Router) for UI and server functions, with `src/` directory.
- **Vitest** for tests, **fast-check** for property-based tests.
- **npm** as the package manager. Node 20 LTS or newer.

## Rules for code

- `src/rules/` holds **pure functions only**: no I/O, no network, no `Date.now()`, no
  randomness, no React. Same input, same output. These are the property-test targets.
- **No floating-point money math.** Amounts inside `src/rules/` are integer **cents**
  (safe integers). Percentage rates are exact integers (for example parts per million:
  0.3464% = 3464 ppm). Convert at the edges, and round only where a rule says so, with the
  rounding mode written in the code.
- Every rate, minimum, maximum, and unconfirmed rule choice lives in **one config module**
  (`src/rules/config.ts`). No magic numbers elsewhere.
- Functions return explicit results for "cannot compute" (for example
  `{ ok: false, reason }` or a `needsReview` flag) instead of throwing for normal business
  cases. Throw only for programmer errors (invalid types, non-integer cents).
- Keep dependencies small. Do not add a library when a few lines of code do the job.
- Paid AI calls: exactly one AI reader is allowed, in `src/server/claudeReader.ts` (spec document-intake). It reads the key only from the server environment variable `ANTHROPIC_API_KEY` and passes it explicitly to the official SDK client. No other file calls a paid AI API. Tests never make network calls (they inject a fake client). Never write secrets or `.env` files.

## Commands

You may run exactly these four commands yourself to check your own work, and fix what they
report: `npm test`, `npm test <args>`, `npm run typecheck`, `npx vitest <args>`. Do not
run any other shell command (no `npm install`, no build, no dev server, no git, no file
deletion); list those in your reply for the maintainer. The maintainer's own test run
decides whether a task is done.

## Tests

- Example tests and property tests sit next to the code: `foo.ts`, `foo.test.ts`,
  `foo.property.test.ts`.
- Each property test names the requirement it validates in its title.
- Official worked examples from the CBP Form 7501 instructions are mandatory example tests.
