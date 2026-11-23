import { describe, it, expect, beforeAll } from "vitest";
import { verifyReadings } from "./reading";
import type { VerifiedReading, ReadingAnswer } from "./reading";
import { buildDraft, IMAGE_COMPUTED_REVIEW_REASON, IMAGE_REVIEW_REASON, allFields, CONFIRMED_NOTE } from "./draft";
import type { DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];
let bundleHts: HtsTable;
let htsNumbers: string[];
let lineIds: string[];

describe("Draft: Recompute Wait and Image Source Tracking", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
    bundleHts = bundle.hts;

    // Extract HTS numbers in the form shown in draft (e.g. "6913.90.5000" from "6913.90.50.00")
    htsNumbers = bundleHts.rows
      .filter((r) => /^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(r.htsno))
      .map((r) => r.htsno.slice(0, 10) + r.htsno.slice(11));

    // Extract line IDs of all-image draft without overrides whose field id matches /^L\d{3}\.33A$/
    const imgDocuments = bundleDocuments.map((doc) => ({
      ...doc,
      pages: doc.pages.map((p) => ({ ...p, origin: "imageTranscript" as const })),
    }));
    const readings = verifyReadings(bundleAnswer, imgDocuments);
    const imageDraft = buildDraft({
      bundle: "lantern-hollow",
      reader: bundleAnswer.reader,
      readings,
      hts: bundleHts,
      overrides: [],
    });
    const imageFields = allFields(imageDraft);
    lineIds = Array.from(
      new Set(
        imageFields
          .filter((f) => /^L\d{3}\.33A$/.test(f.id))
          .map((f) => f.id.split(".")[0])
      )
    );
  });

  /**
   * Helper: get the bundle documents with every page given origin: "imageTranscript"
   */
  const imgDocs = (docs: DocumentText[]): DocumentText[] =>
    docs.map((doc) => ({
      ...doc,
      pages: doc.pages.map((p) => ({ ...p, origin: "imageTranscript" as const })),
    }));

  /**
   * Helper: build a draft with the helper signature
   */
  const build = (docs: DocumentText[], overrides: Array<{ fieldId: string; value: string }>) => {
    const readings = verifyReadings(bundleAnswer, docs);
    return buildDraft({
      bundle: "lantern-hollow",
      reader: bundleAnswer.reader,
      readings,
      hts: bundleHts,
      overrides,
    });
  };

  /**
   * Helper: return fields with status "computed" or "copied" that have a document source
   * with origin "imageTranscript" and a note other than CONFIRMED_NOTE.
   * These are fields that leak unchecked image values.
   */
  const leaks = (draft: any): any[] => {
    const fields = allFields(draft);
    return fields.filter((f) => {
      if (f.status !== "computed" && f.status !== "copied") return false;
      if (!f.sources.some((s) => s.kind === "document" && s.origin === "imageTranscript")) return false;
      if (f.note === CONFIRMED_NOTE) return false;
      return true;
    });
  };

  describe("Feature: document-intake, Requirement 30: A Value Computed Again After a Person's Edit Still Waits", () => {
    it("Example 30.1: All image pages, override L001.33A, L001.35 has needsReview with IMAGE_COMPUTED_REVIEW_REASON", async () => {
      const imgDocuments = imgDocs(bundleDocuments);
      // Change L001.33A to a different HTS
      const draft = build(imgDocuments, [{ fieldId: "L001.33A", value: "7013.99.3500" }]);

      const fields = allFields(draft);
      const l001_35 = fields.find((f) => f.id === "L001.35");

      expect(l001_35).toBeDefined();
      expect(l001_35?.status).toBe("needsReview");
      expect(l001_35?.reason).toBe(IMAGE_COMPUTED_REVIEW_REASON);
      // Value should be 216
      expect(l001_35?.value).toBe("216");

      // No leaked unchecked image values
      expect(leaks(draft)).toHaveLength(0);
    });

    it("Example 30.2: All image pages, override L001.33A then L001.35, L001.35 is not needsReview", async () => {
      const imgDocuments = imgDocs(bundleDocuments);
      const draft = build(imgDocuments, [
        { fieldId: "L001.33A", value: "7013.99.3500" },
        { fieldId: "L001.35", value: "216" },
      ]);

      const fields = allFields(draft);
      const l001_35 = fields.find((f) => f.id === "L001.35");

      expect(l001_35).toBeDefined();
      expect(l001_35?.status).not.toBe("needsReview");
      expect(l001_35?.value).toBe("216");
    });

    it("Example 30.3: Text pages (unchanged from bundle), override L001.33A, no IMAGE_REVIEW_REASON", async () => {
      // Use the bundle documents as loaded (no image transcripts)
      const draft = build(bundleDocuments, [{ fieldId: "L001.33A", value: "7013.99.3500" }]);

      const fields = allFields(draft);

      // No field should have IMAGE_REVIEW_REASON or IMAGE_COMPUTED_REVIEW_REASON
      for (const f of fields) {
        expect(f.reason).not.toBe(IMAGE_REVIEW_REASON);
        expect(f.reason).not.toBe(IMAGE_COMPUTED_REVIEW_REASON);
      }
    });

    it("Example 30.4: All image pages, no overrides, then confirm each image-waiting field until stable (Property 35 holds)", async () => {
      const imgDocuments = imgDocs(bundleDocuments);

      // Build text-page draft as reference
      const textDraft = build(bundleDocuments, []);
      const textFields = allFields(textDraft);

      // Start with image draft, no overrides
      let imageDraft = build(imgDocuments, []);
      let imageFields = allFields(imageDraft);

      // Identify image-waiting fields (those with IMAGE_REVIEW_REASON or IMAGE_COMPUTED_REVIEW_REASON)
      let imageWaitingFields = imageFields.filter(
        (f) => f.reason === IMAGE_REVIEW_REASON || f.reason === IMAGE_COMPUTED_REVIEW_REASON
      );

      let round = 0;
      while (imageWaitingFields.length > 0 && round < 5) {
        round++;

        // Build overrides for every image-waiting field: apply its own value
        const overrides = imageWaitingFields.map((f) => ({
          fieldId: f.id,
          value: f.value!,
        }));

        // Rebuild with overrides
        imageDraft = build(imgDocuments, overrides);
        imageFields = allFields(imageDraft);

        // Find remaining image-waiting fields
        imageWaitingFields = imageFields.filter(
          (f) => f.reason === IMAGE_REVIEW_REASON || f.reason === IMAGE_COMPUTED_REVIEW_REASON
        );
      }

      // After confirming all image-waiting fields, the image-page draft should match the text-page draft
      // (same status and value for each field)
      for (const textField of textFields) {
        const imageField = imageFields.find((f) => f.id === textField.id);
        expect(imageField).toBeDefined();
        expect(imageField?.status).toBe(textField.status);
        expect(imageField?.value).toBe(textField.value);
      }
    });
  });

  describe("Feature: document-intake, Property 47: An Edit Never Makes an Unchecked Image Value Final (Validates: Requirements 30.1, 30.3)", () => {
    it(
      "Property 47: An Edit Never Makes an Unchecked Image Value Final",
      async () => {
        const fc = await import("fast-check");

        fc.assert(
          fc.property(
            fc.tuple(
              fc.constantFrom(...lineIds),
              fc.oneof(
                // Edit L<nnn>.33A to an HTS number from the table
                fc.tuple(fc.constant("33A"), fc.constantFrom(...htsNumbers)),
                // Edit L<nnn>.10 to a country code
                fc.tuple(fc.constant("10"), fc.constantFrom("PT", "CN", "DE", "CZ", "VN", "MX")),
                // Edit L<nnn>.36A to a dollar amount string (1 to 100000)
                fc.tuple(fc.constant("36A"), fc.integer({ min: 1, max: 100000 }).map((n) => n.toString()))
              )
            ),
            ([lineId, [editField, editValue]]: [string, [string, string]]) => {
              const imgDocuments = imgDocs(bundleDocuments);
              const imageDraft = build(imgDocuments, []);
              const imageFields = allFields(imageDraft);

              const fieldIdToEdit = `${lineId}.${editField}`;
              const currentField = imageFields.find((f) => f.id === fieldIdToEdit);

              if (!currentField || currentField.value === editValue) {
                // Skip if field not found or value would not change
                return;
              }

              // Apply the edit to the image-page draft
              const editedImageDraft = build(imgDocuments, [{ fieldId: fieldIdToEdit, value: editValue }]);
              const editedImageFields = allFields(editedImageDraft);

              // Apply the same edit to the text-page draft
              const editedTextDraft = build(bundleDocuments, [{ fieldId: fieldIdToEdit, value: editValue }]);
              const editedTextFields = allFields(editedTextDraft);

              // Check 1: image-page draft has no leaked unchecked image values
              const imageLeak = leaks(editedImageDraft);
              if (imageLeak.length > 0) {
                throw new Error(
                  `Image draft leaked unchecked value: ${imageLeak.map((f) => f.id).join(", ")}`
                );
              }

              // Check 2: text-page draft has no IMAGE_REVIEW_REASON or IMAGE_COMPUTED_REVIEW_REASON
              for (const f of editedTextFields) {
                if (f.reason === IMAGE_REVIEW_REASON || f.reason === IMAGE_COMPUTED_REVIEW_REASON) {
                  throw new Error(`Text draft field ${f.id} unexpectedly has image reason: ${f.reason}`);
                }
              }
            }
          ),
          { numRuns: 50 }
        );
      },
      120000
    );
  });
});
