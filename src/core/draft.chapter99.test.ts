import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { runBundleFromDisk } from "../node/index";
import * as draftModule from "./draft";
import type { Draft } from "./draft";

// Requirement 57: the tariff footnote already reads "See 9903.90.08.", so the Chapter 99 reason put "See" and the period on twice
// ("See See 9903.90.08.. A person enters the additional duty (0.00 if none).").

const TAIL = ". A person enters the additional duty (0.00 if none).";
const reasonOf = (footnotes: string[]): string | undefined =>
  (draftModule as unknown as { chapter99Reason?: (f: string[]) => string }).chapter99Reason?.(footnotes);
const ch99 = (d: Draft) => d.lines.flatMap((l) => l.fields).find((f) => f.id === "L005.ch99");

describe('Feature: document-intake, Property 76: The Chapter 99 Reason Says "See" Once (Validates: Requirements 57.1, 57.2)', () => {
  it("57.1 the examples", () => {
    expect(reasonOf(["See 9903.90.08."])).toBe("See 9903.90.08. A person enters the additional duty (0.00 if none).");
    expect(reasonOf(["9903.88.15", "See 9903.01.25."])).toBe("See 9903.88.15; See 9903.01.25. A person enters the additional duty (0.00 if none).");
    expect(reasonOf(["  see 9903.88.03..  "])).toBe("See 9903.88.03. A person enters the additional duty (0.00 if none).");
  });

  it("57.2 the sample's L005.ch99 reason, with and without the demo answers", async () => {
    const { overrides } = await import("../../samples/lantern-hollow/overrides-demo.json");
    const raw = await runBundleFromDisk(process.cwd(), "lantern-hollow", []);
    const demo = await runBundleFromDisk(process.cwd(), "lantern-hollow", overrides);
    expect(ch99(raw.draft)?.reason).toBe("See 9903.90.08. A person enters the additional duty (0.00 if none).");
    for (const csv of [raw.csv, demo.csv]) {
      expect(csv).not.toMatch(/see\s+see/i);
      expect(csv).toContain("See 9903.90.08. A person enters the additional duty (0.00 if none).");
    }
  });

  it('Property 76: for any one to three footnotes, the reason starts with "See ", says it once, has no "..", names every heading in order and ends with the sentence for the person', () => {
    const two = fc.integer({ min: 0, max: 99 }).map((n) => String(n).padStart(2, "0"));
    const heading = fc.tuple(two, two, two).map(([a, b, c]) => `99${a}.${b}.${c}`);
    const footnote = fc
      .tuple(fc.constantFrom("", " ", "See ", "see ", "SEE "), heading, fc.constantFrom("", ".", ".."), fc.constantFrom("", " "))
      .map(([see, h, dots, end]) => ({ heading: h, text: `${see}${h}${dots}${end}` }));
    fc.assert(
      fc.property(fc.array(footnote, { minLength: 1, maxLength: 3 }), (fs) => {
        const r = reasonOf(fs.map((f) => f.text));
        expect(typeof r).toBe("string");
        if (typeof r !== "string") return;
        expect(r.startsWith("See ")).toBe(true);
        expect(r).not.toMatch(/see\s+see/i);
        expect(r).not.toContain("..");
        expect(r.endsWith(TAIL)).toBe(true);
        let at = 0;
        for (const f of fs) {
          const i = r.indexOf(f.heading, at);
          expect(i).toBeGreaterThanOrEqual(at);
          at = i + f.heading.length;
        }
      }),
      { numRuns: 200 },
    );
  });
});
