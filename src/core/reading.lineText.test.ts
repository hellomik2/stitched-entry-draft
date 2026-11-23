import { describe, it, expect, beforeAll } from "vitest";
import { verifyReadings } from "./reading";
import type { ReadingAnswer } from "./reading";
import { transcriptToPageText, type TranscriptLine } from "./transcript";
import type { DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];
let bundleHts: HtsTable;

describe("Reading: lineText Property (Requirement 39.1)", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
    bundleHts = bundle.hts;
  });

  describe("Transcript to PageText with lineText", () => {
    it("Example 39.1: Image page with two lines, verify lineText on accepted reading", () => {
      // Build a transcript page with two lines
      const lines: TranscriptLine[] = [
        {
          text: "Shipper: Mothlight Ceramics Atelier, Lda.",
          box: { x: 0.17, y: 0.1, w: 0.65, h: 0.04 },
        },
        {
          text: "Vessel: OWLFERRY DAWN Voyage: 047W",
          box: { x: 0.17, y: 0.22, w: 0.65, h: 0.04 },
        },
      ];

      const pageText = transcriptToPageText("billOfLading", 1, 1000, 1000, lines);

      // Verify the pageText structure
      expect(pageText.page).toBe(1);
      expect(pageText.origin).toBe("imageTranscript");
      expect(pageText.items.length).toBe(2);

      // Build a reading answer with this transcript
      const readingAnswer: ReadingAnswer = {
        schemaVersion: 1,
        bundle: "test",
        reader: "test-reader",
        documents: [
          {
            docId: "billOfLading",
            kind: "billOfLading",
          },
        ],
        fields: [
          {
            field: "billOfLading.vessel",
            value: "OWLFERRY DAWN",
            quote: "Vessel: OWLFERRY DAWN",
            doc: "billOfLading",
            page: 1,
          },
        ],
      };

      // Create a mock DocumentText with the transcript page
      const mockDocuments: DocumentText[] = [
        {
          docId: "billOfLading",
          kind: "billOfLading",
          pages: [pageText],
        },
      ];

      // Verify the reading
      const verified = verifyReadings(readingAnswer, mockDocuments);

      // Find the billOfLading.vessel reading
      const vesselReading = verified.find((r) => r.field === "billOfLading.vessel");
      expect(vesselReading).toBeDefined();
      expect(vesselReading?.status).toBe("accepted");

      // Check that lineText is present and contains the full line
      expect((vesselReading as any).lineText).toBe("Vessel: OWLFERRY DAWN Voyage: 047W");
    });

    it("Example 39.1b: Image page with low confidence, lineText still present", () => {
      const lines: TranscriptLine[] = [
        {
          text: "Shipper: Mothlight Ceramics Atelier, Lda.",
          box: { x: 0.17, y: 0.1, w: 0.65, h: 0.04 },
        },
        {
          text: "Vessel: OWLFERRY DAWN Voyage: 047W",
          box: { x: 0.17, y: 0.22, w: 0.65, h: 0.04 },
        },
      ];

      const pageText = transcriptToPageText("billOfLading", 1, 1000, 1000, lines);

      const readingAnswer: ReadingAnswer = {
        schemaVersion: 1,
        bundle: "test",
        reader: "test-reader",
        documents: [{ docId: "billOfLading", kind: "billOfLading" }],
        fields: [
          {
            field: "billOfLading.vessel",
            value: "OWLFERRY DAWN",
            quote: "Vessel: OWLFERRY DAWN",
            doc: "billOfLading",
            page: 1,
            confidence: "low",
          },
        ],
      };

      const mockDocuments: DocumentText[] = [
        {
          docId: "billOfLading",
          kind: "billOfLading",
          pages: [pageText],
        },
      ];

      const verified = verifyReadings(readingAnswer, mockDocuments);
      const vesselReading = verified.find((r) => r.field === "billOfLading.vessel");

      // Even with low confidence, lineText should be present
      expect((vesselReading as any).lineText).toBe("Vessel: OWLFERRY DAWN Voyage: 047W");
    });
  });

  describe("Sample bundle: no lineText on text pages", () => {
    it("Example 39.2: Lantern Hollow sample (text pages): no lineText property", () => {
      const verified = verifyReadings(bundleAnswer, bundleDocuments);

      // Verify that no reading has a lineText property
      for (const reading of verified) {
        expect("lineText" in reading).toBe(false);
      }

      // Verify that box and itemIds are as expected (compare with second call after deleting nothing)
      const verified2 = verifyReadings(bundleAnswer, bundleDocuments);

      for (const r1 of verified) {
        const r2 = verified2.find((r) => r.field === r1.field);
        expect(r2).toBeDefined();
        if (r1.status === "accepted" && r2?.status === "accepted") {
          expect(r1.box).toEqual(r2.box);
          expect(r1.itemIds).toEqual(r2.itemIds);
        }
      }
    });
  });
});
