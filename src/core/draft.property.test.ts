import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { verifyReadings } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import { buildDraft } from "./draft";
import type { DraftField } from "./draft";
import type { DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

/**
 * Helper: collect all draft fields in order
 */
function allDraftFields(draft: ReturnType<typeof buildDraft>): DraftField[] {
  const all: DraftField[] = [];
  for (const field of draft.header) {
    all.push(field);
  }
  for (const line of draft.lines) {
    for (const field of line.fields) {
      all.push(field);
    }
  }
  for (const field of draft.totals) {
    all.push(field);
  }
  return all;
}

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];
let bundleHts: HtsTable;

describe("Draft field sources and coverage", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
    bundleHts = bundle.hts;
  });

  describe("Feature: document-intake, Property 4: Every Copied Value Has Source (Validates: Requirements 4.2, 14.2)", () => {
    it(
      "should have sources for every copied field with boxes within page bounds",
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

              // Verify and build draft
              const verified = verifyReadings(modifiedAnswer, bundleDocuments);
              const draft = buildDraft({
                bundle: "lantern-hollow",
                reader: bundleAnswer.reader,
                readings: verified,
                hts: bundleHts,
              });

              const allFields = allDraftFields(draft);

              // Check every copied field
              for (const field of allFields) {
                if (field.status === "copied") {
                  // Must have at least one source
                  expect(field.sources.length).toBeGreaterThan(0);

                  // Check every document source
                  for (const source of field.sources) {
                    if (source.kind === "document") {
                      // Find the reading field this source refers to
                      const readingField = verified.find((r) => r.field === source.readingField);
                      expect(readingField).toBeDefined();

                      // Check the reading was accepted
                      if (readingField) {
                        expect(readingField.status).toBe("accepted");

                        // Find the page
                        const page = bundleDocuments
                          .find((d) => d.docId === source.doc)
                          ?.pages.find((p) => p.page === source.page);
                        expect(page).toBeDefined();

                        if (page) {
                          expect(source.box).not.toBeNull();
                          // Check box is within page bounds (with 0.01 tolerance)
                          expect(source.box!.x).toBeGreaterThanOrEqual(0);
                          expect(source.box!.y).toBeGreaterThanOrEqual(0);
                          expect(source.box!.x + source.box!.w).toBeLessThanOrEqual(page.width + 0.01);
                          expect(source.box!.y + source.box!.h).toBeLessThanOrEqual(page.height + 0.01);
                        }
                      }
                    }
                  }
                }
              }
            },
          ),
          { numRuns: 25 },
        );
      },
      60000,
    );
  });
});
