---
inclusion: fileMatch
fileMatchPattern: "**/*.property.test.ts"
---

# Property tests (fast-check 3.23, Vitest 3)

Each point below is a way a property test in this repository once passed, or never started,
without testing anything. Check every new or changed property test against all eight.

1. **Only functions that exist in fast-check 3.23.** These were guessed before and do not exist:
   `fc.sampled`, `fc.sampled.constant`, `fc.uniqueBy`, `fc.hexaStringFixed`. Use
   `fc.constantFrom`, `fc.uniqueArray`, `fc.stringMatching` or `fc.hexaString`.
2. **Call shape.** `fc.assert(fc.property(arbA, arbB, (a, b) => { ... }), { numRuns })`. The
   predicate is the last argument of `fc.property`; do not close `fc.property(` before it.
3. **Await async properties.** Write `await fc.assert(fc.asyncProperty(...))`. Without `await` the
   test ends in a few milliseconds and checks nothing.
4. **Reach the case.** The generator must produce the case the requirement is about. If the
   property looks for a field such as `L001.36A`, the generated names must contain it exactly. A
   property whose filter never matches passes on every run, so count the matches and expect more
   than zero, or add an example test for the case.
5. **Assert the value, not its presence.** `toBeDefined()` also passes for `null`. Compare with
   `toBe`, `toEqual` or `toBeNull`.
6. **Test the code in `src/`.** Import the function under test. Do not define a helper inside the
   test that does what the app is supposed to do; such a test passes even when the app lacks it.
7. **Right direction.** Name the requirement number in the test name and check the rule as the
   requirement states it, both ways where it says "if and only if". A property that still holds
   when the rule is broken proves nothing.
8. **Make uncertain input uncertain.** A property about uncertain input must change the input so it
   is uncertain (for example a quote that is not found on the page) and expect the needs-review
   status, not just any status.

A new property should fail on the code before the change, for the reason the requirement names.
For slow properties, build lookup tables once outside the predicate instead of lowering `numRuns`.
