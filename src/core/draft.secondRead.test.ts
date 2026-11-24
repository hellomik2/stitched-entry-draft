import { describe, it, expect, beforeAll } from "vitest";
import { verifyReadings } from "./reading";
import type { VerifiedReading, ReadingAnswer } from "./reading";
import { buildDraft, allFields, CONFIRMED_NOTE } from "./draft";
import type { DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];
let bundleHts: HtsTable;

describe("Draft: Second Read and Low Confidence (Requirements 36, 38, 49.1, 53, 55)", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
    bundleHts = bundle.hts;
  });

  /**
   * Helper: build a copy of the sample answer where changes maps a field name to
   * null (remove that reading) or to an object merged into that reading.
   */
  const answerWith = (changes: Record<string, null | Record<string, any>>): ReadingAnswer => {
    const newFields = bundleAnswer.fields
      .filter((f) => changes[f.field] !== null)
      .map((f) => {
        if (changes[f.field] && typeof changes[f.field] === "object") {
          return { ...f, ...changes[f.field] };
        }
        return f;
      });
    return { ...bundleAnswer, fields: newFields };
  };

  /**
   * Helper: build a draft and optionally mutate verified readings before building
   */
  const build = (
    answer: ReadingAnswer,
    overrides: Array<{ fieldId: string; value: string }> = [],
    mutate?: (readings: VerifiedReading[]) => void
  ) => {
    const readings = verifyReadings(answer, bundleDocuments);
    if (mutate) mutate(readings);
    return buildDraft({
      bundle: "lantern-hollow",
      reader: answer.reader,
      readings,
      hts: bundleHts,
      invoiceLineCount: answer.invoiceLineCount ?? null,
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
   * Helper: get the line id for the draft line containing an invoice line
   */
  const lineId = (draft: ReturnType<typeof buildDraft>, invoiceLineNo: number): string => {
    const line = draft.lines.find((l) => l.invoiceLines.includes(invoiceLineNo));
    if (!line) throw new Error(`No line contains invoice line ${invoiceLineNo}`);
    return "L" + line.lineNumber;
  };

  /**
   * Helper: mutate function that sets status="rejected" on a verified reading
   */
  const rejectIt =
    (fieldName: string, message: string) =>
    (readings: VerifiedReading[]) => {
      for (let i = 0; i < readings.length; i++) {
        const r = readings[i];
        if (r.field === fieldName && r.status === "accepted") {
          const rejected: VerifiedReading = {
            field: r.field,
            value: r.value,
            quote: r.quote,
            doc: r.doc,
            page: r.page,
            ...(r.confidence && { confidence: r.confidence }),
            status: "rejected",
            reason: "quote_not_unique",
            message: message,
          } as any;
          readings[i] = rejected;
        }
      }
    };

  /**
   * Helper: mutate function that sets value on a verified reading
   */
  const setValue = (fieldName: string, value: string) => (readings: VerifiedReading[]) => {
    for (const r of readings) {
      if (r.field === fieldName) {
        r.value = value;
      }
    }
  };

  const LOW = "The AI reader was not sure of this value. Check it against the page, then confirm it.";

  describe("Requirement 36: Uncertain Readings Become Needs Review With Specific Reasons", () => {
    it("Example 36.1: packingList.totalGrossKg low: every 34A has needsReview", () => {
      const answer = answerWith({ "packingList.totalGrossKg": { confidence: "low" } });
      const draft = build(answer);

      // Every 34A should have status needsReview, value null, and the specified reason
      for (let i = 1; i <= 7; i++) {
        const lineId_i = "L" + String(i).padStart(3, "0");
        const field34a = pick(draft, `${lineId_i}.34A`);
        expect(field34a?.status).toBe("needsReview");
        expect(field34a?.value).toBeNull();
        expect(field34a?.reason).toBe(
          "The AI reader read the packing list total gross weight as 286.2 kg but was not sure, so it is not used. A person checks it and enters the gross weight."
        );
        // Check one source with readingField packingList.totalGrossKg
        const source = field34a?.sources.find((s) => s.kind === "document" && s.readingField === "packingList.totalGrossKg");
        expect(source).toBeDefined();
      }
    });

    it("Example 36.2: packingList.totalGrossKg low + billOfLading.grossKg = 268.2", () => {
      const answer = answerWith({ "packingList.totalGrossKg": { confidence: "low" } });
      const draft = build(answer, [], setValue("billOfLading.grossKg", "268.2"));

      for (let i = 1; i <= 7; i++) {
        const lineId_i = "L" + String(i).padStart(3, "0");
        const field34a = pick(draft, `${lineId_i}.34A`);
        expect(field34a?.status).toBe("needsReview");
        expect(field34a?.value).toBeNull();
        expect(field34a?.reason).toBe(
          "The AI reader read the packing list total gross weight as 286.2 kg but was not sure, so it is not used. The bill of lading says 268.2 kg. A person checks it and enters the gross weight."
        );
      }
    });

    it("Example 36.3: packingList.lines.3.quantity low: L003.35 waiting with specific reason", () => {
      const answer = answerWith({ "packingList.lines.3.quantity": { confidence: "low" } });
      const draft = build(answer);

      const l003_35 = pick(draft, "L003.35");
      expect(l003_35?.status).toBe("needsReview");
      expect(l003_35?.value).toBeNull();
      expect(l003_35?.reason).toBe(
        "The AI reader read the quantity of packing list line 3 as 216 but was not sure, so invoice line 3 (240 PCS) was not compared with the packing list. A person compares them."
      );

      // Check the check for P3.qty.LH-103
      const checks = draft.checks.filter((c) => c.id === "P3.qty.LH-103");
      expect(checks.length).toBeGreaterThan(0);
      expect(checks[0].ok).toBe(false);
      expect(checks[0].detail).toBe("packing list line 3 quantity not sure");
    });

    it("Example 36.3b: packingList.lines.3.quantity rejected: L003.35 with Requirement 33 reason", () => {
      const answer = answerWith({});
      const draft = build(answer, [], rejectIt("packingList.lines.3.quantity", "M"));

      const l003_35 = pick(draft, "L003.35");
      expect(l003_35?.status).toBe("needsReview");
      expect(l003_35?.value).toBeNull();
      expect(l003_35?.reason).toBe(
        "Packing list line 3 was not fully read (item number or quantity), so invoice line 3 (240 PCS) was not compared with the packing list. A person compares them."
      );
    });

    it("Example 36.4: invoice.lines.2.origin low: L002.10 reason contains 'read' and 'not sure'", () => {
      const answer = answerWith({ "invoice.lines.2.origin": { confidence: "low" } });
      const draft = build(answer);

      const l002_10 = pick(draft, "L002.10");
      expect(l002_10?.reason).toBeDefined();
      expect(l002_10?.reason!).toContain("Invoice line 2");
      expect(l002_10?.reason!).toContain("the AI reader read");
      expect(l002_10?.reason!).toContain("was not sure");
      expect(l002_10?.reason!).toContain("CZ");

      // Also verify L007.10 keeps its original reason
      const l007_10 = pick(draft, "L007.10");
      expect(l007_10?.reason).toBe(
        "Invoice line 7: the reader suggested \"CN\" but its quote is not on the page, so it was rejected."
      );
    });

    it("Example 36.4b: invoice.lines.2.origin rejected: L002.10 reason contains 'rejected'", () => {
      const answer = answerWith({});
      const draft = build(answer, [], rejectIt("invoice.lines.2.origin", "M2"));

      const l002_10 = pick(draft, "L002.10");
      expect(l002_10?.reason).toBeDefined();
      expect(l002_10?.reason!).toContain("Invoice line 2");
      expect(l002_10?.reason!).toContain("the reader suggested");
      expect(l002_10?.reason!).toContain("was rejected");
      expect(l002_10?.reason!).toContain("M2");

      // L007.10 must keep its sample reason exactly
      const l007_10 = pick(draft, "L007.10");
      expect(l007_10?.reason).toBe(
        "Invoice line 7: the reader suggested \"CN\" but its quote is not on the page, so it was rejected."
      );
    });

    it("Example 36.5: B8/B12/B14/B15 with low confidence", () => {
      const testCases: Array<{
        field: string;
        fieldId: string;
        value: string;
      }> = [
        { field: "billOfLading.vessel", fieldId: "B8", value: "MV GLOAMING LANTERN" },
        { field: "billOfLading.number", fieldId: "B12", value: "XDMO2611HPH042" },
        { field: "invoice.countryOfExport", fieldId: "B14", value: "VN" },
        { field: "billOfLading.onBoardDate", fieldId: "B15", value: "10/28/2026" },
      ];

      for (const tc of testCases) {
        // Test with low confidence
        {
          const answer = answerWith({ [tc.field]: { confidence: "low" } });
          const draft = build(answer);
          const field = pick(draft, tc.fieldId);

          expect(field?.status).toBe("needsReview");
          expect(field?.value).toBe(tc.value);
          expect(field?.reason).toBe(LOW);

          const source = field?.sources.find(
            (s) => s.kind === "document" && s.readingField === tc.field
          );
          expect(source).toBeDefined();
        }

        // Test with low confidence + override
        {
          const answer = answerWith({ [tc.field]: { confidence: "low" } });
          const draft = build(answer, [{ fieldId: tc.fieldId, value: tc.value }]);
          const field = pick(draft, tc.fieldId);

          expect(field?.status).toBe("copied");
          expect(field?.value).toBe(tc.value);
          expect(field?.note).toBe(CONFIRMED_NOTE);
        }
      }
    });

    it("Property 53: An Uncertain Value Is Never Used (40 runs)", async () => {
      const fc = await import("fast-check");

      // Get all field names from the sample answer
      const allFieldNames = Array.from(new Set(bundleAnswer.fields.map((f) => f.field)));

      fc.assert(
        fc.property(
          fc.subarray(allFieldNames, { minLength: 0, maxLength: allFieldNames.length }),
          (drawnFields: string[]) => {
            // Create an answer where drawn fields have confidence: "low"
            const answer = answerWith(
              Object.fromEntries(drawnFields.map((f) => [f, { confidence: "low" }]))
            );

            // Build draft 1 from the answer with low-confidence fields
            const d1 = build(answer);

            // Build draft 2 from same answer but with drawn fields rejected
            const verified = verifyReadings(answer, bundleDocuments);
            for (const f of drawnFields) {
              expect(["uncertain", "rejected"]).toContain(verified.find((r) => r.field === f)?.status);
            }
            const d2Verified = verified.map((r) => {
              if (drawnFields.includes(r.field) && (r.status === "accepted" || r.status === "uncertain")) {
                return {
                  ...r,
                  status: "rejected" as const,
                  reason: "low_confidence" as const,
                  message: "x",
                } as any;
              }
              return r;
            });
            const d2 = buildDraft({
              bundle: "lantern-hollow",
              reader: answer.reader,
              readings: d2Verified,
              hts: bundleHts,
              invoiceLineCount: answer.invoiceLineCount ?? null,
              overrides: [],
            });

            // Compare fields between d1 and d2
            const fields1 = allFields(d1);
            const fields2 = allFields(d2);

            for (const f1 of fields1) {
              const f2 = fields2.find((f) => f.id === f1.id);
              expect(f2).toBeDefined();
              if (!f2) return;

              // Both should have same status
              expect(f1.status).toBe(f2.status);

              // If the field is not B8, B12, B14, or B15, the value should match
              if (!["B8", "B12", "B14", "B15"].includes(f1.id)) {
                expect(f1.value).toBe(f2.value);
              } else {
                // For B8, B12, B14, B15: if f1's reason is LOW, it should stay as is; otherwise match
                if (f1.reason !== LOW) {
                  expect(f1.value).toBe(f2.value);
                }
              }
            }

            // Checks should have same ids and ok values
            const checks1 = d1.checks;
            const checks2 = d2.checks;
            expect(checks1.map((c) => c.id)).toEqual(checks2.map((c) => c.id));
            for (let i = 0; i < checks1.length; i++) {
              expect(checks1[i].ok).toBe(checks2[i].ok);
            }
          }
        ),
        { numRuns: 40 }
      );
    }, 60000);
  });

  describe("Requirement 38: Empty/Rejected HTS, Origin, and Gross Weight Tracking", () => {
    it("Example 38.1: B10 with multiple origins", () => {
      // Base case: lines 1, 5, 8 have PT; lines 2-4, 6-7 have CZ, VN, CN origins => MULTI
      {
        const draft = build(bundleAnswer);
        const b10 = pick(draft, "B10");
        expect(b10?.status).toBe("computed");
        expect(b10?.value).toBe("MULTI");
      }

      // Second case: origins of lines 2, 3, 4, 6, 7 rejected => codes left are PT and CN => MULTI
      {
        const answer = answerWith({});
        const draft = build(answer, [], (readings) => {
          rejectIt("invoice.lines.2.origin", "M2")(readings);
          rejectIt("invoice.lines.3.origin", "M3")(readings);
          rejectIt("invoice.lines.4.origin", "M4")(readings);
          rejectIt("invoice.lines.6.origin", "M6")(readings);
          rejectIt("invoice.lines.7.origin", "M7")(readings);
        });

        const b10 = pick(draft, "B10");
        expect(b10?.status).toBe("computed");
        expect(b10?.value).toBe("MULTI");
      }

      // Third case: origins of lines 2, 3, 4, 5, 6, 7 rejected => no value from invoice lines
      {
        const answer = answerWith({});
        const draft = build(answer, [], (readings) => {
          for (let i = 2; i <= 7; i++) {
            rejectIt(`invoice.lines.${i}.origin`, `M${i}`)(readings);
          }
        });
        const b10 = pick(draft, "B10");
        expect(b10?.status).toBe("needsReview");
        expect(b10?.value).toBeNull();
        const lineIds = [
          lineId(draft, 2),
          lineId(draft, 3),
          lineId(draft, 4),
          lineId(draft, 5),
          lineId(draft, 6),
          lineId(draft, 7),
        ];
        const expectedReason = "Waiting on " + lineIds.map((l) => l + ".10").join(", ") + ".";
        expect(b10?.reason).toBe(expectedReason);
      }

      // Fourth case: origins of lines 2-7 rejected + overrides give each its sample origin => MULTI
      {
        const answer = answerWith({});
        const draft = build(answer, [
          { fieldId: "L002.10", value: "CZ" },
          { fieldId: "L003.10", value: "VN" },
          { fieldId: "L004.10", value: "VN" },
          { fieldId: "L005.10", value: "CN" },
          { fieldId: "L006.10", value: "CZ" },
          { fieldId: "L007.10", value: "CN" },
        ], (readings) => {
          for (let i = 2; i <= 7; i++) {
            rejectIt(`invoice.lines.${i}.origin`, `M${i}`)(readings);
          }
        });
        const b10 = pick(draft, "B10");
        expect(b10?.status).toBe("computed");
        expect(b10?.value).toBe("MULTI");
      }

      // Fifth case: origins of lines 2-7 rejected + overrides give all "PT" => PT
      {
        const answer = answerWith({});
        const draft = build(answer, [
          { fieldId: "L002.10", value: "PT" },
          { fieldId: "L003.10", value: "PT" },
          { fieldId: "L004.10", value: "PT" },
          { fieldId: "L005.10", value: "PT" },
          { fieldId: "L006.10", value: "PT" },
          { fieldId: "L007.10", value: "PT" },
        ], (readings) => {
          for (let i = 2; i <= 7; i++) {
            rejectIt(`invoice.lines.${i}.origin`, `M${i}`)(readings);
          }
        });
        const b10 = pick(draft, "B10");
        expect(b10?.status).toBe("computed");
        expect(b10?.value).toBe("PT");
      }
    });

    it("Example 38.2: HTS not read", () => {
      // With invoice.lines.2.hts removed
      {
        const answer = answerWith({ "invoice.lines.2.hts": null });
        const draft = build(answer);

        const l002_33a = pick(draft, "L002.33A");
        expect(l002_33a?.status).toBe("needsReview");
        expect(l002_33a?.value).toBeNull();
        expect(l002_33a?.reason).toBe(
          "The HTS number of invoice line 2 was not read. A person reads it on the invoice. The app does not choose a number."
        );

        const l002_35 = pick(draft, "L002.35");
        expect(l002_35?.value).toBeNull();
        expect(l002_35?.reason).toBe("Waiting on L002.33A: the HTS number was not read.");

        const l002_37a = pick(draft, "L002.37A");
        expect(l002_37a?.value).toBeNull();
        expect(l002_37a?.reason).toBe("Waiting on L002.33A: the HTS number was not read.");
      }

      // With invoice.lines.2.hts rejected
      {
        const answer = answerWith({});
        const draft = build(answer, [], rejectIt("invoice.lines.2.hts", "M"));

        const l002_33a = pick(draft, "L002.33A");
        expect(l002_33a?.reason).toBe(
          "Invoice line 2: the reader suggested \"7013.99.3500\" but it was rejected: M A person reads it on the invoice. The app does not choose a number."
        );
      }

      // With invoice.lines.2.hts low confidence
      {
        const answer = answerWith({ "invoice.lines.2.hts": { confidence: "low" } });
        const draft = build(answer);

        const l002_33a = pick(draft, "L002.33A");
        expect(l002_33a?.reason).toBe(
          "Invoice line 2: the AI reader read \"7013.99.3500\" but was not sure. A person reads it on the invoice. The app does not choose a number."
        );
      }

      // Verify that L006.33A and L006.35 keep their original reasons
      {
        const draft = build(bundleAnswer);
        const l006_33a = pick(draft, "L006.33A");
        const l006_35 = pick(draft, "L006.35");
        expect(l006_33a?.status).toBe("needsReview");
        expect(l006_35?.status).toBe("needsReview");
        expect(l006_35?.reason).toContain("HTS number is not in the tariff schedule revision");
      }
    });

    it("Example 38.3: A refused HTS number", () => {
      // With override for L001.33A = "9999.99.9999"
      {
        const draft = build(bundleAnswer, [{ fieldId: "L001.33A", value: "9999.99.9999" }]);

        const l001_35 = pick(draft, "L001.35");
        expect(l001_35?.status).toBe("needsReview");
        expect(l001_35?.value).toBeNull();
        expect(l001_35?.reason).toBe(
          "Waiting on L001.33A: the HTS number a person entered was not accepted."
        );

        const l001_37a = pick(draft, "L001.37A");
        expect(l001_37a?.status).toBe("needsReview");
        expect(l001_37a?.value).toBeNull();
        expect(l001_37a?.reason).toBe(
          "Waiting on L001.33A: the HTS number a person entered was not accepted."
        );

        const l001_38 = pick(draft, "L001.38");
        expect(l001_38?.status).toBe("needsReview");
        expect(l001_38?.value).toBeNull();
        expect(l001_38?.reason).toBe("Waiting on L001.37A.");
      }

      // With override L001.33A = "12345" (also refused)
      {
        const draft = build(bundleAnswer, [{ fieldId: "L001.33A", value: "12345" }]);
        const l001_35 = pick(draft, "L001.35");
        expect(l001_35?.status).toBe("needsReview");
        expect(l001_35?.reason).toBe(
          "Waiting on L001.33A: the HTS number a person entered was not accepted."
        );
      }

      // With overrides for L001.35 (personEdited) and L001.33A (refused): L001.35 stays personEdited
      {
        const draft = build(bundleAnswer, [
          { fieldId: "L001.35", value: "20" },
          { fieldId: "L001.33A", value: "9999.99.9999" },
        ]);
        const l001_35 = pick(draft, "L001.35");
        expect(l001_35?.status).toBe("personEdited");
        expect(l001_35?.value).toBe("20");
      }
    });

    it("Example 38.4: 34A gross weight decision order", () => {
      // Total accepted + billOfLading.grossKg = 268.2: rule (b)
      {
        const answer = answerWith({});
        const draft = build(answer, [], setValue("billOfLading.grossKg", "268.2"));

        for (let i = 1; i <= 7; i++) {
          const lineId_i = "L" + String(i).padStart(3, "0");
          const field34a = pick(draft, `${lineId_i}.34A`);
          expect(field34a?.status).toBe("needsReview");
          expect(field34a?.value).toBeNull();
          expect(field34a?.reason).toBe(
            "The packing list total gross weight (286.2 kg) differs from the bill of lading (268.2 kg). A person decides."
          );
        }
      }

      // With packingList.lines.3.grossKg removed
      {
        const answer = answerWith({ "packingList.lines.3.grossKg": null });
        const draft = build(answer);

        for (let i = 1; i <= 7; i++) {
          const lineId_i = "L" + String(i).padStart(3, "0");
          const field34a = pick(draft, `${lineId_i}.34A`);
          expect(field34a?.status).toBe("needsReview");
          expect(field34a?.value).toBeNull();
          expect(field34a?.reason).toBe(
            "The gross weight of packing list line 3 was not read or the AI reader was not sure of it, so the total cannot be split over the 7501 lines. A person enters the gross weight."
          );
        }
      }

      // With packingList.lines.3.grossKg low
      {
        const answer = answerWith({ "packingList.lines.3.grossKg": { confidence: "low" } });
        const draft = build(answer);

        for (let i = 1; i <= 7; i++) {
          const lineId_i = "L" + String(i).padStart(3, "0");
          const field34a = pick(draft, `${lineId_i}.34A`);
          expect(field34a?.status).toBe("needsReview");
          expect(field34a?.value).toBeNull();
          expect(field34a?.reason).toBe(
            "The gross weight of packing list line 3 was not read or the AI reader was not sure of it, so the total cannot be split over the 7501 lines. A person enters the gross weight."
          );
        }
      }

      // With packingList.lines.3.grossKg = 20.0 (line sum no longer equals total)
      {
        const answer = answerWith({});
        const draft = build(answer, [], setValue("packingList.lines.3.grossKg", "20.0"));

        for (let i = 1; i <= 7; i++) {
          const lineId_i = "L" + String(i).padStart(3, "0");
          const field34a = pick(draft, `${lineId_i}.34A`);
          expect(field34a?.reason).toBeDefined();
          expect(field34a?.reason!.startsWith("Gross weight basis sum (")).toBe(true);
        }
      }
    });

    it("Example 38.5: Sample without changes", () => {
      const draft = build(bundleAnswer);

      const b10 = pick(draft, "B10");
      expect(b10?.status).toBe("computed");
      expect(b10?.value).toBe("MULTI");

      const l007_10 = pick(draft, "L007.10");
      expect(l007_10?.reason).toBe(
        "Invoice line 7: the reader suggested \"CN\" but its quote is not on the page, so it was rejected."
      );

      // Every 34A is computed
      for (let i = 1; i <= 7; i++) {
        const lineId_i = "L" + String(i).padStart(3, "0");
        const field34a = pick(draft, `${lineId_i}.34A`);
        expect(field34a?.status).toBe("computed");
      }

      const l006_35 = pick(draft, "L006.35");
      expect(l006_35?.status).toBe("needsReview");
      expect(l006_35?.reason).toContain("HTS number is not in the tariff schedule revision");
    });

    it("Property 55: What Was Not Read Is Waited On (40 runs)", async () => {
      const fc = await import("fast-check");
      const rejectOrigins = (lines: number[]) => (readings: VerifiedReading[]) => {
        for (const n of lines) rejectIt(`invoice.lines.${n}.origin`, `M${n}`)(readings);
      };
      fc.assert(
        fc.property(
          fc.subarray([1, 2, 3, 4, 5, 6, 7, 8], { minLength: 1, maxLength: 8 }),
          fc.constantFrom("9999.99.9999", "12345"),
          fc.integer({ min: 1, max: 7 }),
          (rejected: number[], refused: string, htsLine: number) => {
            const plain = build(bundleAnswer, [], rejectOrigins(rejected));
            const ids = plain.lines.map((l) => "L" + String(l.lineNumber).padStart(3, "0"));
            const missing = ids.filter((id) => !pick(plain, `${id}.10`)?.value);
            const codes = new Set(ids.map((id) => pick(plain, `${id}.10`)?.value).filter((v): v is string => !!v));
            const b10 = pick(plain, "B10");
            if (missing.length > 0 && codes.size < 2) {
              expect(b10?.status).toBe("needsReview");
              expect(b10?.value).toBeNull();
              expect(b10?.reason).toBe("Waiting on " + missing.map((id) => id + ".10").join(", ") + ".");
            } else {
              expect(b10?.value).toBe(codes.size >= 2 ? "MULTI" : [...codes][0]);
            }
            const after = build(bundleAnswer, missing.map((id) => ({ fieldId: `${id}.10`, value: "PT" })), rejectOrigins(rejected));
            const allCodes = new Set([...codes, ...(missing.length > 0 ? ["PT"] : [])]);
            expect(pick(after, "B10")?.status).toBe("computed");
            expect(pick(after, "B10")?.value).toBe(allCodes.size >= 2 ? "MULTI" : [...allCodes][0]);

            const id = "L" + String(htsLine).padStart(3, "0");
            const refusedDraft = build(bundleAnswer, [{ fieldId: `${id}.33A`, value: refused }]);
            for (const block of ["35", "37A", "38"]) {
              const f = pick(refusedDraft, `${id}.${block}`);
              expect(f).toBeDefined();
              if (f?.status !== "personEdited") expect(f?.value).toBeNull();
            }
          }
        ),
        { numRuns: 40 }
      );
    }, 60000);
  });
});
