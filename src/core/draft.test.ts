import { describe, it, expect, beforeAll } from "vitest";
import { verifyReadings } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import { buildDraft } from "./draft";
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
});
