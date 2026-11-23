import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { transcriptToPageText } from "./transcript";
import type { DocumentText, PageText } from "./pdfText";
import { verifyReadings } from "./reading";
import type { ReadingAnswer } from "./reading";
import { validateReaderOutput } from "./readerContract";
import type { ReaderInput, ReaderOutput } from "./readerContract";

describe("Requirement 37: Image Pages with No Box", () => {
  it("1. validateReaderOutput accepts a transcript line with box: null and still rejects box with x = 1.2", () => {
    const mockInput: ReaderInput = {
      bundle: "test-bundle",
      documents: [
        {
          docId: "billOfLading",
          kind: "billOfLading",
          fileName: "bol.jpg",
          fileSha256: "0".repeat(64),
          pages: [
            { page: 1, width: 1000, height: 1000, text: null, image: { mediaType: "image/jpeg", base64: "QUJD" } },
          ],
        },
      ],
    };

    // Test: accepts line with box: null
    const outputWithNull: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "billOfLading",
          page: 1,
          lines: [
            { text: "Port of loading: Leixoes", box: null as any },
          ],
        },
      ],
    };

    const resultNull = validateReaderOutput(outputWithNull, mockInput);
    expect(resultNull.ok).toBe(true);

    // Test: rejects box with x = 1.2
    const outputWithBadBox: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "billOfLading",
          page: 1,
          lines: [
            { text: "Port of loading: Leixoes", box: { x: 1.2, y: 0.1, w: 0.3, h: 0.05 } },
          ],
        },
      ],
    };

    const resultBad = validateReaderOutput(outputWithBadBox, mockInput);
    expect(resultBad.ok).toBe(false);
  });

  it("2. transcriptToPageText with one line having box and one with box: null creates two items, page text, second marked noBox", () => {
    const lines = [
      { text: "Vessel: OWLFERRY DAWN Voyage: 047W", box: { x: 0.17, y: 0.22, w: 0.65, h: 0.04 } },
      { text: "Port of loading: Leixoes", box: null as any },
    ];

    const page = transcriptToPageText("billOfLading", 1, 1000, 1000, lines);

    expect(page.items).toHaveLength(2);
    expect(page.text).toContain("Vessel: OWLFERRY DAWN Voyage: 047W");
    expect(page.text).toContain("Port of loading: Leixoes");

    // Second item should have noBox mark
    expect((page.items[1] as any).noBox).toBe(true);
    expect((page.items[0] as any).noBox).toBeUndefined();
  });

  it("3. billOfLading.portOfLoading rejected with 'no_source_box' on no-box line; billOfLading.vessel accepted on box line", () => {
    const lines = [
      { text: "Vessel: OWLFERRY DAWN Voyage: 047W", box: { x: 0.17, y: 0.22, w: 0.65, h: 0.04 } },
      { text: "Port of loading: Leixoes", box: null as any },
    ];

    const page = transcriptToPageText("billOfLading", 1, 1000, 1000, lines);
    const doc: DocumentText = { docId: "billOfLading", kind: "billOfLading", pages: [page] };

    const fields = [
      {
        field: "billOfLading.portOfLoading",
        value: "Leixoes",
        quote: "Port of loading: Leixoes",
        doc: "billOfLading",
        page: 1,
      },
      {
        field: "billOfLading.vessel",
        value: "OWLFERRY DAWN",
        quote: "Vessel: OWLFERRY DAWN",
        doc: "billOfLading",
        page: 1,
      },
    ];

    const answer: ReadingAnswer = {
      schemaVersion: 1,
      bundle: "t",
      reader: "t",
      documents: [{ docId: "billOfLading", kind: "billOfLading" }],
      fields,
    };

    const verified = verifyReadings(answer, [doc]);

    // Port reading should be rejected with no_source_box
    expect(verified[0].status).toBe("rejected");
    if (verified[0].status === "rejected") {
      expect(verified[0].reason).toBe("no_source_box");
      expect(verified[0].message).toContain("no usable place");
    }

    // Vessel reading should be accepted with box
    expect(verified[1].status).toBe("accepted");
    if (verified[1].status === "accepted") {
      expect(verified[1].box).toBeDefined();
      expect(verified[1].box.w).toBeGreaterThan(0);
    }
  });

  it("4. Property 54: Bad box spoils only its line; good lines have same status and box", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.array(fc.boolean(), { minLength: 2, maxLength: 10 }),
        (lineCount, hasBox) => {
          // Ensure we have exactly lineCount booleans
          const boxFlags = hasBox.slice(0, lineCount);

          // Build transcript lines
          const lines = [];
          for (let i = 0; i < lineCount; i++) {
            if (boxFlags[i]) {
              lines.push({
                text: `L${i} value V${i}`,
                box: { x: 0.1 + 0.05 * i, y: 0.1 + 0.08 * i, w: 0.3, h: 0.05 },
              });
            } else {
              lines.push({
                text: `L${i} value V${i}`,
                box: null as any,
              });
            }
          }

          const page = transcriptToPageText("billOfLading", 1, 1000, 1000, lines);
          const doc: DocumentText = { docId: "billOfLading", kind: "billOfLading", pages: [page] };

          // Create readings for each line
          const fields = [];
          for (let i = 0; i < lineCount; i++) {
            fields.push({
              field: `billOfLading.q${i}`,
              value: `V${i}`,
              quote: `L${i} value V${i}`,
              doc: "billOfLading",
              page: 1,
            });
          }

          const answer: ReadingAnswer = {
            schemaVersion: 1,
            bundle: "t",
            reader: "t",
            documents: [{ docId: "billOfLading", kind: "billOfLading" }],
            fields,
          };

          const verified = verifyReadings(answer, [doc]);

          // Check each reading
          for (let i = 0; i < lineCount; i++) {
            if (boxFlags[i]) {
              // Should be accepted with box
              expect(verified[i].status).toBe("accepted");
              if (verified[i].status === "accepted") {
                expect((verified[i] as any).box).toBeDefined();
                expect((verified[i] as any).box.w).toBeGreaterThan(0);
              }
            } else {
              // Should be rejected with no_source_box
              expect(verified[i].status).toBe("rejected");
              if (verified[i].status === "rejected") {
                expect((verified[i] as any).reason).toBe("no_source_box");
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-intake, Property 54: A Bad Box Spoils Only Its Line (Validates: Requirements 37.1, 37.2, 37.3)", () => {
  it("should handle lines with null boxes independently", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        (count) => {
          const lines = [];
          for (let i = 0; i < count; i++) {
            lines.push({
              text: `L${i} value V${i}`,
              box: { x: 0.1 + 0.05 * i, y: 0.1 + 0.08 * i, w: 0.3, h: 0.05 },
            });
          }

          // Choose a random line to have no box
          const noBoxIndex = Math.floor(Math.random() * count);
          (lines[noBoxIndex] as any).box = null;

          const page = transcriptToPageText("billOfLading", 1, 1000, 1000, lines);
          const doc: DocumentText = { docId: "billOfLading", kind: "billOfLading", pages: [page] };

          const fields = [];
          for (let i = 0; i < count; i++) {
            fields.push({
              field: `billOfLading.q${i}`,
              value: `V${i}`,
              quote: `L${i} value V${i}`,
              doc: "billOfLading",
              page: 1,
            });
          }

          const answer: ReadingAnswer = {
            schemaVersion: 1,
            bundle: "t",
            reader: "t",
            documents: [{ docId: "billOfLading", kind: "billOfLading" }],
            fields,
          };

          const verified = verifyReadings(answer, [doc]);

          for (let i = 0; i < count; i++) {
            if (i === noBoxIndex) {
              expect(verified[i].status).toBe("rejected");
              if (verified[i].status === "rejected") {
                expect((verified[i] as any).reason).toBe("no_source_box");
              }
            } else {
              expect(verified[i].status).toBe("accepted");
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
