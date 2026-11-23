import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { verifyReadings } from "./reading";
import type { VerifiedReading, ReadingAnswer } from "./reading";
import { buildDraft, IMAGE_COMPUTED_REVIEW_REASON, IMAGE_REVIEW_REASON, allFields, CONFIRMED_NOTE } from "./draft";
import type { DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";
import { lookupHts } from "./hts";
import { computeDuty } from "../rules";
import { formatCents } from "./parse";

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];
let bundleHts: HtsTable;

describe("Draft: Edit Rules (Requirements 31 and 32)", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
    bundleHts = bundle.hts;
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
   * Helper: build a draft and optionally mutate verified readings before building
   */
  const build = (
    docs: DocumentText[],
    overrides: Array<{ fieldId: string; value: string }>,
    mutate?: (readings: VerifiedReading[]) => void
  ) => {
    const readings = verifyReadings(bundleAnswer, docs);
    if (mutate) mutate(readings);
    return buildDraft({
      bundle: "lantern-hollow",
      reader: bundleAnswer.reader,
      readings,
      hts: bundleHts,
      invoiceLineCount: bundleAnswer.invoiceLineCount ?? null,
      overrides,
    });
  };

  /**
   * Helper: pick a field by ID from the draft
   */
  const pick = (draft: ReturnType<typeof buildDraft>, id: string) => {
    const fields = allFields(draft);
    return fields.find((f) => f.id === id);
  };

  /**
   * Helper: mutate function that sets origin="imageTranscript" on readings for a specific field
   */
  const onlyImage = (fieldName: string) => (readings: VerifiedReading[]) => {
    for (const r of readings) {
      if (r.field === fieldName && r.status === "accepted") {
        r.origin = "imageTranscript";
      }
    }
  };

  describe("Requirement 31: An Edited HTS Number Derives the Line's Quantity by the First Rule", () => {
    it("Example 31.1: Text pages, no overrides: L003.35 waits with quantity difference reason", () => {
      const draft = build(bundleDocuments, []);
      const l003_35 = pick(draft, "L003.35");

      expect(l003_35).toBeDefined();
      expect(l003_35?.status).toBe("needsReview");
      expect(l003_35?.reason).toBeDefined();
      // Verify it contains "240" and "216" (the two quantities from invoice and packing list)
      const diff = l003_35?.reason!;
      expect(diff).toMatch(/240/);
      expect(diff).toMatch(/216/);

      // For each HTS number, test that editing L003.33A keeps it waiting with the same reason
      const htsNumbers = ["9505.90.4000", "9505.90.6000", "3926.40.0090"];
      for (const htsNum of htsNumbers) {
        const draftEdited = build(bundleDocuments, [{ fieldId: "L003.33A", value: htsNum }]);
        const l003_35_edited = pick(draftEdited, "L003.35");

        expect(l003_35_edited?.status).toBe("needsReview");
        expect(l003_35_edited?.value).toBeNull();
        expect(l003_35_edited?.reason).toBe(diff);

        const lookup = lookupHts(bundleHts, htsNum);
        expect(lookup.found).toBe(true);
        if (!lookup.found) return;
        expect(l003_35_edited?.unit).toBe(lookup.unit);
      }
    });

    it("Example 31.2: Text pages, L001.33A edited to 7013.99.3500: L001.35 becomes computed with correct unit", () => {
      const draftBase = build(bundleDocuments, []);
      const l001_35_base = pick(draftBase, "L001.35");
      const baseSources = l001_35_base?.sources || [];

      const draftEdited = build(bundleDocuments, [{ fieldId: "L001.33A", value: "7013.99.3500" }]);
      const l001_35 = pick(draftEdited, "L001.35");

      expect(l001_35?.status).toBe("computed");
      expect(l001_35?.value).toBe("216");
      expect(l001_35?.unit).toBe("No.");
      // Sources should match the base draft (same as without the edit)
      expect(l001_35?.sources).toEqual(baseSources);

      // Also test with 6913.90.5000 (the original number)
      const draftEdited2 = build(bundleDocuments, [{ fieldId: "L001.33A", value: "6913.90.5000" }]);
      const l001_35_2 = pick(draftEdited2, "L001.35");
      expect(l001_35_2?.status).toBe("computed");
      expect(l001_35_2?.value).toBe("18");
      expect(l001_35_2?.unit).toBe("Dz Pcs");
    });

    it("Example 31.3: Text pages, person enters L001.35 then edits L001.33A: unit change triggers needsReview", () => {
      // Case 1: Edit L001.33A to 7013.99.3500 after entering 18 in L001.35
      const draft1 = build(bundleDocuments, [
        { fieldId: "L001.35", value: "18" },
        { fieldId: "L001.33A", value: "7013.99.3500" },
      ]);
      const l001_35_1 = pick(draft1, "L001.35");
      expect(l001_35_1?.status).toBe("needsReview");
      expect(l001_35_1?.value).toBeNull();
      expect(l001_35_1?.unit).toBe("No.");
      expect(l001_35_1?.reason).toBe(
        "L001.33A changed the unit from Dz Pcs to No.; the quantity a person entered (18 Dz Pcs) is in the old unit. A person enters the quantity in No."
      );

      // Case 2: Edit to 6913.90.5000 (same unit) with value 20
      const draft2 = build(bundleDocuments, [
        { fieldId: "L001.35", value: "20" },
        { fieldId: "L001.33A", value: "6913.90.5000" },
      ]);
      const l001_35_2 = pick(draft2, "L001.35");
      expect(l001_35_2?.status).toBe("personEdited");
      expect(l001_35_2?.value).toBe("20");
      expect(l001_35_2?.unit).toBe("Dz Pcs");

      // Case 3: Edit 33A first (order matters), then enter 35
      const draft3 = build(bundleDocuments, [
        { fieldId: "L001.33A", value: "7013.99.3500" },
        { fieldId: "L001.35", value: "216" },
      ]);
      const l001_35_3 = pick(draft3, "L001.35");
      expect(l001_35_3?.status).toBe("personEdited");
      expect(l001_35_3?.value).toBe("216");
      expect(l001_35_3?.unit).toBe("No.");
    });

    it("Example 31.4: All image pages, L001.33A edited: L001.35 waits with IMAGE_COMPUTED_REVIEW_REASON", () => {
      const imgDocuments = imgDocs(bundleDocuments);
      const draftEdited = build(imgDocuments, [{ fieldId: "L001.33A", value: "7013.99.3500" }]);
      const l001_35 = pick(draftEdited, "L001.35");

      expect(l001_35?.status).toBe("needsReview");
      expect(l001_35?.value).toBe("216");
      expect(l001_35?.reason).toBe(IMAGE_COMPUTED_REVIEW_REASON);
    });

    it("Example 31.5: Text pages with demo answers: L006.35 is computed with value 300 No.", () => {
      const demoAnswers = JSON.parse(
        readFileSync(join(process.cwd(), "samples/lantern-hollow/overrides-demo.json"), "utf-8")
      );
      const overrides = demoAnswers.overrides;

      const draft = build(bundleDocuments, overrides);
      const l006_35 = pick(draft, "L006.35");

      expect(l006_35?.status).toBe("computed");
      expect(l006_35?.value).toBe("300");
      expect(l006_35?.unit).toBe("No.");
    });
  });

  describe("Requirement 32: A Value That Cannot Be Computed From What the Draft Has Now Waits", () => {
    it("Example 32.1: No invoice lines: B39 and B41 wait with no-lines reason", () => {
      // Create a mutated answer with no invoice line fields (keep packing list lines)
      const answerWithoutInvoiceLines: ReadingAnswer = {
        ...bundleAnswer,
        fields: bundleAnswer.fields.filter((f) => !f.field.startsWith("invoice.lines.")),
      };

      // Test with invoiceLineCount = bundleAnswer.invoiceLineCount
      {
        const draftNoLines = buildDraft({
          bundle: "lantern-hollow",
          reader: answerWithoutInvoiceLines.reader,
          readings: verifyReadings(answerWithoutInvoiceLines, bundleDocuments),
          hts: bundleHts,
          invoiceLineCount: bundleAnswer.invoiceLineCount ?? null,
          overrides: [],
        });

        const fields = allFields(draftNoLines);
        const b39 = fields.find((f) => f.id === "B39");
        const b41 = fields.find((f) => f.id === "B41");
        const feeMpf = fields.find((f) => f.id === "FEE.MPF");
        const b43 = fields.find((f) => f.id === "B43");
        const b44 = fields.find((f) => f.id === "B44");

        expect(b39?.status).toBe("needsReview");
        expect(b39?.value).toBeNull();
        expect(b39?.reason).toBe("No 7501 line was built because no invoice line was read. A person reads the invoice lines.");

        expect(b41?.status).toBe("needsReview");
        expect(b41?.value).toBeNull();
        expect(b41?.reason).toBe("No 7501 line was built because no invoice line was read. A person reads the invoice lines.");

        expect(feeMpf?.status).toBe("needsReview");
        expect(feeMpf?.value).toBeNull();

        expect(b43?.status).toBe("needsReview");
        expect(b43?.value).toBeNull();

        expect(b44?.status).toBe("needsReview");
        expect(b44?.value).toBeNull();

        // Also verify the draft has 0 lines
        expect(draftNoLines.lines.length).toBe(0);
      }

      // Test with invoiceLineCount = 8
      {
        const draftNoLines = buildDraft({
          bundle: "lantern-hollow",
          reader: answerWithoutInvoiceLines.reader,
          readings: verifyReadings(answerWithoutInvoiceLines, bundleDocuments),
          hts: bundleHts,
          invoiceLineCount: 8,
          overrides: [],
        });

        const fields = allFields(draftNoLines);
        const b39 = fields.find((f) => f.id === "B39");
        const b41 = fields.find((f) => f.id === "B41");
        const feeMpf = fields.find((f) => f.id === "FEE.MPF");
        const b43 = fields.find((f) => f.id === "B43");
        const b44 = fields.find((f) => f.id === "B44");

        expect(b39?.status).toBe("needsReview");
        expect(b39?.value).toBeNull();
        expect(b39?.reason).toBe("No 7501 line was built because no invoice line was read. A person reads the invoice lines.");

        expect(b41?.status).toBe("needsReview");
        expect(b41?.value).toBeNull();
        expect(b41?.reason).toBe("No 7501 line was built because no invoice line was read. A person reads the invoice lines.");

        expect(feeMpf?.status).toBe("needsReview");
        expect(feeMpf?.value).toBeNull();

        expect(b43?.status).toBe("needsReview");
        expect(b43?.value).toBeNull();

        expect(b44?.status).toBe("needsReview");
        expect(b44?.value).toBeNull();

        // Also verify the draft has 0 lines
        expect(draftNoLines.lines.length).toBe(0);
      }
    });

    it("Example 32.2: Text pages with L001.36A rejected: L001.38 waits for 36A", () => {
      const draft = build(bundleDocuments, [{ fieldId: "L001.36A", value: "540.50" }]);
      const l001_38 = pick(draft, "L001.38");
      const b41 = pick(draft, "B41");

      expect(l001_38?.status).toBe("needsReview");
      expect(l001_38?.value).toBeNull();
      expect(l001_38?.reason).toBe("Waiting on L001.36A.");

      expect(b41?.value).toBeNull();
    });

    it("Example 32.3: Text pages with L001.37A set to invalid rate: L001.38 waits with reason", () => {
      const draft = build(bundleDocuments, [{ fieldId: "L001.37A", value: "5 cents/kg" }]);
      const l001_38 = pick(draft, "L001.38");

      expect(l001_38?.status).toBe("needsReview");
      expect(l001_38?.value).toBeNull();
      expect(l001_38?.reason).toBeDefined();
      expect(l001_38?.reason!.length).toBeGreaterThan(0);
    });

    it("Example 32.4: All image pages, confirm all waiting fields except 36A, then set 36A: L001.38 waits for 36A", () => {
      const imgDocuments = imgDocs(bundleDocuments);
      let currentDraft = build(imgDocuments, []);
      let overrides: Array<{ fieldId: string; value: string }> = [];

      // Confirm fields with image review reasons, up to 5 rounds
      for (let round = 0; round < 5; round++) {
        const fields = allFields(currentDraft);
        const toConfirm = fields.filter(
          (f) =>
            f.id !== "L001.36A" &&
            f.status === "needsReview" &&
            f.value !== null &&
            (f.reason === IMAGE_REVIEW_REASON || f.reason === IMAGE_COMPUTED_REVIEW_REASON)
        );

        if (toConfirm.length === 0) break;

        for (const f of toConfirm) {
          overrides.push({ fieldId: f.id, value: f.value! });
        }

        currentDraft = build(imgDocuments, overrides);
      }

      // Now add the 36A override
      overrides.push({ fieldId: "L001.36A", value: "540.50" });
      const finalDraft = build(imgDocuments, overrides);
      const l001_38 = pick(finalDraft, "L001.38");

      expect(l001_38?.status).toBe("needsReview");
      expect(l001_38?.value).toBeNull();
      expect(l001_38?.reason).toBe("Waiting on L001.36A.");
    });

    it("Example 32.5: All image pages, L001.33A = 7013.99.3500: L001.38 is computed with duty and waits on currency", () => {
      const imgDocuments = imgDocs(bundleDocuments);
      const draft = build(imgDocuments, [{ fieldId: "L001.33A", value: "7013.99.3500" }]);
      const l001_38 = pick(draft, "L001.38");

      expect(l001_38?.status).toBe("needsReview");
      expect(l001_38?.value).toBe("59.40");
      expect(l001_38?.reason).toBeDefined();
      expect(l001_38?.reason!.startsWith("Waiting on")).toBe(true);
      expect(l001_38?.reason!).toContain("L001.36A");
    });

    it("Example 32.6: Text pages with onlyImage(invoice.currency): 36A fields wait for currency from image", () => {
      const draft = build(bundleDocuments, [], onlyImage("invoice.currency"));
      const draftBase = build(bundleDocuments, []);

      const fields = allFields(draft);
      const fieldsBase = allFields(draftBase);

      // Find all 36A fields that are computed in base draft
      for (const baseField of fieldsBase) {
        if (baseField.id.match(/^L\d{3}\.36A$/) && baseField.status === "computed") {
          const editedField = fields.find((f) => f.id === baseField.id);

          expect(editedField?.status).toBe("needsReview");
          expect(editedField?.reason).toBe(IMAGE_COMPUTED_REVIEW_REASON);

          // Verify it has a source with the currency reading
          const currencySource = editedField?.sources.find(
            (s) =>
              s.kind === "document" &&
              s.readingField === "invoice.currency" &&
              s.origin === "imageTranscript"
          );
          expect(currencySource).toBeDefined();
        }
      }
    });

    it("Example 32.6b: Text pages with onlyImage(packingList.totalGrossKg): 34A fields wait", () => {
      const draft = build(bundleDocuments, [], onlyImage("packingList.totalGrossKg"));
      const draftBase = build(bundleDocuments, []);

      const fields = allFields(draft);
      const fieldsBase = allFields(draftBase);

      // Find all 34A fields that are computed in base draft
      for (const baseField of fieldsBase) {
        if (baseField.id.match(/^L\d{3}\.34A$/) && baseField.status === "computed") {
          const editedField = fields.find((f) => f.id === baseField.id);

          expect(editedField?.status).toBe("needsReview");
          expect(editedField?.reason).toBe(IMAGE_COMPUTED_REVIEW_REASON);

          const grossKgSource = editedField?.sources.find(
            (s) =>
              s.kind === "document" &&
              s.readingField === "packingList.totalGrossKg" &&
              s.origin === "imageTranscript"
          );
          expect(grossKgSource).toBeDefined();
        }
      }
    });

    it("Example 32.6c: Text pages with onlyImage(invoice.lines.1.unit): L001.35 waits for unit", () => {
      const draft = build(bundleDocuments, [], onlyImage("invoice.lines.1.unit"));
      const draftBase = build(bundleDocuments, []);

      const fields = allFields(draft);
      const fieldsBase = allFields(draftBase);

      const baseL001_35 = fieldsBase.find((f) => f.id === "L001.35");
      if (baseL001_35?.status === "computed") {
        const editedL001_35 = fields.find((f) => f.id === "L001.35");

        expect(editedL001_35?.status).toBe("needsReview");
        expect(editedL001_35?.reason).toBe(IMAGE_COMPUTED_REVIEW_REASON);

        const unitSource = editedL001_35?.sources.find(
          (s) =>
            s.kind === "document" &&
            s.readingField === "invoice.lines.1.unit" &&
            s.origin === "imageTranscript"
        );
        expect(unitSource).toBeDefined();
      }
    });

    it("Example 32.7: Text pages without overrides: sources of 36A, 34A, 35 are unchanged", () => {
      const draft = build(bundleDocuments, []);
      const fields = allFields(draft);

      // Verify that no 36A, 34A or 35 field has a document source with these reading fields
      for (const field of fields) {
        if (field.id.match(/\.(36A|34A|35)$/)) {
          for (const source of field.sources) {
            if (source.kind === "document") {
              const rf = source.readingField;
              expect(rf).not.toBe("invoice.currency");
              expect(rf).not.toBe("packingList.totalGrossKg");
              expect(rf).not.toMatch(/\.unit$/);
            }
          }
        }
      }
    });
  });

  describe("Feature: document-intake, Property 48: An Edited HTS Number Keeps the Quantity Rule (Validates: Requirements 31.1, 31.2, 31.4)", () => {
    it(
      "Property 48: An Edited HTS Number Keeps the Quantity Rule",
      async () => {
        const fc = await import("fast-check");

        const htsNumbers = ["6913.90.5000", "7013.99.3500", "7013.99.5090", "9405.50.4000", "9505.90.4000", "9505.90.6000", "3926.40.0090"];

        const textDraft = build(bundleDocuments, []);
        const textFields = allFields(textDraft);

        // Get line IDs for lines that exist in text draft
        const lineIds = Array.from(
          new Set(
            textFields
              .filter((f) => /^L\d{3}\.33A$/.test(f.id))
              .map((f) => f.id.split(".")[0])
          )
        );

        // Build the verified readings once to extract quantities
        const verifiedText = verifyReadings(bundleAnswer, bundleDocuments);
        const qty = (n: number): number => {
          const reading = verifiedText.find(
            (r) => r.field === `invoice.lines.${n}.quantity` && r.status === "accepted"
          );
          return reading ? Number(reading.value) : 0;
        };

        fc.assert(
          fc.property(
            fc.tuple(fc.constantFrom(...lineIds), fc.constantFrom(...htsNumbers)),
            ([lineId, htsNum]: [string, string]) => {
              // Test on text pages
              {
                const textDraftWithEdit = build(bundleDocuments, [
                  { fieldId: `${lineId}.33A`, value: htsNum },
                ]);
                const textFieldsEdited = allFields(textDraftWithEdit);

                const textBaseField = textFields.find((f) => f.id === `${lineId}.35`);
                const textEditedField = textFieldsEdited.find((f) => f.id === `${lineId}.35`);

                // If the base 35 waited due to packing list difference, edited one should too
                if (
                  textBaseField?.status === "needsReview" &&
                  textBaseField?.reason &&
                  textBaseField.reason.includes("the packing list says")
                ) {
                  expect(textEditedField?.status).toBe("needsReview");
                  expect(textEditedField?.reason).toBe(textBaseField.reason);
                  expect(textEditedField?.value).toBeNull();
                } else {
                  // Otherwise, unit should match the HTS lookup
                  const lookup = lookupHts(bundleHts, htsNum);
                  expect(lookup.found).toBe(true);
                  if (!lookup.found) return;
                  expect(textEditedField?.unit).toBe(lookup.unit);

                  // If it has a value, it should be the sum of invoice quantities
                  if (textEditedField?.value) {
                    const line = textDraftWithEdit.lines.find((l) => l.lineNumber === lineId.slice(1));
                    expect(line).toBeDefined();

                    let sum = 0;
                    for (const invoiceLineNo of line!.invoiceLines) {
                      sum += qty(invoiceLineNo);
                    }

                    const want = lookup.unit === "Dz Pcs" ? (sum % 12 === 0 ? String(sum / 12) : (sum / 12).toFixed(2)) : String(sum);
                    expect(textEditedField.value).toBe(want);
                  }
                }
              }

              // Test on all image pages
              {
                const imgDocuments = imgDocs(bundleDocuments);
                const imageDraftWithEdit = build(imgDocuments, [
                  { fieldId: `${lineId}.33A`, value: htsNum },
                ]);
                const imageFieldsEdited = allFields(imageDraftWithEdit);

                // No field should be "computed" or "copied" with imageTranscript origin and non-CONFIRMED note
                for (const f of imageFieldsEdited) {
                  if (f.status === "computed" || f.status === "copied") {
                    for (const source of f.sources) {
                      if (source.kind === "document" && source.origin === "imageTranscript") {
                        expect(f.note).toBe(CONFIRMED_NOTE);
                      }
                    }
                  }
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

  describe("Feature: document-intake, Property 49: No Total or Duty From Missing Inputs (Validates: Requirements 32.1, 32.2, 32.3)", () => {
    it(
      "Property 49: No Total or Duty From Missing Inputs",
      async () => {
        const fc = await import("fast-check");

        const htsNumbers = ["6913.90.5000", "7013.99.3500", "3926.40.0090"];
        const rateStrings = ["5 cents/kg", "Free", "4%", "12.5%"];
        const enteredValues = ["540.50", "abc", "0", ...Array.from({ length: 100 }, (_, i) => ((i + 1) * 100).toString())];
        const readingFields = ["invoice.currency", "packingList.totalGrossKg", "invoice.lines.1.unit"];

        // Build base drafts once before the property test
        const plain = build(bundleDocuments, []);
        const plainFields = allFields(plain);
        const img: Record<string, ReturnType<typeof allFields>> = {};
        for (const readingField of readingFields) {
          img[readingField] = allFields(build(bundleDocuments, [], onlyImage(readingField)));
        }

        fc.assert(
          fc.property(
            fc.tuple(
              fc.boolean(), // true = text pages, false = image pages
              fc.integer({ min: 1, max: 8 }), // line number
              fc.oneof(
                fc.tuple(fc.constant("36A"), fc.constantFrom(...enteredValues)),
                fc.tuple(fc.constant("37A"), fc.constantFrom(...rateStrings)),
                fc.tuple(fc.constant("33A"), fc.constantFrom(...htsNumbers))
              ),
              fc.constantFrom(...readingFields)
            ),
            ([useText, lineNum, [editField, editValue], readingField]: [boolean, number, [string, string], string]) => {
              const lineId = `L${String(lineNum).padStart(3, "0")}`;
              const docs = useText ? bundleDocuments : imgDocs(bundleDocuments);

              const draft = build(docs, [{ fieldId: `${lineId}.${editField}`, value: editValue }]);
              const fields = allFields(draft);

              // Check that all computed 38 fields have valid 36A and 37A
              for (const field of fields) {
                if (field.id.match(/^L\d{3}\.38$/) && field.status === "computed") {
                  const lineIdOf38 = field.id.split(".")[0];
                  const f36a = fields.find((f) => f.id === `${lineIdOf38}.36A`);
                  const f37a = fields.find((f) => f.id === `${lineIdOf38}.37A`);

                  expect(f36a?.value).not.toBeNull();
                  expect(f37a?.value).not.toBeNull();

                  // Verify computeDuty works with these values
                  const rateResult = computeDuty(f37a?.value || "Free", parseInt(f36a?.value || "0") * 100);
                  expect(rateResult.ok).toBe(true);

                  if (rateResult.ok) {
                    expect(formatCents(rateResult.value)).toBe(field.value);
                  }
                }
              }

              // For text pages, check that certain fields don't stay computed when their reading sources are from images
              if (useText) {
                // Determine the block based on the reading field
                let block: string | null = null;
                if (readingField === "invoice.currency") {
                  block = "36A";
                } else if (readingField === "packingList.totalGrossKg") {
                  block = "34A";
                } else if (readingField === "invoice.lines.1.unit") {
                  // Only L001.35 uses this reading
                  block = "L001.35";
                }

                if (block) {
                  // For each field in plain draft with the target block and status "computed"
                  for (const plainField of plainFields) {
                    if (block === "L001.35") {
                      // Check only L001.35
                      if (plainField.id === "L001.35" && plainField.status === "computed") {
                        const imgField = img[readingField].find((f) => f.id === plainField.id);
                        expect(imgField?.status).toBe("needsReview");
                        const source = imgField?.sources.find(
                          (s) =>
                            s.kind === "document" &&
                            s.readingField === readingField &&
                            s.origin === "imageTranscript"
                        );
                        expect(source).toBeDefined();
                      }
                    } else {
                      // Check all fields matching the block pattern
                      if (plainField.id.match(new RegExp(`\\.${block}$`)) && plainField.status === "computed") {
                        const imgField = img[readingField].find((f) => f.id === plainField.id);
                        expect(imgField?.status).toBe("needsReview");
                        const source = imgField?.sources.find(
                          (s) =>
                            s.kind === "document" &&
                            s.readingField === readingField &&
                            s.origin === "imageTranscript"
                        );
                        expect(source).toBeDefined();
                      }
                    }
                  }
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
