---
inclusion: always
---

# Structure

```
/.kiro/            Kiro project files (steering, specs, hooks, agents). Never git-ignored.
/src/app/          Next.js App Router pages, layouts, route handlers (UI and server).
/src/rules/        Pure 7501 math and validation rules. One file per rule group.
/src/rules/config.ts   The only place for rates, minimums, maximums, rule switches.
/samples/          Fictitious demo documents only (see demo-data steering).
/docs/             Project notes. docs/kiro-journal.md is the Kiro usage log.
/public/           Static files.
```

- Rule files are small and named by what they compute, for example `rounding.ts`,
  `totals.ts`, `fees.ts`, `checkDigit.ts`, `manufacturerId.ts`, `dates.ts`, `lines.ts`.
- `src/rules/index.ts` re-exports the public rule functions.
- UI code imports rules; rules never import UI or Next.js.
- Text in code, comments, docs, and commit messages is English.
- Do not put real company names, real people, tax IDs, or secrets anywhere in the repo.
