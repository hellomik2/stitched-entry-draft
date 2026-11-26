---
name: defect-to-spec
description: Turn a defect found in a real read, an outside review or a screen check into a spec requirement, a test that fails first, and one narrow code change.
---

# From a defect to a tested change

This is the order every fix in this repository followed after the first week. Each step is its own
request, and the maintainer runs the checks between steps.

1. **Evidence.** Write down the input (bundle, document, line), the value the draft shows, the value
   it should show, and the rule that says so. `.kiro/steering/customs-rules.md` cites the CBP Form
   7501 instruction pages.
2. **Spec first.** In spec mode, with the `rules-builder` agent (the only custom agent that may
   write `.kiro/specs/**`), add a numbered requirement in EARS style ("WHEN ... THE draft SHALL
   ...") to `.kiro/specs/document-intake/requirements.md`, a correctness property with
   "Validates: Requirements x.y" to `design.md`, and a task to `tasks.md`.
3. **Test first.** Write the example test and the fast-check property for the new requirement. The
   maintainer runs them on the code before the change and confirms that they fail, and fail for the
   reason the requirement names (not an import error or a typo).
4. **One narrow code change.** A request that names the files and the lines to change, with the
   current and the new text. Change nothing else.
5. **Checks.** Type check with no errors, the related tests, then the full serial test run. Review
   new property tests with the `review-property-test` skill.
6. **Close.** Only after the maintainer's run passed, mark the task `[x]` in `tasks.md` and add one
   row to `docs/kiro-journal.md`.

## Never

- Never mark a task done before the maintainer's run passed.
- Never widen a fix to files the request did not name.
- Never let the app choose a tariff number or an exchange rate; a person enters those.
