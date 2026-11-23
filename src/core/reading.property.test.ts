import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { verifyReadings } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import type { DocumentText, PageText } from "./pdfText";
import { loadBundleFromDisk } from "../node/index";
import { transcriptToPageText } from "./transcript";

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];

describe("Reading verification with confidence and image origin", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
  });

  describe("Feature: document-intake, Property 2: Confidence Always Rejects Low (Validates: Requirements 5.1, 5.4)", () => {
    it(
      "should reject all fields marked with low confidence",
      () => {
        fc.assert(
          fc.property(
            fc.uniqueArray(fc.integer({ min: 0, max: bundleAnswer.fields.length - 1 }), {
              minLength: 0,
              maxLength: bundleAnswer.fields.length,
            }),
            (lowConfidenceIndexes) => {
              // Create a modified answer with low confidence on selected fields
              const modifiedAnswer: ReadingAnswer = {
                ...bundleAnswer,
                fields: bundleAnswer.fields.map((field, i) => {
                  if (lowConfidenceIndexes.includes(i)) {
                    return { ...field, confidence: "low" as const };
                  }
                  return { ...field };
                }),
              };

              // Verify the unchanged answer once
              const original = verifyReadings(bundleAnswer, bundleDocuments);

              // Verify the modified readings
              const verified = verifyReadings(modifiedAnswer, bundleDocuments);

              // Check that all low-confidence fields are rejected with reason "low_confidence"
              for (let i = 0; i < verified.length; i++) {
                if (lowConfidenceIndexes.includes(i)) {
                  const v = verified[i];
                  expect(v.status).toBe("rejected");
                  if (v.status === "rejected") {
                    expect(v.reason).toBe("low_confidence");
                  }
                }
              }

              // Check that other fields keep their original status
              for (let i = 0; i < verified.length; i++) {
                if (!lowConfidenceIndexes.includes(i)) {
                  expect(verified[i].status).toBe(original[i].status);
                  if (verified[i].status === "rejected" && original[i].status === "rejected") {
                    expect((verified[i] as any).reason).toBe((original[i] as any).reason);
                  }
                }
              }
            },
          ),
          { numRuns: 100 },
        );
      },
      60000,
    );
  });

  describe("Feature: document-intake, Property 3: Absent Confidence Treated as Passed (Validates: Requirements 5.3)", () => {
    it(
      "should treat absent confidence same as running verification on unchanged sample",
      () => {
        fc.assert(
          fc.property(
            fc.uniqueArray(fc.integer({ min: 0, max: bundleAnswer.fields.length - 1 }), {
              minLength: 0,
              maxLength: bundleAnswer.fields.length,
            }),
            (highConfidenceIndexes) => {
              // Create a modified answer with high confidence on selected fields, rest absent
              const modifiedAnswer: ReadingAnswer = {
                ...bundleAnswer,
                fields: bundleAnswer.fields.map((field, i) => {
                  if (highConfidenceIndexes.includes(i)) {
                    return { ...field, confidence: "high" as const };
                  }
                  // Remove confidence field (leave it undefined)
                  const { confidence, ...rest } = field as any;
                  return rest;
                }),
              };

              // Verify both versions
              const verified = verifyReadings(modifiedAnswer, bundleDocuments);
              const original = verifyReadings(bundleAnswer, bundleDocuments);

              // Check that statuses and reasons are identical
              for (let i = 0; i < verified.length; i++) {
                expect(verified[i].status).toBe(original[i].status);
                if (verified[i].status === "rejected") {
                  expect((verified[i] as any).reason).toBe((original[i] as any).reason);
                }
              }
            },
          ),
          { numRuns: 100 },
        );
      },
      60000,
    );
  });
});

describe("Feature: document-intake, Property 37: Partial Quotes Keep a Box (Validates: Requirements 20.1, 20.2, 20.3)", () => {
  it(
    "should accept partial quote inside a line, use that line's box, and keep exact quote behavior",
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 8 }),
          fc.integer({ min: 100, max: 999 }),
          (lineCount, n) => {
            // Build a page with lineCount lines, each with text "Label k: VkXn"
            const lines = [];
            for (let k = 1; k <= lineCount; k++) {
              lines.push({
                text: `Label ${k}: V${k}X${n}`,
                box: { x: 0.05, y: 0.05 + 0.1 * (k - 1), w: 0.5, h: 0.05 },
              });
            }
            const page = transcriptToPageText("d", 1, 100, 100, lines);

            // Pick a line k to read a partial value from
            const k = Math.floor(Math.random() * lineCount) + 1;
            const value = `V${k}X${n}`;
            const quote = `Label ${k}: V${k}X${n}`;

            // Create reading and answer
            const reading = { field: "test", value, quote, doc: "d", page: 1 };
            const answer: ReadingAnswer = {
              schemaVersion: 1,
              bundle: "test",
              reader: "test",
              documents: [{ docId: "d", kind: "invoice" as const }],
              fields: [reading],
            };

            const doc: DocumentText = { docId: "d", kind: "invoice", pages: [page] };
            const verified = verifyReadings(answer, [doc]);

            // Should be accepted
            expect(verified[0].status).toBe("accepted");
            if (verified[0].status === "accepted") {
              // Box should have positive width and height
              expect(verified[0].box.w).toBeGreaterThan(0);
              expect(verified[0].box.h).toBeGreaterThan(0);

              // Box should equal the item for line k
              const expectedItem = page.items[k - 1];
              expect(verified[0].box).toEqual(expectedItem.box);

              // itemIds should contain that item's id
              expect(verified[0].itemIds).toContain(expectedItem.id);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    60000,
  );

  it(
    "should accept whole line quote, keep that line's box",
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 8 }),
          fc.integer({ min: 100, max: 999 }),
          (lineCount, n) => {
            // Build a page with lineCount lines
            const lines = [];
            for (let k = 1; k <= lineCount; k++) {
              lines.push({
                text: `Label ${k}: V${k}X${n}`,
                box: { x: 0.05, y: 0.05 + 0.1 * (k - 1), w: 0.5, h: 0.05 },
              });
            }
            const page = transcriptToPageText("d", 1, 100, 100, lines);

            // Pick a line k
            const k = Math.floor(Math.random() * lineCount) + 1;
            const wholeLineText = `Label ${k}: V${k}X${n}`;
            const value = wholeLineText;
            const quote = wholeLineText;

            // Create reading and answer
            const reading = { field: "test", value, quote, doc: "d", page: 1 };
            const answer: ReadingAnswer = {
              schemaVersion: 1,
              bundle: "test",
              reader: "test",
              documents: [{ docId: "d", kind: "invoice" as const }],
              fields: [reading],
            };

            const doc: DocumentText = { docId: "d", kind: "invoice", pages: [page] };
            const verified = verifyReadings(answer, [doc]);

            // Should be accepted
            expect(verified[0].status).toBe("accepted");
            if (verified[0].status === "accepted") {
              // Box should equal the item for line k
              const expectedItem = page.items[k - 1];
              expect(verified[0].box).toEqual(expectedItem.box);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    60000,
  );

  it("should reject partial quote that does not line up with any item", () => {
    // No span covers the text, so no item lines up with the value.
    const page: PageText = {
      page: 1,
      width: 100,
      height: 100,
      text: "Total 10",
      items: [{ id: "i1", str: "Total 10", box: { x: 1, y: 2, w: 30, h: 5 } }],
      spans: [],
    };

    const reading = { field: "test", value: "10", quote: "Total 10", doc: "d", page: 1 };
    const answer: ReadingAnswer = {
      schemaVersion: 1,
      bundle: "test",
      reader: "test",
      documents: [{ docId: "d", kind: "invoice" as const }],
      fields: [reading],
    };

    const doc: DocumentText = { docId: "d", kind: "invoice", pages: [page] };
    const verified = verifyReadings(answer, [doc]);

    // Should be rejected with reason "no_source_box"
    expect(verified[0].status).toBe("rejected");
    if (verified[0].status === "rejected") {
      expect(verified[0].reason).toBe("no_source_box");
      expect(verified[0].message).toBe(
        "The value was found, but no line on the page lines up with it, so there is nothing to point to.",
      );
    }
  });

  it("should check empty quote before checking for source box", () => {
    const page: PageText = {
      page: 1,
      width: 100,
      height: 100,
      text: "Total 10",
      items: [{ id: "i1", str: "Total 10", box: { x: 1, y: 2, w: 30, h: 5 } }],
      spans: [{ itemId: "i1", start: 0, end: 8 }],
    };

    const reading = { field: "test", value: "10", quote: "", doc: "d", page: 1 };
    const answer: ReadingAnswer = {
      schemaVersion: 1,
      bundle: "test",
      reader: "test",
      documents: [{ docId: "d", kind: "invoice" as const }],
      fields: [reading],
    };

    const doc: DocumentText = { docId: "d", kind: "invoice", pages: [page] };
    const verified = verifyReadings(answer, [doc]);

    // Should be rejected with reason "empty_quote", not "no_source_box"
    expect(verified[0].status).toBe("rejected");
    if (verified[0].status === "rejected") {
      expect(verified[0].reason).toBe("empty_quote");
    }
  });

  it("should check quote_not_found before checking for source box", () => {
    const page: PageText = {
      page: 1,
      width: 100,
      height: 100,
      text: "Total 10",
      items: [{ id: "i1", str: "Total 10", box: { x: 1, y: 2, w: 30, h: 5 } }],
      spans: [{ itemId: "i1", start: 0, end: 8 }],
    };

    const reading = { field: "test", value: "20", quote: "Total 20", doc: "d", page: 1 };
    const answer: ReadingAnswer = {
      schemaVersion: 1,
      bundle: "test",
      reader: "test",
      documents: [{ docId: "d", kind: "invoice" as const }],
      fields: [reading],
    };

    const doc: DocumentText = { docId: "d", kind: "invoice", pages: [page] };
    const verified = verifyReadings(answer, [doc]);

    // Should be rejected with reason "quote_not_found", not "no_source_box"
    expect(verified[0].status).toBe("rejected");
    if (verified[0].status === "rejected") {
      expect(verified[0].reason).toBe("quote_not_found");
    }
  });
});
