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
});
