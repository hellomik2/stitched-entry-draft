import { describe, it, expect, beforeAll } from "vitest";
import { verifyReadings } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import { buildDraft, IMAGE_COMPUTED_REVIEW_REASON, IMAGE_REVIEW_REASON, IMAGE_WAITING_SUFFIX, allFields } from "./draft";
import type { DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];
let bundleHts: HtsTable;

describe("Draft: Image Wait and Missing Values", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
    bundleHts = bundle.hts;
  });

  // Helper: return all fields in draft in order
  const all = (d: any) => allFields(d);

  describe("Feature: document-intake, Property 43: Waiting Fields Name What They Wait On (Validates: Requirements 26.3)", () => {
    it(
      "Property 43: Waiting Fields Name What They Wait On",
      async () => {
        const fc = await import("fast-check");
        fc.assert(
          fc.property(
            fc.array(fc.boolean(), { minLength: 1, maxLength: 60 }),
            (imageFlags) => {
              // Generate one boolean per verified reading, cycling to match number of readings
              const originalVerified = verifyReadings(bundleAnswer, bundleDocuments);

              // Build readings with image origins based on flags
              let flagIndex = 0;
              const readingsWithOrigin: VerifiedReading[] = originalVerified.map((r) => {
                const flag = imageFlags[flagIndex % imageFlags.length];
                flagIndex++;
                if (flag && r.status === "accepted") {
                  return { ...r, origin: "imageTranscript" as const };
                }
                return r;
              });

              // Build draft with image origins
              const draft = buildDraft({
                bundle: "lantern-hollow",
                reader: bundleAnswer.reader,
                readings: readingsWithOrigin,
                hts: bundleHts,
              });

              const allFieldsList = all(draft);

              // Helper: check if a field is image-waiting
              const isImageWaiting = (f: any): boolean => {
                return f.status === "needsReview" && (f.reason === IMAGE_REVIEW_REASON || f.reason === IMAGE_COMPUTED_REVIEW_REASON);
              };

              // Helper: get dependencies of a field
              const depsOf = (f: any): string[] => {
                const deps = [...f.inputs];
                if (f.block === "37A" && f.line !== null) {
                  deps.push(`L${f.line}.33A`);
                  deps.push(`L${f.line}.10`);
                }
                return deps;
              };

              // Helper: compute waitsOn set
              const waitsOnMemo = new Map<string, Set<string>>();
              const visiting = new Set<string>();

              const waitsOn = (id: string): Set<string> => {
                if (waitsOnMemo.has(id)) {
                  return waitsOnMemo.get(id)!;
                }

                if (visiting.has(id)) {
                  return new Set();
                }

                visiting.add(id);
                const result = new Set<string>();

                const field = allFieldsList.find((f) => f.id === id);
                if (field) {
                  for (const depId of depsOf(field)) {
                    const depField = allFieldsList.find((f) => f.id === depId);
                    if (depField) {
                      if (isImageWaiting(depField)) {
                        result.add(depId);
                      }
                      if (depField.status !== "personEdited") {
                        for (const transId of waitsOn(depId)) {
                          result.add(transId);
                        }
                      }
                    }
                  }
                }

                visiting.delete(id);
                waitsOnMemo.set(id, result);
                return result;
              };

              // Pre-compute waitsOn
              for (const f of allFieldsList) {
                waitsOn(f.id);
              }

              // Test 1: no field with status "computed" or "copied" has a dependency that is image-waiting
              for (const field of allFieldsList) {
                if (field.status === "computed" || field.status === "copied") {
                  const deps = waitsOn(field.id);
                  if (deps.size > 0) {
                    throw new Error(
                      `Field ${field.id} (status ${field.status}) depends on image-waiting fields: ${Array.from(deps).join(", ")}`
                    );
                  }
                }
              }

              // Test 2: every field whose reason ends with IMAGE_WAITING_SUFFIX has reason exactly "Waiting on <ids>: <suffix>"
              for (const field of allFieldsList) {
                if (field.reason && field.reason.endsWith(IMAGE_WAITING_SUFFIX)) {
                  const deps = waitsOn(field.id);
                  if (deps.size === 0) {
                    throw new Error(`Field ${field.id} has waiting suffix but no actual dependencies`);
                  }
                  const sortedDeps = Array.from(deps).sort((a, b) => {
                    const indexA = allFieldsList.findIndex((f) => f.id === a);
                    const indexB = allFieldsList.findIndex((f) => f.id === b);
                    return indexA - indexB;
                  });
                  const expectedReason = `Waiting on ${sortedDeps.join(", ")}: ${IMAGE_WAITING_SUFFIX}`;
                  expect(field.reason).toBe(expectedReason);
                }
              }
            },
          ),
          { numRuns: 25 },
        );
      },
      120000,
    );

    it(
      "Example: all pages from image give computed fields with IMAGE_COMPUTED_REVIEW_REASON, waiting fields for computed downstream",
      async () => {
        // Map all pages to origin "imageTranscript"
        const readingsWithAllImage: VerifiedReading[] = bundleDocuments.length > 0
          ? verifyReadings(bundleAnswer, bundleDocuments.map((doc) => ({
              ...doc,
              pages: doc.pages.map((p) => ({ ...p, origin: "imageTranscript" as const })),
            })))
          : [];

        // Actually we need to set image origins in the readings
        const originalVerified = verifyReadings(bundleAnswer, bundleDocuments);
        const readingsImageTranscript: VerifiedReading[] = originalVerified.map((r) => {
          if (r.status === "accepted") {
            return { ...r, origin: "imageTranscript" as const };
          }
          return r;
        });

        const draft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: readingsImageTranscript,
          hts: bundleHts,
        });

        const allFieldsList = all(draft);

        // Find L001.36A, L001.35, L001.34A
        const l001_36A = allFieldsList.find((f) => f.id === "L001.36A");
        const l001_35 = allFieldsList.find((f) => f.id === "L001.35");
        const l001_34A = allFieldsList.find((f) => f.id === "L001.34A");

        // L001.36A should be computed with reason IMAGE_COMPUTED_REVIEW_REASON
        expect(l001_36A).toBeDefined();
        expect(l001_36A?.reason).toBe(IMAGE_COMPUTED_REVIEW_REASON);

        // L001.35 should be computed with reason IMAGE_COMPUTED_REVIEW_REASON
        expect(l001_35).toBeDefined();
        expect(l001_35?.reason).toBe(IMAGE_COMPUTED_REVIEW_REASON);

        // L001.34A should be computed with reason IMAGE_COMPUTED_REVIEW_REASON
        expect(l001_34A).toBeDefined();
        expect(l001_34A?.reason).toBe(IMAGE_COMPUTED_REVIEW_REASON);

        // L001.37A has status "needsReview" and reason waiting on L001.10, L001.33A
        const l001_37A = allFieldsList.find((f) => f.id === "L001.37A");
        expect(l001_37A?.status).toBe("needsReview");
        expect(l001_37A?.reason).toBe(`Waiting on L001.10, L001.33A: ${IMAGE_WAITING_SUFFIX}`);

        // L001.38 has reason waiting on L001.10, L001.33A, L001.36A
        const l001_38 = allFieldsList.find((f) => f.id === "L001.38");
        expect(l001_38?.reason).toBe(`Waiting on L001.10, L001.33A, L001.36A: ${IMAGE_WAITING_SUFFIX}`);
      },
      120000,
    );
  });

  describe("Feature: document-intake, Property 44: A Missing Amount, Currency or Gross Weight Is Never Computed (Validates: Requirements 27.1 to 27.5)", () => {
    it(
      "Property 44: Missing Amount, Currency, or Gross Weight",
      async () => {
        const fc = await import("fast-check");
        fc.assert(
          fc.property(
            fc.subarray([1, 2, 3, 4, 5, 6, 7, 8], { minLength: 1 }),
            (lowConfidenceLines) => {
              // Create answer with selected invoice line amounts set to low confidence
              const modifiedAnswer: ReadingAnswer = {
                ...bundleAnswer,
                fields: bundleAnswer.fields.map((field) => {
                  // Check if this is an amount field for a lowConfidenceLines line
                  const match = field.field.match(/^invoice\.lines\.(\d+)\.amount$/);
                  if (match) {
                    const lineNum = parseInt(match[1], 10);
                    if (lowConfidenceLines.includes(lineNum)) {
                      return { ...field, confidence: "low" as const };
                    }
                  }
                  return field;
                }),
              };

              // Build plain draft once (unmodified)
              const originalVerified = verifyReadings(bundleAnswer, bundleDocuments);
              const plain = buildDraft({
                bundle: "lantern-hollow",
                reader: bundleAnswer.reader,
                readings: originalVerified,
                hts: bundleHts,
              });

              const verified = verifyReadings(modifiedAnswer, bundleDocuments);
              const draft = buildDraft({
                bundle: "lantern-hollow",
                reader: bundleAnswer.reader,
                readings: verified,
                hts: bundleHts,
              });

              const allFieldsList = all(draft);

              // For each 7501 line whose invoiceLines include a lowered line that had an amount reading
              for (const line of draft.lines) {
                const hasLoweredAmount = line.invoiceLines.some((n) => lowConfidenceLines.includes(n));

                if (hasLoweredAmount) {
                  const field36A = line.fields.find((f) => f.id.endsWith(".36A"));
                  // Should be needsReview with reason starting "No accepted amount"
                  expect(field36A?.status).toBe("needsReview");
                  expect(field36A?.reason?.startsWith("No accepted amount for invoice line")).toBe(true);
                  expect(field36A?.value).toBeNull();
                }
              }

              // Check that no 36A, 38, B39, B41, B44 field is "computed" with value "0" or "0.00"
              // except when the same field id in plain is also "computed" with the same value
              for (const field of allFieldsList) {
                if (field.status === "computed" && (field.id.endsWith(".36A") || field.id.endsWith(".38") || field.id === "B39" || field.id === "B41" || field.id === "B44")) {
                  if (field.value === "0" || field.value === "0.00") {
                    const plainField = [
                      ...plain.header,
                      ...plain.totals,
                      ...plain.lines.flatMap((l) => l.fields),
                    ].find((f) => f.id === field.id);
                    expect(plainField?.status).toBe("computed");
                    expect(plainField?.value).toBe(field.value);
                  }
                }
              }
            },
          ),
          { numRuns: 30 },
        );
      },
      120000,
    );

    it(
      "Example: all amounts low confidence",
      async () => {
        const modifiedAnswer: ReadingAnswer = {
          ...bundleAnswer,
          fields: bundleAnswer.fields.map((field) => {
            if (field.field.match(/^invoice\.lines\.\d+\.amount$/)) {
              return { ...field, confidence: "low" as const };
            }
            return field;
          }),
        };

        const verified = verifyReadings(modifiedAnswer, bundleDocuments);
        const draft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: verified,
          hts: bundleHts,
        });

        // Every 36A should be needsReview with value null
        for (const line of draft.lines) {
          const field36A = line.fields.find((f) => f.id.endsWith(".36A"));
          expect(field36A?.status).toBe("needsReview");
          expect(field36A?.value).toBeNull();
        }

        // B39 should be needsReview
        const allFieldsList = all(draft);
        const b39 = allFieldsList.find((f) => f.id === "B39");
        expect(b39?.status).toBe("needsReview");
      },
      120000,
    );

    it(
      "Example: invoice currency low confidence",
      async () => {
        const modifiedAnswer: ReadingAnswer = {
          ...bundleAnswer,
          fields: bundleAnswer.fields.map((field) => {
            if (field.field === "invoice.currency") {
              return { ...field, confidence: "low" as const };
            }
            return field;
          }),
        };

        const verified = verifyReadings(modifiedAnswer, bundleDocuments);
        const draft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: verified,
          hts: bundleHts,
        });

        // Every 36A should have reason "No invoice currency was read..."
        for (const line of draft.lines) {
          const field36A = line.fields.find((f) => f.id.endsWith(".36A"));
          expect(field36A?.reason).toBe("No invoice currency was read. A person checks that the amounts are in USD and enters the entered value.");
          expect(field36A?.value).toBeNull();
        }
      },
      120000,
    );

    it(
      "Example: total gross weight low confidence",
      async () => {
        const modifiedAnswer: ReadingAnswer = {
          ...bundleAnswer,
          fields: bundleAnswer.fields.map((field) => {
            if (field.field === "packingList.totalGrossKg") {
              return { ...field, confidence: "low" as const };
            }
            return field;
          }),
        };

        const verified = verifyReadings(modifiedAnswer, bundleDocuments);
        const draft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: verified,
          hts: bundleHts,
        });

        // Every 34A should be needsReview with value null and specific reason
        for (const line of draft.lines) {
          const field34A = line.fields.find((f) => f.id.endsWith(".34A"));
          expect(field34A?.status).toBe("needsReview");
          expect(field34A?.value).toBeNull();
          expect(field34A?.reason).toBe("The AI reader read the packing list total gross weight as 286.2 kg but was not sure, so it is not used. A person checks it and enters the gross weight.");
        }
      },
      120000,
    );

    it(
      "Example: unmodified sample has no missing amount, currency or gross weight reasons",
      async () => {
        const verified = verifyReadings(bundleAnswer, bundleDocuments);
        const draft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: verified,
          hts: bundleHts,
        });

        const allFieldsList = all(draft);

        // No field should have reason starting with "No accepted amount", "No invoice currency", or "No total gross weight"
        // and no reason should end with IMAGE_WAITING_SUFFIX
        for (const field of allFieldsList) {
          if (field.reason) {
            expect(field.reason.startsWith("No accepted amount for invoice line")).toBe(false);
            expect(field.reason).not.toBe("No invoice currency was read. A person checks that the amounts are in USD and enters the entered value.");
            expect(field.reason).not.toBe("No total gross weight was read from the packing list. A person enters the gross weight.");
            expect(field.reason.endsWith(IMAGE_WAITING_SUFFIX)).toBe(false);
          }
        }
      },
      120000,
    );
  });
});
