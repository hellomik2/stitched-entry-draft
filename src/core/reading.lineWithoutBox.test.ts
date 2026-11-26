import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { verifyReadings, LINE_WITHOUT_BOX_MESSAGE, type ReadingAnswer, type VerifiedReading } from "./reading";
import { readerOutputToAnswer, composeDocumentTexts, type ReaderInput, type ReaderOutput } from "./readerContract";
import { transcriptToPageText, type TranscriptLine } from "./transcript";
import type { DocumentText } from "./pdfText";

// Feature: document-intake, Requirement 58.1, 58.2, 58.7 (task 73.1): on an image page a value whose box would come from a
// transcript line with no usable place waits for a person with no box, instead of being rejected with "no_source_box".

const BUNDLE_A = join(process.cwd(), "samples", "real-reads", "test-bundle-a.json");

/** The recorded real answer of test bundle A (2026-11-26) with its two image documents only (the invoice text PDF is left out). */
function bundleAImagePart(): { input: ReaderInput; output: ReaderOutput } {
  const body = JSON.parse(readFileSync(BUNDLE_A, "utf8"));
  const output: ReaderOutput = {
    ...body.output,
    fields: body.output.fields.filter((f: { doc: string }) => f.doc !== "invoice"),
    transcripts: body.output.transcripts.filter((t: { doc: string }) => t.doc !== "invoice"),
  };
  const imageDoc = (docId: "packingList" | "billOfLading") => ({
    docId,
    kind: docId,
    fileName: `${docId}.jpg`,
    fileSha256: "0".repeat(64),
    pages: [{ page: 1, width: 1000, height: 1000, text: null, image: { mediaType: "image/jpeg" as const, base64: "QUJD" } }],
  });
  const input = { bundle: "upload", documents: [imageDoc("packingList"), imageDoc("billOfLading")] } as unknown as ReaderInput;
  return { input, output };
}

function verifyBundleA(): VerifiedReading[] {
  const { input, output } = bundleAImagePart();
  return verifyReadings(readerOutputToAnswer(input, output), composeDocumentTexts([], input, output));
}

const ROW1 = "MCA-101 Stoneware owl figurine 1-20 20 1,200 420.0 468.0";
const ROW4 = "MCA-104 Artificial bittersweet stems 60-65 6 600 30.0 39.0";
const ROW5 = "MCA-105 Ceramic pumpkin, small 66-77 12 480 456 62.0 72.0";
const TOTAL = "TOTAL 77 4,980 1,103.0 1,248.0";

describe("Feature: document-intake, Requirement 58.7: the bundle A recording (8 of 16 lines of the scanned packing list have no box)", () => {
  let verified: VerifiedReading[];
  beforeAll(() => {
    verified = verifyBundleA();
  });
  const get = (field: string) => verified.find((v) => v.field === field)!;
  const packing = () => verified.filter((v) => v.doc === "packingList");

  it("the 28 values of packing list lines 1 to 5 and of the totals wait as uncertain, the 3 header values are accepted, none is rejected", () => {
    const count: Record<string, number> = {};
    for (const v of packing()) {
      const key = v.status === "rejected" ? `rejected:${v.reason}` : v.status;
      count[key] = (count[key] ?? 0) + 1;
    }
    expect(count).toEqual({ accepted: 3, uncertain: 28 });
    expect(packing().filter((v) => v.status === "accepted").map((v) => v.field)).toEqual(["packingList.number", "packingList.invoiceRef", "packingList.blNumber"]);
    expect(verified.some((v) => v.status === "rejected" && v.reason === "no_source_box")).toBe(false);
  });

  it("26 of them have confidence high and 2 low: the item number of line 5 and the quantity total", () => {
    const low = packing().filter((v) => v.status === "uncertain" && v.confidence === "low").map((v) => v.field);
    expect(low).toEqual(["packingList.lines.5.itemNo", "packingList.totalQuantity"]);
    expect(packing().filter((v) => v.status === "uncertain" && v.confidence !== "low").length).toBe(26);
  });

  it("every one has no box, no items, the image origin, the flag, the message, its transcript line, and no notInTranscript or cell", () => {
    for (const v of packing().filter((x) => x.status === "uncertain")) {
      expect(v).toMatchObject({ status: "uncertain", box: null, itemIds: [], origin: "imageTranscript", lineWithoutBox: true, message: LINE_WITHOUT_BOX_MESSAGE });
      expect([ROW1, "MCA-102 Glass votive candle holder 21-44 24 2,400 336.0 384.0", "MCA-103 Tin lantern 45-59 15 300 255.0 285.0", ROW4, ROW5, TOTAL]).toContain(
        (v as { lineText?: string }).lineText,
      );
      expect("notInTranscript" in v).toBe(false);
      expect("cell" in v).toBe(false);
    }
  });

  it("the transcript line is the line the value was found on, also for a short quote that repeats on the page", () => {
    expect(get("packingList.lines.1.cartons")).toMatchObject({ status: "uncertain", value: "20", lineText: ROW1 });
    expect(get("packingList.lines.4.cartons")).toMatchObject({ status: "uncertain", value: "6", quote: "6", lineText: ROW4 });
    expect(get("packingList.totalCartons")).toMatchObject({ status: "uncertain", value: "77", quote: "77", lineText: TOTAL });
    expect(get("packingList.totalGrossKg")).toMatchObject({ status: "uncertain", value: "1,248.0", lineText: TOTAL, confidence: "high" });
    expect(get("packingList.lines.5.itemNo")).toMatchObject({ status: "uncertain", value: "MCA-105", lineText: ROW5, confidence: "low", lineWithoutBox: true });
  });

  it("the message says the transcript line has no usable place", () => {
    expect(LINE_WITHOUT_BOX_MESSAGE).toBe(
      "The AI reader read this value from a line of its transcript that it gave no usable place for, so there is no box on the page. A person finds it on the page and checks it.",
    );
  });

  it("a value on a transcript line with a box is accepted with the box of its line as today", () => {
    const r = get("billOfLading.vessel");
    expect(r).toMatchObject({ status: "accepted", box: { x: 180, y: 620, w: 600, h: 50 }, lineText: "Vessel: OWLFERRY DAWN Voyage: 047W", origin: "imageTranscript" });
    expect("lineWithoutBox" in r).toBe(false);
    expect(get("packingList.number")).toMatchObject({ status: "accepted", box: { x: 125, y: 170, w: 300, h: 30 } });
  });
});

describe("Feature: document-intake, Requirement 58.2: the other no_source_box and the earlier checks stay", () => {
  const one = (lines: TranscriptLine[], field: string, value: string, quote: string, confidence?: "high" | "low"): VerifiedReading => {
    const page = transcriptToPageText("billOfLading", 1, 1000, 1000, lines);
    const answer: ReadingAnswer = {
      schemaVersion: 1,
      bundle: "t",
      reader: "t",
      documents: [{ docId: "billOfLading", kind: "billOfLading" }],
      fields: [{ field, value, quote, doc: "billOfLading", page: 1, ...(confidence ? { confidence } : {}) }],
    };
    return verifyReadings(answer, [{ docId: "billOfLading", kind: "billOfLading", pages: [page] }])[0];
  };
  const noBox: TranscriptLine[] = [{ text: "Port of discharge: Charleston, SC, USA", box: null }];

  it("a value that is not inside its quote is rejected with value_not_in_quote, a quote not in the transcript waits as Requirement 50.1 says", () => {
    expect(one(noBox, "billOfLading.portOfDischarge", "Savannah", "Port of discharge: Charleston, SC, USA")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
    expect(one(noBox, "billOfLading.portOfDischarge", "Savannah", "Port of discharge: Savannah")).toMatchObject({ status: "uncertain", notInTranscript: true, box: null });
  });

  it("a missing value and an empty quote are rejected as today", () => {
    expect(one(noBox, "billOfLading.portOfDischarge", "", "Port of discharge: Charleston, SC, USA")).toMatchObject({ status: "rejected", reason: "value_missing" });
    expect(one(noBox, "billOfLading.portOfDischarge", "Charleston, SC, USA", "  ")).toMatchObject({ status: "rejected", reason: "empty_quote" });
  });

  it("with confidence low it waits the same way, with the same message", () => {
    expect(one(noBox, "billOfLading.portOfDischarge", "Charleston, SC, USA", "Port of discharge: Charleston, SC, USA", "low")).toMatchObject({
      status: "uncertain",
      box: null,
      itemIds: [],
      lineWithoutBox: true,
      confidence: "low",
      message: LINE_WITHOUT_BOX_MESSAGE,
      lineText: "Port of discharge: Charleston, SC, USA",
    });
  });

  it("a text page item never gets the flag (a text page has no item without a box)", () => {
    const page = {
      page: 1,
      width: 612,
      height: 792,
      items: [{ id: "i1", str: "Port of discharge: Charleston, SC, USA", box: { x: 10, y: 10, w: 200, h: 10 } }],
      text: "Port of discharge: Charleston, SC, USA",
      spans: [{ itemId: "i1", start: 0, end: 38 }],
    };
    const docs: DocumentText[] = [{ docId: "billOfLading", kind: "billOfLading", pages: [page] }];
    const answer: ReadingAnswer = {
      schemaVersion: 1,
      bundle: "t",
      reader: "t",
      documents: [{ docId: "billOfLading", kind: "billOfLading" }],
      fields: [{ field: "billOfLading.portOfDischarge", value: "Charleston, SC, USA", quote: "Port of discharge: Charleston, SC, USA", doc: "billOfLading", page: 1 }],
    };
    const r = verifyReadings(answer, docs)[0];
    expect(r).toMatchObject({ status: "accepted", box: { x: 10, y: 10, w: 200, h: 10 } });
    expect("lineWithoutBox" in r).toBe(false);
  });
});

// Lines of capital words and digits; a value is one word of its line.
const WORD = fc.stringMatching(/^[A-Z][A-Z0-9]{2,6}$/);
const lineArb = fc.array(WORD, { minLength: 2, maxLength: 5 });

describe("Feature: document-intake, Property 77: A Value on a Transcript Line With No Usable Place Waits, Without a Box (Validates: Requirements 58.1, 58.2)", () => {
  it("a reading on a line without a box is uncertain with no box and the flag, whatever its confidence; a reading on a line with a box is as today", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ words: lineArb, hasBox: fc.boolean(), pick: fc.nat(), confidence: fc.constantFrom<("high" | "low" | undefined)>("high", "low", undefined) }), { minLength: 1, maxLength: 8 }),
        (rows) => {
          // Number each line so every line text is different from the others.
          const texts = rows.map((r, i) => `L${i}Q ${r.words.join(" ")}`);
          const lines: TranscriptLine[] = rows.map((r, i) => ({ text: texts[i], box: r.hasBox ? { x: 0.1, y: 0.05 + i * 0.1, w: 0.6, h: 0.05 } : null }));
          const page = transcriptToPageText("packingList", 1, 1000, 1000, lines);
          const fields = rows.map((r, i) => ({
            field: `packingList.q${i}`,
            value: r.words[r.pick % r.words.length],
            quote: texts[i],
            doc: "packingList",
            page: 1,
            ...(r.confidence ? { confidence: r.confidence } : {}),
          }));
          const answer: ReadingAnswer = { schemaVersion: 1, bundle: "t", reader: "t", documents: [{ docId: "packingList", kind: "packingList" }], fields };
          const verified = verifyReadings(answer, [{ docId: "packingList", kind: "packingList", pages: [page] }]);
          rows.forEach((r, i) => {
            const v = verified[i];
            if (r.hasBox) {
              expect(v.status).toBe(r.confidence === "low" ? "uncertain" : "accepted");
              if (v.status === "rejected") return;
              expect(v.box).toEqual({ x: 100, y: 50 + i * 100, w: 600, h: 50 });
              expect("lineWithoutBox" in v).toBe(false);
            } else {
              expect(v).toMatchObject({ status: "uncertain", box: null, itemIds: [], origin: "imageTranscript", lineWithoutBox: true, lineText: texts[i], message: LINE_WITHOUT_BOX_MESSAGE });
              expect("notInTranscript" in v).toBe(false);
            }
          });
        },
      ),
      { numRuns: 150 },
    );
  });
});
