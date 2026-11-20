import { describe, it, expect, beforeAll } from "vitest";
import { verifyReadings } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import { buildDraft, IMAGE_REVIEW_REASON, IMAGE_COMPUTED_REVIEW_REASON, IMAGE_WAITING_SUFFIX, CONFIRMED_NOTE, allFields } from "./draft";
import type { DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];
let bundleHts: HtsTable;

describe("Draft", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
    bundleHts = bundle.hts;
  });

  describe("Example: Description field when reading is rejected", () => {
    it(
      "should mark L007.32 as needsReview when invoice.lines.7.description is low confidence",
      async () => {
        // Modify the reading to set invoice.lines.7.description to low confidence
        const modifiedAnswer: ReadingAnswer = {
          ...bundleAnswer,
          fields: bundleAnswer.fields.map((field) => {
            if (field.field === "invoice.lines.7.description") {
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

        // Find the L007.32 field
        let field32: any = null;
        for (const line of draft.lines) {
          if (line.lineNumber === "007") {
            field32 = line.fields.find((f) => f.id === "L007.32");
            break;
          }
        }

        // Verify field status and content
        expect(field32).toBeDefined();
        expect(field32.status).toBe("needsReview");
        expect(field32.value).toBeNull();
        expect(field32.reason).toContain("invoice line 7");

        // Verify it appears in draft.needsReview
        const needsReviewEntry = draft.needsReview.find((item) => item.fieldId === "L007.32");
        expect(needsReviewEntry).toBeDefined();
        expect(needsReviewEntry?.status).toBe("needsReview");
        expect(needsReviewEntry?.reason).toContain("invoice line 7");
      },
      60000,
    );
  });

  describe("Feature: document-intake, Property 31", () => {
    it(
      "Draft Lines Only For Invoice Lines On The Documents (Validates: Requirements 6.1)",
      async () => {
        // Test k from 1 to 8: remove all readings for invoice lines after k
        for (let k = 1; k <= 8; k++) {
          const modifiedAnswer: ReadingAnswer = {
            ...bundleAnswer,
            fields: bundleAnswer.fields.filter((field) => {
              // Remove all fields for invoice lines > k
              const match = field.field.match(/^invoice\.lines\.(\d+)\./);
              if (!match) return true; // Keep non-invoice-line fields
              const lineNum = parseInt(match[1], 10);
              return lineNum <= k;
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

          // Collect all invoice line numbers referenced in draft lines
          const invoiceLinesInDraft = new Set<number>();
          for (const line of draft.lines) {
            for (const invLine of line.invoiceLines) {
              invoiceLinesInDraft.add(invLine);
            }
          }

          // Convert to sorted array
          const invoiceLinesArray = Array.from(invoiceLinesInDraft).sort((a, b) => a - b);

          // For k=8 (unmodified), draft should equal original
          if (k === 8) {
            const originalVerified = verifyReadings(bundleAnswer, bundleDocuments);
            const originalDraft = buildDraft({
              bundle: "lantern-hollow",
              reader: bundleAnswer.reader,
              readings: originalVerified,
              hts: bundleHts,
            });
            expect(draft).toEqual(originalDraft);
          }

          // Union of invoiceLinesInDraft should equal [1..k]
          const expectedLines = Array.from({ length: k }, (_, i) => i + 1);
          expect(invoiceLinesArray).toEqual(expectedLines);

          // No draft line should list an invoice line above k
          for (const line of draft.lines) {
            for (const invLine of line.invoiceLines) {
              expect(invLine).toBeLessThanOrEqual(k);
            }
          }
        }
      },
      60000,
    );

    it(
      "should include low-confidence readings (e.g., line 2 all rejected) when line is on documents",
      async () => {
        // Set all fields of invoice line 2 to low confidence
        const modifiedAnswer: ReadingAnswer = {
          ...bundleAnswer,
          fields: bundleAnswer.fields.map((field) => {
            if (field.field.startsWith("invoice.lines.2.")) {
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

        // Collect all invoice line numbers referenced in draft lines
        const invoiceLinesInDraft = new Set<number>();
        for (const line of draft.lines) {
          for (const invLine of line.invoiceLines) {
            invoiceLinesInDraft.add(invLine);
          }
        }

        // Invoice line 2 should still be in the draft (all readings were rejected, but line is on documents)
        expect(invoiceLinesInDraft.has(2)).toBe(true);
      },
      60000,
    );
  });

  describe("Feature: document-intake, Property 32", () => {
    it(
      "Gross Weight Does Not Change The Quantity Check (Validates: Requirements 5.1)",
      async () => {
        // Test n from 1 to 8: set grossKg to low confidence for line n only
        for (let n = 1; n <= 8; n++) {
          const modifiedAnswer: ReadingAnswer = {
            ...bundleAnswer,
            fields: bundleAnswer.fields.map((field) => {
              if (field.field === `packingList.lines.${n}.grossKg`) {
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

          // Build unmodified draft for comparison
          const originalVerified = verifyReadings(bundleAnswer, bundleDocuments);
          const originalDraft = buildDraft({
            bundle: "lantern-hollow",
            reader: bundleAnswer.reader,
            readings: originalVerified,
            hts: bundleHts,
          });

          // Compare every field ending with ".35" (net quantity)
          for (const line of draft.lines) {
            for (const field of line.fields) {
              if (field.id.endsWith(".35")) {
                const originalField = originalDraft.lines
                  .find((l) => l.lineNumber === line.lineNumber)
                  ?.fields.find((f) => f.id === field.id);

                if (originalField) {
                  expect(field.status).toBe(originalField.status);
                  expect(field.value).toBe(originalField.value);
                  expect(field.reason).toBe(originalField.reason);
                  // Ensure no reason says "the packing list says 0 PCS" due to rejected gross weight
                  if (field.reason) {
                    expect(field.reason).not.toContain("the packing list says 0 PCS");
                  }
                }
              }
            }
          }
        }
      },
      60000,
    );
  });

  describe("Feature: document-intake, Property 35: Image Values Wait for a Person (Validates: Requirements 18.1, 18.3, 26.1, 26.2, 26.3)", () => {
    it(
      "Property 35: Image Values Wait for a Person",
      async () => {
        // Use fast-check to generate random booleans for each verified reading
        const fc = await import("fast-check");
        fc.assert(
          fc.property(
            fc.array(fc.boolean(), { minLength: 0, maxLength: bundleAnswer.fields.length }),
            (imageFlags) => {
              // Generate one boolean per verified reading
              const originalVerified = verifyReadings(bundleAnswer, bundleDocuments);
              const plain = buildDraft({
                bundle: "lantern-hollow",
                reader: bundleAnswer.reader,
                readings: originalVerified,
                hts: bundleHts,
              });

              // Build readings with image origins based on flags
              const imageFlagMap = new Map<number, boolean>();
              let flagIndex = 0;
              const readingsWithOrigin: VerifiedReading[] = originalVerified.map((r) => {
                const flag = imageFlags[flagIndex % imageFlags.length];
                flagIndex++;
                if (flag && r.status === "accepted") {
                  return { ...r, origin: "imageTranscript" as const };
                }
                return r;
              });

              // Build img draft with image origins
              const img = buildDraft({
                bundle: "lantern-hollow",
                reader: bundleAnswer.reader,
                readings: readingsWithOrigin,
                hts: bundleHts,
              });

              // No field of img should have status "copied" or "computed" with a document source with origin "imageTranscript"
              for (const field of [...img.header, ...img.totals, ...img.lines.flatMap((l) => l.fields)]) {
                if (field.status === "copied" || field.status === "computed") {
                  for (const source of field.sources) {
                    if (source.kind === "document" && source.origin === "imageTranscript") {
                      throw new Error(`Field ${field.id} has status "${field.status}" but document source with origin "imageTranscript"`);
                    }
                  }
                }
              }

              // For every field id: check status/value/reason/rule consistency
              for (const plainField of [...plain.header, ...plain.totals, ...plain.lines.flatMap((l) => l.fields)]) {
                const imgField = [
                  ...img.header,
                  ...img.totals,
                  ...img.lines.flatMap((l) => l.fields),
                ].find((f) => f.id === plainField.id);

                if (!imgField) continue;

                // If plain field was copied and img field has an image document source, check the transformation
                const imgHasImageSource = imgField.sources.some(
                  (s) => s.kind === "document" && s.origin === "imageTranscript"
                );

                if (plainField.status === "copied" && imgHasImageSource) {
                  // img field must have status "needsReview" and reason IMAGE_REVIEW_REASON
                  expect(imgField.status).toBe("needsReview");
                  expect(imgField.reason).toBe(IMAGE_REVIEW_REASON);
                  expect(imgField.value).toBe(plainField.value);
                  expect(imgField.rule).toBe(plainField.rule);
                } else if (plainField.status === "computed" && imgHasImageSource) {
                  // img field must have status "needsReview" and reason IMAGE_COMPUTED_REVIEW_REASON
                  expect(imgField.status).toBe("needsReview");
                  expect(imgField.reason).toBe(IMAGE_COMPUTED_REVIEW_REASON);
                  expect(imgField.value).toBe(plainField.value);
                  expect(imgField.rule).toBe(plainField.rule);
                } else if (imgField.reason && imgField.reason.endsWith(IMAGE_WAITING_SUFFIX)) {
                  // Field waits on image-waiting dependencies
                  expect(imgField.status).toBe("needsReview");
                  expect(plainField.status === "computed" || plainField.status === "copied").toBe(true);
                  expect(imgField.value).toBe(plainField.value);
                  expect(imgField.rule).toBe(plainField.rule);
                } else {
                  // Skip fields that have IMAGE_REVIEW_REASON or IMAGE_COMPUTED_REVIEW_REASON with null value
                  if ((imgField.reason === IMAGE_REVIEW_REASON || imgField.reason === IMAGE_COMPUTED_REVIEW_REASON) && imgField.value === null) {
                    continue;
                  }
                  // Otherwise, expect imgField status, value, reason and rule to equal plainField's
                  expect(imgField.status).toBe(plainField.status);
                  expect(imgField.value).toBe(plainField.value);
                  expect(imgField.reason).toBe(plainField.reason);
                  expect(imgField.rule).toBe(plainField.rule);
                }
              }

              // Build overrides: for each image field with reason === IMAGE_REVIEW_REASON or IMAGE_COMPUTED_REVIEW_REASON, apply confirmation
              const overrides = [
                ...img.header,
                ...img.totals,
                ...img.lines.flatMap((l) => l.fields),
              ]
                .filter((f) => (f.reason === IMAGE_REVIEW_REASON || f.reason === IMAGE_COMPUTED_REVIEW_REASON) && f.value !== null)
                .map((f) => ({ fieldId: f.id, value: f.value as string }));

              const conf = buildDraft({
                bundle: "lantern-hollow",
                reader: bundleAnswer.reader,
                readings: readingsWithOrigin,
                hts: bundleHts,
                overrides,
              });

              // Check confirmed fields
              for (const confField of [...conf.header, ...conf.totals, ...conf.lines.flatMap((l) => l.fields)]) {
                const imgField = [
                  ...img.header,
                  ...img.totals,
                  ...img.lines.flatMap((l) => l.fields),
                ].find((f) => f.id === confField.id);

                const plainField = [...plain.header, ...plain.totals, ...plain.lines.flatMap((l) => l.fields)].find(
                  (f) => f.id === confField.id
                );

                if (!imgField || !plainField) continue;

                if ((imgField.reason === IMAGE_REVIEW_REASON || imgField.reason === IMAGE_COMPUTED_REVIEW_REASON) && imgField.value !== null) {
                  // This field was confirmed; it should have:
                  // - status "copied" (for IMAGE_REVIEW_REASON) or "computed" (for IMAGE_COMPUTED_REVIEW_REASON)
                  // - same value, rule and sources as in img
                  // - note CONFIRMED_NOTE
                  // - same status, value, reason and rule as in plain
                  const expectedStatus = imgField.reason === IMAGE_REVIEW_REASON ? "copied" : "computed";
                  expect(confField.status).toBe(expectedStatus);
                  expect(confField.value).toBe(imgField.value);
                  expect(confField.rule).toBe(imgField.rule);
                  expect(confField.sources).toEqual(imgField.sources);
                  expect(confField.note).toBe(CONFIRMED_NOTE);

                  expect(confField.status).toBe(plainField.status);
                  expect(confField.value).toBe(plainField.value);
                  expect(confField.reason).toBe(plainField.reason);
                  expect(confField.rule).toBe(plainField.rule);
                } else if (
                  (imgField.reason === IMAGE_REVIEW_REASON || imgField.reason === IMAGE_COMPUTED_REVIEW_REASON) &&
                  imgField.value === null
                ) {
                  // An image value without a value cannot be confirmed with its own value; nothing to compare.
                } else {
                  // Confirming every image value clears the fields that waited on them: the draft is the plain one again.
                  expect(confField.status).toBe(plainField.status);
                  expect(confField.value).toBe(plainField.value);
                  expect(confField.reason).toBe(plainField.reason);
                  expect(confField.rule).toBe(plainField.rule);
                }
              }
            },
          ),
          { numRuns: 25 },
        );
      },
      120000,
    );
  });

  describe("Feature: document-intake, Property 36: A Missing Invoice Line Is Flagged (Validates: Requirements 19.1, 19.3)", () => {
    it(
      "Property 36: A Missing Invoice Line Is Flagged",
      async () => {
        // Test 1: unmodified sample should have no CHK.INVOICE field and should work with invoiceLineCount: 8
        const originalVerified = verifyReadings(bundleAnswer, bundleDocuments);
        const originalDraft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: originalVerified,
          hts: bundleHts,
          invoiceLineCount: 8,
        });

        expect(originalDraft.needsReview.find((item) => item.fieldId === "CHK.INVOICE")).toBeUndefined();

        // Test 2: for every n from 1 to 8, remove invoice line n and check CHK.INVOICE
        for (let n = 1; n <= 8; n++) {
          const modifiedAnswer: ReadingAnswer = {
            ...bundleAnswer,
            fields: bundleAnswer.fields.filter((field) => {
              // Remove all fields for invoice line n
              if (field.field.startsWith(`invoice.lines.${n}.`)) return false;
              return true;
            }),
          };

          const verified = verifyReadings(modifiedAnswer, bundleDocuments);
          const draft = buildDraft({
            bundle: "lantern-hollow",
            reader: bundleAnswer.reader,
            readings: verified,
            hts: bundleHts,
            invoiceLineCount: 8,
          });

          const chkField = draft.needsReview.find((item) => item.fieldId === "CHK.INVOICE");
          expect(chkField).toBeDefined();
          expect(chkField?.reason).toContain("A line may be missing");
        }

        // Test 3: remove invoice.subtotal
        const noSubtotalAnswer: ReadingAnswer = {
          ...bundleAnswer,
          fields: bundleAnswer.fields.filter((field) => field.field !== "invoice.subtotal"),
        };

        const noSubtotalVerified = verifyReadings(noSubtotalAnswer, bundleDocuments);
        const noSubtotalDraft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: noSubtotalVerified,
          hts: bundleHts,
          invoiceLineCount: 8,
        });

        const noSubtotalChk = noSubtotalDraft.needsReview.find((item) => item.fieldId === "CHK.INVOICE");
        expect(noSubtotalChk).toBeDefined();
        expect(noSubtotalChk?.reason).toContain("No invoice subtotal was read");

        // Test 4: invoiceLineCount 7 (one less than actual 8)
        const countMismatchDraft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: originalVerified,
          hts: bundleHts,
          invoiceLineCount: 7,
        });

        const countMismatchChk = countMismatchDraft.needsReview.find((item) => item.fieldId === "CHK.INVOICE");
        expect(countMismatchChk).toBeDefined();
        expect(countMismatchChk?.reason).toContain("The invoice shows 7 item lines, but the draft has readings for 8");

        // Test 5: invoiceLineCount 12 (more than 8, should mention "reads only the first 8")
        const count12Draft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: originalVerified,
          hts: bundleHts,
          invoiceLineCount: 12,
        });

        const count12Chk = count12Draft.needsReview.find((item) => item.fieldId === "CHK.INVOICE");
        expect(count12Chk).toBeDefined();
        expect(count12Chk?.reason).toContain("The invoice shows 12 item lines");
        expect(count12Chk?.reason).toContain("this draft reads only the first 8");

        // Test 6: invoiceLineCount null should have no CHK.INVOICE
        const nullCountDraft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: originalVerified,
          hts: bundleHts,
          invoiceLineCount: null,
        });

        expect(nullCountDraft.needsReview.find((item) => item.fieldId === "CHK.INVOICE")).toBeUndefined();

        // Test 7: a person value for CHK.INVOICE
        // Build draft from answer without invoice.subtotal (so "CHK.INVOICE" exists in needsReview)
        // plus override { fieldId: "CHK.INVOICE", value: "Checked against the invoice" }
        const noSubtotalAnswerForPerson: ReadingAnswer = {
          ...bundleAnswer,
          fields: bundleAnswer.fields.filter((field) => field.field !== "invoice.subtotal"),
        };

        const noSubtotalVerifiedForPerson = verifyReadings(noSubtotalAnswerForPerson, bundleDocuments);
        const personValueDraft = buildDraft({
          bundle: "lantern-hollow",
          reader: bundleAnswer.reader,
          readings: noSubtotalVerifiedForPerson,
          hts: bundleHts,
          invoiceLineCount: 8,
          overrides: [{ fieldId: "CHK.INVOICE", value: "Checked against the invoice" }],
        });

        // CHK.INVOICE should not be in needsReview (it was filled by person)
        const personChkField = personValueDraft.needsReview.find((item) => item.fieldId === "CHK.INVOICE");
        expect(personChkField).toBeUndefined();

        // Find CHK.INVOICE in all fields
        const allFieldsList = [...personValueDraft.header, ...personValueDraft.totals, ...personValueDraft.lines.flatMap((l) => l.fields)];
        const chkInvoiceField = allFieldsList.find((f) => f.id === "CHK.INVOICE");
        expect(chkInvoiceField).toBeDefined();
        expect(chkInvoiceField?.status).toBe("personEdited");
        expect(chkInvoiceField?.value).toBe("Checked against the invoice");
      },
      120000,
    );
  });
});
