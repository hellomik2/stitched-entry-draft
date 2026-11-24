import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { transcriptToPageText, TranscriptLine } from "./transcript";
import { normalizeSpace, DocumentText } from "./pdfText";
import { verifyReadings } from "./reading";
import type { ReadingAnswer } from "./reading";

describe("Transcript to PageText", () => {
  describe("Feature: document-intake, Property 1: Transcript Structure Preservation (Validates: Requirements 4.1, 14.1)", () => {
    it("should preserve text spans correctly and maintain all box constraints", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              text: fc.string(),
              box: fc.record({
                x: fc.double({ min: -0.2, max: 1.2, noNaN: true }),
                y: fc.double({ min: -0.2, max: 1.2, noNaN: true }),
                w: fc.double({ min: -0.2, max: 1.2, noNaN: true }),
                h: fc.double({ min: -0.2, max: 1.2, noNaN: true }),
              }),
            }),
          ),
          fc.integer({ min: 1, max: 2000 }),
          fc.integer({ min: 1, max: 2000 }),
          (lines, width, height) => {
            const pageText = transcriptToPageText("test-doc", 1, width, height, lines);

            // Property: text.slice(span.start, span.end) === item.str for every item
            for (let i = 0; i < pageText.items.length; i++) {
              const item = pageText.items[i];
              const span = pageText.spans[i];
              expect(span).toBeDefined();
              expect(pageText.text.slice(span.start, span.end)).toBe(item.str);
            }

            // Property: every box has x >= 0, y >= 0, x + w <= width + 0.01, y + h <= height + 0.01
            for (const item of pageText.items) {
              expect(item.box.x).toBeGreaterThanOrEqual(0);
              expect(item.box.y).toBeGreaterThanOrEqual(0);
              expect(item.box.x + item.box.w).toBeLessThanOrEqual(width + 0.01);
              expect(item.box.y + item.box.h).toBeLessThanOrEqual(height + 0.01);
            }

            // Property: text === items.map(i => i.str).join(" ")
            expect(pageText.text).toBe(pageText.items.map((i) => i.str).join(" "));

            // Property: item count equals number of non-empty normalized lines
            const nonEmptyLines = lines.filter((line) => normalizeSpace(line.text).length > 0);
            expect(pageText.items.length).toBe(nonEmptyLines.length);

            // Property: origin === "imageTranscript"
            expect(pageText.origin).toBe("imageTranscript");
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe("Feature: document-intake, Property 28: Transcript Round-Trip (Validates: Requirements 4.2, 14.3)", () => {
    it("should correctly find transcript content in verification and reject non-existent quotes", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 12 }),
          fc.tuple(
            fc.array(fc.stringMatching(/^[A-Za-z0-9]{1,8}$/), { minLength: 1, maxLength: 4 }),
            fc.array(
              fc.record({
                x: fc.double({ min: 0, max: 0.8, noNaN: true }),
                y: fc.double({ min: 0, max: 0.8, noNaN: true }),
                w: fc.double({ min: 0.1, max: 0.2, noNaN: true }),
                h: fc.double({ min: 0.05, max: 0.1, noNaN: true }),
              }),
              { minLength: 1, maxLength: 12 },
            ),
            fc.integer({ min: 0, max: 11 }),
            fc.integer({ min: 0, max: 3 }),
          ),
          (lineCount, [wordsGen, boxes, lineIndexBase, wordIndexBase]) => {
            // Build lines with unique line prefixes
            const lines: TranscriptLine[] = [];
            for (let i = 1; i <= Math.min(lineCount, boxes.length); i++) {
              const wordCount = (i * 7) % (wordsGen.length + 1); // Vary words per line
              const words = wordsGen.slice(0, Math.max(1, wordCount));
              const lineText = `Line ${i}: ${words.join(" ")}`;
              const line: TranscriptLine = {
                text: lineText,
                box: boxes[(i - 1) % boxes.length],
              };
              lines.push(line);
            }

            if (lines.length === 0) return;

            // Pick a random line and word from it
            const lineIndex = lineIndexBase % lines.length;
            const lineText = lines[lineIndex].text;
            const lineWords = lineText.split(" ").slice(2); // Skip "Line N:"
            if (lineWords.length === 0) return;

            const wordIndex = wordIndexBase % lineWords.length;
            const selectedWord = lineWords[wordIndex];

            // Build page text
            const pageText = transcriptToPageText("photo", 1, 1000, 1000, lines);

            // Build answer with correct quote
            const normalizedLine = normalizeSpace(lines[lineIndex].text);
            const answer: ReadingAnswer = {
              schemaVersion: 1,
              bundle: "test",
              reader: "test-reader",
              documents: [{ docId: "photo", kind: "packingList" }],
              fields: [
                {
                  field: "packingList.number",
                  value: selectedWord,
                  quote: normalizedLine,
                  doc: "photo",
                  page: 1,
                },
              ],
            };

            // Build document text
            const docText: DocumentText = {
              docId: "photo",
              kind: "packingList",
              pages: [pageText],
            };

            // Verify readings
            const verified = verifyReadings(answer, [docText]);
            expect(verified).toHaveLength(1);
            const reading = verified[0];

            // Should be accepted with a valid box
            expect(reading.status).toBe("accepted");
            if (reading.status === "accepted") {
              expect(reading.box).toBeDefined();
              expect(reading.box!.x).toBeGreaterThanOrEqual(0);
              expect(reading.box!.y).toBeGreaterThanOrEqual(0);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it("should reject a quote that does not exist on the page", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 12 }), (lineCount) => {
          const lines: TranscriptLine[] = [];
          for (let i = 1; i <= lineCount; i++) {
            const line: TranscriptLine = {
              text: `Line ${i}: Word${i}`,
              box: { x: 0.1, y: 0.1 * i, w: 0.2, h: 0.05 },
            };
            lines.push(line);
          }

          const pageText = transcriptToPageText("photo", 1, 1000, 1000, lines);

          const answer: ReadingAnswer = {
            schemaVersion: 1,
            bundle: "test",
            reader: "test-reader",
            documents: [{ docId: "photo", kind: "packingList" }],
            fields: [
              {
                field: "packingList.number",
                value: "value",
                quote: "Not on this page 12345",
                doc: "photo",
                page: 1,
              },
            ],
          };

          const docText: DocumentText = {
            docId: "photo",
            kind: "packingList",
            pages: [pageText],
          };

          const verified = verifyReadings(answer, [docText]);
          expect(verified).toHaveLength(1);
          const reading = verified[0];

          // Requirement 50.9: on an image page a quote missing from the transcript is not rejected for that (50.1);
          // the value "value" is not inside its quote, so it is rejected with value_not_in_quote.
          expect(reading.status).toBe("rejected");
          if (reading.status === "rejected") {
            expect(reading.reason).toBe("value_not_in_quote");
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});
