import { describe, it, expect, beforeAll } from "vitest";
import { verifyReadings } from "./reading";
import type { VerifiedReading, ReadingAnswer } from "./reading";
import { buildDraft, allFields } from "./draft";
import type { DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];
let bundleHts: HtsTable;

describe("Requirement 33: A Quantity That Was Not Read Is Not Zero (Property 50)", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
    bundleHts = bundle.hts;
  });

  /**
   * Helper: build a draft with the given answer (usually with low confidence set on some fields)
   */
  const build = (answer: ReadingAnswer) => {
    return buildDraft({
      bundle: "lantern-hollow",
      reader: answer.reader,
      readings: verifyReadings(answer, bundleDocuments),
      hts: bundleHts,
      invoiceLineCount: answer.invoiceLineCount ?? null,
      overrides: [],
    });
  };

  /**
   * Helper: get the answer with low confidence on every field whose `field` is in `names`
   */
  const low = (names: string[]): ReadingAnswer => {
    const namesSet = new Set(names);
    return {
      ...bundleAnswer,
      fields: bundleAnswer.fields.map((f) => {
        if (namesSet.has(f.field)) {
          return { ...f, confidence: "low" as const };
        }
        return f;
      }),
    };
  };

  /**
   * Helper: get the answer without the fields whose `field` starts with `prefix`
   */
  const without = (prefix: string): ReadingAnswer => {
    return {
      ...bundleAnswer,
      fields: bundleAnswer.fields.filter((f) => !f.field.startsWith(prefix)),
    };
  };

  /**
   * Helper: pick a field by ID from the draft
   */
  const pick = (draft: ReturnType<typeof buildDraft>, id: string) => {
    const fields = allFields(draft);
    return fields.find((f) => f.id === id);
  };

  /**
   * Helper: get a check entry by ID from the draft
   */
  const check = (draft: ReturnType<typeof buildDraft>, id: string) => {
    return draft.checks.find((c) => c.id === id);
  };

  describe("Example tests for Requirement 33", () => {
    it("1. low(['packingList.lines.5.quantity']): L005.35 has needsReview status with specific reason", () => {
      const d = build(low(["packingList.lines.5.quantity"]));
      const l005_35 = pick(d, "L005.35");
      const dBase = build(bundleAnswer);
      const l005_35Base = pick(dBase, "L005.35");

      expect(l005_35).toBeDefined();
      expect(l005_35?.status).toBe("needsReview");
      expect(l005_35?.value).toBeNull();
      expect(l005_35?.unit).toBe(l005_35Base?.unit); // Same unit as in draft without changes

      const expectedReason =
        "The AI reader read the quantity of packing list line 5 as 64 but was not sure, so invoice line 5 (64 PCS) was not compared with the packing list. A person compares them.";
      expect(l005_35?.reason).toBe(expectedReason);

      // Check that no field reason contains "says 0 PCS"
      const fields = allFields(d);
      for (const f of fields) {
        if (f.reason) {
          expect(f.reason).not.toMatch(/says 0 PCS/);
        }
      }

      // Check the check entry
      const checkEntry = check(d, "P3.qty.LH-105");
      expect(checkEntry).toBeDefined();
      expect(checkEntry?.ok).toBe(false);
      expect(checkEntry?.detail).toBe("packing list line 5 quantity not sure");
    });

    it("2. low(['packingList.lines.5.quantity']): every 34A field has same status and value as without changes", () => {
      const d = build(low(["packingList.lines.5.quantity"]));
      const dBase = build(bundleAnswer);

      const fields34A = allFields(d).filter((f) => f.id.match(/\.34A$/));
      const fieldsBase34A = allFields(dBase).filter((f) => f.id.match(/\.34A$/));

      for (const field of fields34A) {
        const baseField = fieldsBase34A.find((f) => f.id === field.id);
        expect(baseField).toBeDefined();
        expect(field.status).toBe(baseField?.status);
        expect(field.value).toBe(baseField?.value);
      }
    });

    it("3. low(['packingList.lines.5.itemNo']): L005.35 and L003.35 both have needsReview with specific reasons", () => {
      const d = build(low(["packingList.lines.5.itemNo"]));
      const l005_35 = pick(d, "L005.35");
      const l003_35 = pick(d, "L003.35");

      expect(l005_35?.status).toBe("needsReview");
      expect(l005_35?.value).toBeNull();
      expect(l005_35?.reason).toBe(
        "Packing list line 5 was not fully read (item number or quantity), so invoice line 5 (64 PCS) was not compared with the packing list. A person compares them."
      );

      expect(l003_35?.status).toBe("needsReview");
      expect(l003_35?.value).toBeNull();
      expect(l003_35?.reason).toBe(
        "Packing list line 5 was not fully read (item number or quantity), so invoice line 3 (240 PCS) was not compared with the packing list. A person compares them."
      );

      // L002.35 should still be computed with value 200
      const l002_35 = pick(d, "L002.35");
      expect(l002_35?.status).toBe("computed");
      expect(l002_35?.value).toBe("200");
    });

    it("4. without('packingList.lines.5.'): L005.35 has needsReview with no packing list line reason", () => {
      const d = build(without("packingList.lines.5."));
      const l005_35 = pick(d, "L005.35");

      expect(l005_35?.status).toBe("needsReview");
      expect(l005_35?.value).toBeNull();
      expect(l005_35?.reason).toBe(
        "Invoice line 5 (LH-105) says 64 PCS; no packing list line for LH-105 was read. A person decides."
      );

      const checkEntry = check(d, "P3.qty.LH-105");
      expect(checkEntry).toBeDefined();
      expect(checkEntry?.ok).toBe(false);
      expect(checkEntry?.detail).toBe("no packing list line for LH-105 was read");
    });

    it("5. low(['invoice.lines.5.itemNo']): L005.35 has needsReview with itemNo not read reason", () => {
      const d = build(low(["invoice.lines.5.itemNo"]));
      const l005_35 = pick(d, "L005.35");

      expect(l005_35?.status).toBe("needsReview");
      expect(l005_35?.value).toBeNull();
      expect(l005_35?.reason).toBe(
        "The item number of invoice line 5 was not read, so its quantity was not compared with the packing list. A person compares them."
      );
    });

    it("6. low(['invoice.lines.8.quantity']): L001.35 has needsReview with unit from invoice line 8", () => {
      const d = build(low(["invoice.lines.8.quantity"]));
      const l001_35 = pick(d, "L001.35");

      expect(l001_35?.status).toBe("needsReview");
      expect(l001_35?.value).toBeNull();
      expect(l001_35?.unit).toBe("Dz Pcs");
      expect(l001_35?.reason).toBe(
        "The quantity or unit of invoice line 8 was not read or is not a unit the draft counts, so the net quantity is not added up. A person enters it."
      );
    });

    it("6b. low(['invoice.lines.1.unit']): L001.35 has needsReview for invoice line 1", () => {
      const d = build(low(["invoice.lines.1.unit"]));
      const l001_35 = pick(d, "L001.35");

      expect(l001_35?.status).toBe("needsReview");
      expect(l001_35?.value).toBeNull();
      expect(l001_35?.unit).toBe("Dz Pcs");
      expect(l001_35?.reason).toBe(
        "The quantity or unit of invoice line 1 was not read or is not a unit the draft counts, so the net quantity is not added up. A person enters it."
      );
    });

    it("7. Without changes: L003.35 reason shows quantity difference, check shows details", () => {
      const d = build(bundleAnswer);
      const l003_35 = pick(d, "L003.35");

      expect(l003_35?.status).toBe("needsReview");
      expect(l003_35?.reason).toBe(
        "says 240 PCS, the packing list says 216 PCS. A person decides."
      );

      const checkEntry = check(d, "P3.qty.LH-103");
      expect(checkEntry).toBeDefined();
      expect(checkEntry?.ok).toBe(false);
      expect(checkEntry?.detail).toBe("invoice qty = 240, packing sum = 216");
    });
  });

  describe("Feature: document-intake, Property 50: A Quantity That Was Not Read Is Not Zero (Validates: Requirements 33.1, 33.2, 33.3, 33.4)", () => {
    it(
      "Property 50: drawn fields with low confidence never show 0 PCS and quantities match invoice",
      async () => {
        const fc = await import("fast-check");

        // List of all readable quantity and unit related fields per invoice and packing list
        const names = [
          "packingList.lines.1.itemNo",
          "packingList.lines.1.quantity",
          "packingList.lines.2.itemNo",
          "packingList.lines.2.quantity",
          "packingList.lines.3.itemNo",
          "packingList.lines.3.quantity",
          "packingList.lines.4.itemNo",
          "packingList.lines.4.quantity",
          "packingList.lines.5.itemNo",
          "packingList.lines.5.quantity",
          "packingList.lines.6.itemNo",
          "packingList.lines.6.quantity",
          "packingList.lines.7.itemNo",
          "packingList.lines.7.quantity",
          "packingList.lines.8.itemNo",
          "packingList.lines.8.quantity",
          "invoice.lines.1.itemNo",
          "invoice.lines.1.quantity",
          "invoice.lines.1.unit",
          "invoice.lines.2.itemNo",
          "invoice.lines.2.quantity",
          "invoice.lines.2.unit",
          "invoice.lines.3.itemNo",
          "invoice.lines.3.quantity",
          "invoice.lines.3.unit",
          "invoice.lines.4.itemNo",
          "invoice.lines.4.quantity",
          "invoice.lines.4.unit",
          "invoice.lines.5.itemNo",
          "invoice.lines.5.quantity",
          "invoice.lines.5.unit",
          "invoice.lines.6.itemNo",
          "invoice.lines.6.quantity",
          "invoice.lines.6.unit",
          "invoice.lines.7.itemNo",
          "invoice.lines.7.quantity",
          "invoice.lines.7.unit",
          "invoice.lines.8.itemNo",
          "invoice.lines.8.quantity",
          "invoice.lines.8.unit",
        ];

        fc.assert(
          fc.property(fc.subarray(names), (drawn: string[]) => {
            const d = build(low(drawn));
            const verified = verifyReadings(low(drawn), bundleDocuments);

            // Helper to get accepted reading value
            const acc = (field: string) => {
              const reading = verified.find((r) => r.field === field && r.status === "accepted");
              return reading ? reading.value : undefined;
            };

            // Helper to identify if a packing list line is "not fully read"
            // A packing list line k is "not fully read" when verified has some reading with field
            // starting with packingList.lines.${k}. but itemNo or quantity is not accepted
            const isNotFullyRead = (lineNum: number) => {
              const hasAnyReading = verified.some((r) => r.field.startsWith(`packingList.lines.${lineNum}.`));
              if (!hasAnyReading) return false;
              const itemNoAcc = acc(`packingList.lines.${lineNum}.itemNo`);
              const quantityAcc = acc(`packingList.lines.${lineNum}.quantity`);
              return !itemNoAcc || !quantityAcc;
            };

            // Check: no field reason contains "says 0 PCS"
            const fields = allFields(d);
            for (const f of fields) {
              if (f.reason) {
                expect(f.reason).not.toMatch(/says 0 PCS/);
              }
            }

            // For every line of d.lines whose 35 has status "computed"
            for (const line of d.lines) {
              const field35 = fields.find((f) => f.id === `L${line.lineNumber}.35`);

              if (field35?.status === "computed") {
                // For each invoice line number in this 7501 line
                for (const invoiceLineNo of line.invoiceLines) {
                  const invoiceQtyAcc = acc(`invoice.lines.${invoiceLineNo}.quantity`);
                  const invoiceUnitAcc = acc(`invoice.lines.${invoiceLineNo}.unit`);
                  const invoiceItemNoAcc = acc(`invoice.lines.${invoiceLineNo}.itemNo`);

                  // These must be accepted (not null, not low confidence)
                  expect(invoiceQtyAcc).toBeDefined();
                  expect(invoiceUnitAcc).toBeDefined();
                  expect(invoiceItemNoAcc).toBeDefined();

                  // No not-fully-read packing list line should have this item number
                  for (let k = 1; k <= 8; k++) {
                    if (isNotFullyRead(k)) {
                      const plItemNoAcc = acc(`packingList.lines.${k}.itemNo`);
                      expect(plItemNoAcc).not.toBe(invoiceItemNoAcc);
                    }
                  }

                  // The quantities of fully read packing list lines with the same item number should sum
                  let plSum = 0;
                  for (let k = 1; k <= 8; k++) {
                    if (!isNotFullyRead(k)) {
                      const plItemNo = acc(`packingList.lines.${k}.itemNo`);
                      if (plItemNo === invoiceItemNoAcc) {
                        const plQty = acc(`packingList.lines.${k}.quantity`);
                        plSum += plQty ? Number(plQty) : 0;
                      }
                    }
                  }

                  // The packing list quantities of that item number must add up to the invoice quantity
                  expect(plSum).toBe(Number(invoiceQtyAcc));
                }

                // The 35 value should be the sum of all invoice quantities in the line, using HTS unit
                if (field35.value) {
                  let sum = 0;
                  for (const invoiceLineNo of line.invoiceLines) {
                    const invoiceQtyAcc = acc(`invoice.lines.${invoiceLineNo}.quantity`);
                    sum += invoiceQtyAcc ? Number(invoiceQtyAcc) : 0;
                  }

                  const want =
                    field35.unit === "Dz Pcs"
                      ? sum % 12 === 0
                        ? String(sum / 12)
                        : (sum / 12).toFixed(2)
                      : String(sum);
                  expect(field35.value).toBe(want);
                }
              }
            }

            // Build dq with low confidence on quantity fields only
            const quantityFieldsOnly = drawn.filter((x) =>
              /^packingList\.lines\.\d+\.quantity$/.test(x)
            );
            const dq = build(low(quantityFieldsOnly));
            const fieldsQ = allFields(dq);
            const fieldsBase = allFields(build(bundleAnswer));

            // Every 34A of dq should have same status and value as base
            for (const f of fieldsQ) {
              if (f.id.match(/\.34A$/)) {
                const baseF = fieldsBase.find((bf) => bf.id === f.id);
                expect(baseF).toBeDefined();
                expect(f.status).toBe(baseF?.status);
                expect(f.value).toBe(baseF?.value);
              }
            }
          }),
          { numRuns: 50 }
        );
      },
      120000
    );
  });
});
