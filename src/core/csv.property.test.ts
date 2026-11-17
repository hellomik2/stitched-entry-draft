import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { formatSource } from "./csv";
import type { DocSource } from "./draft";
import { transcriptToPageText, type TranscriptLine } from "./transcript";
import type { DocumentText, Box } from "./pdfText";
import { verifyReadings } from "./reading";
import type { ReadingAnswer } from "./reading";

describe("CSV source formatting with origin", () => {
  describe("Feature: document-intake, Property 5: Image-Origin Sources Labelled Distinctly (Validates: Requirements 4.3)", () => {
    it("should append image label only when origin is imageTranscript", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 100 }),
          fc.double({ min: 0, max: 1 }),
          fc.double({ min: 0, max: 1 }),
          fc.double({ min: 0.01, max: 0.5 }),
          fc.double({ min: 0.01, max: 0.5 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.boolean(),
          (doc, page, lines, x, y, w, h, quote, hasOrigin) => {
            const source: DocSource = {
              kind: "document",
              doc,
              page,
              quote,
              box: { x, y, w, h },
              readingField: "test.field",
              ...(hasOrigin && { origin: "imageTranscript" as const }),
            };

            const formatted = formatSource(source);

            // Check the base format without origin
            const baseFormat = `${doc} p.${page} [${x.toFixed(1)},${y.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)}] "${quote.replace(/"/g, '""')}"`;

            if (hasOrigin) {
              expect(formatted).toBe(baseFormat + " (read from an image by the AI reader)");
            } else {
              expect(formatted).toBe(baseFormat);
            }

            // Property: formatSource result should be deterministic
            const formatted2 = formatSource(source);
            expect(formatted2).toBe(formatted);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Feature: document-intake, Property 6: Image-Origin Sources Only for Image Pages (Validates: Requirements 4.4)", () => {
    it("should mark origin only when reading from transcript pages, not text-layer pages", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              text: fc.stringMatching(/^[A-Za-z0-9]{1,10}$/),
              box: fc.record({
                x: fc.double({ min: 0, max: 0.4 }),
                y: fc.double({ min: 0, max: 0.4 }),
                w: fc.double({ min: 0.1, max: 0.2 }),
                h: fc.double({ min: 0.05, max: 0.1 }),
              }),
            }),
            { minLength: 2, maxLength: 5 },
          ),
          (transcriptLines) => {
            // Build transcript page (imageTranscript origin)
            const transcriptPageText = transcriptToPageText(
              "test-doc",
              1,
              1000,
              1000,
              transcriptLines as TranscriptLine[],
            );
            expect(transcriptPageText.origin).toBe("imageTranscript");

            // Build text-layer page (no origin key at all)
            // Use rounded boxes from transcript for consistency
            const textLayerItems = transcriptLines.map((line, i) => ({
              id: `item-${i}`,
              str: line.text,
              box: {
                x: Math.round(line.box.x * 100) / 100,
                y: Math.round(line.box.y * 100) / 100,
                w: Math.round(line.box.w * 100) / 100,
                h: Math.round(line.box.h * 100) / 100,
              } as Box,
            }));

            const textLayerPageText = {
              page: 2,
              width: 1000,
              height: 1000,
              items: textLayerItems,
              text: transcriptLines.map((line) => line.text).join(" "),
              spans: transcriptLines.map((line, i) => ({
                itemId: `item-${i}`,
                start: transcriptLines.slice(0, i).reduce((sum, l) => sum + l.text.length + 1, 0),
                end:
                  transcriptLines.slice(0, i).reduce((sum, l) => sum + l.text.length + 1, 0) +
                  line.text.length,
              })),
              // NO origin key for text-layer page
            };

            const docText: DocumentText = {
              docId: "test-doc",
              kind: "packingList",
              pages: [transcriptPageText, textLayerPageText],
            };

            // Create readings for a unique line from each page
            const transcriptReading = {
              field: "test.transcript",
              value: transcriptLines[0].text,
              quote: transcriptLines[0].text,
              doc: "test-doc",
              page: 1,
            };

            const textLayerReading = {
              field: "test.textLayer",
              value: transcriptLines[1].text,
              quote: transcriptLines[1].text,
              doc: "test-doc",
              page: 2,
            };

            const answer: ReadingAnswer = {
              schemaVersion: 1,
              bundle: "test",
              reader: "test-reader",
              documents: [{ docId: "test-doc", kind: "packingList" }],
              fields: [transcriptReading, textLayerReading],
            };

            const verified = verifyReadings(answer, [docText]);

            // Check transcript reading has imageTranscript origin
            const transcriptVerified = verified.find((r) => r.field === "test.transcript");
            expect(transcriptVerified).toBeDefined();
            if (transcriptVerified && transcriptVerified.status === "accepted") {
              expect(transcriptVerified.origin).toBe("imageTranscript");
            }

            // Check text-layer reading does not have origin key
            const textLayerVerified = verified.find((r) => r.field === "test.textLayer");
            expect(textLayerVerified).toBeDefined();
            if (textLayerVerified && textLayerVerified.status === "accepted") {
              expect("origin" in textLayerVerified).toBe(false);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
