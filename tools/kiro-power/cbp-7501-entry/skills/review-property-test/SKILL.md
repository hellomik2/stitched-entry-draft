---
name: review-property-test
description: Review fast-check property tests in this repository for the ways they pass, or never start, without testing anything, and report each finding with file and line.
---

# Review property tests

1. Read the property test file in full, the source file it imports, and the requirement it names
   (`.kiro/specs/*/requirements.md`).
2. Check every `fc.assert` against the eight points in `.kiro/steering/property-tests.md`:
   1. only functions that exist in fast-check 3.23;
   2. the call shape, with the predicate as the last argument of `fc.property`;
   3. `await` before `fc.assert` of an `fc.asyncProperty`;
   4. a generator that reaches the case the requirement is about;
   5. assertions on the value, not on its presence;
   6. the function under test imported from `src/`, not re-implemented in the test;
   7. the requirement encoded in the right direction;
   8. uncertain input actually made uncertain, with the needs-review status expected.
3. Report one line per finding: file | line | quoted code | what is wrong | point number. Quote only
   code you read.
4. If nothing is wrong, write "No findings" and list the properties you checked.

Never edit the test or the code; the maintainer decides what to change.
