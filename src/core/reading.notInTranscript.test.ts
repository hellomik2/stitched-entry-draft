import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { verifyReadings, NOT_IN_TRANSCRIPT_MESSAGE, type ReadingAnswer, type VerifiedReading } from "./reading";
import { readerOutputToAnswer, composeDocumentTexts, type ReaderInput, type ReaderOutput } from "./readerContract";
import { transcriptToPageText } from "./transcript";
import type { DocumentText, PageText } from "./pdfText";

// Feature: document-intake, Requirement 50.1, 50.2 (task 63.1): on an image page the page text is the AI reader's own
// transcript, so a quote missing from it does not throw a value away; on a text page it still does.

const BUNDLE_C = join(process.cwd(), "samples", "real-reads", "test-bundle-c.json");

/** The recorded real answer of test bundle C with its two image documents only (the text PDF bill of lading is left out). */
function bundleCImagePart(): { input: ReaderInput; output: ReaderOutput } {
  const body = JSON.parse(readFileSync(BUNDLE_C, "utf8"));
  const output: ReaderOutput = {
    ...body.output,
    fields: body.output.fields.filter((f: { doc: string }) => f.doc !== "billOfLading"),
    transcripts: body.output.transcripts.filter((t: { doc: string }) => t.doc !== "billOfLading"),
  };
  const imageDoc = (docId: "invoice" | "packingList") => ({
    docId,
    kind: docId,
    fileName: `${docId}.jpg`,
    fileSha256: "0".repeat(64),
    pages: [{ page: 1, width: 1000, height: 1000, text: null, image: { mediaType: "image/jpeg" as const, base64: "QUJD" } }],
  });
  const input = { bundle: "upload", documents: [imageDoc("invoice"), imageDoc("packingList")] } as unknown as ReaderInput;
  return { input, output };
}

function verifyBundleC(): VerifiedReading[] {
  const { input, output } = bundleCImagePart();
  const answer = readerOutputToAnswer(input, output);
  const docs = composeDocumentTexts([], input, output);
  return verifyReadings(answer, docs);
}

const ACCEPTED_C = ["invoice.number", "invoice.seller.name", "packingList.number", "packingList.invoiceRef", "packingList.blNumber"];

describe("Feature: document-intake, Requirement 50.1: the bundle C recording (short transcripts of two photos)", () => {
  let verified: VerifiedReading[];
  beforeAll(() => {
    verified = verifyBundleC();
  });
  const get = (field: string) => verified.find((v) => v.field === field)!;

  it("57 values wait as uncertain with no box, 1 is rejected because its value is longer than its quote, 5 are accepted", () => {
    const count: Record<string, number> = {};
    for (const v of verified) {
      const key = v.status === "rejected" ? `rejected:${v.reason}` : v.status;
      count[key] = (count[key] ?? 0) + 1;
    }
    expect(verified.length).toBe(63);
    expect(count).toEqual({ accepted: 5, uncertain: 57, "rejected:value_not_in_quote": 1 });
    expect(verified.filter((v) => v.status === "accepted").map((v) => v.field).sort()).toEqual([...ACCEPTED_C].sort());
    expect(verified.filter((v) => v.status === "rejected").map((v) => v.field)).toEqual(["invoice.seller.address"]);
    expect(verified.some((v) => v.status === "rejected" && v.reason === "quote_not_found")).toBe(false);
  });

  it("every uncertain value has no box, no items, the image origin, the flag, the message, and no line text or cell", () => {
    for (const v of verified.filter((x) => x.status === "uncertain")) {
      expect(v).toMatchObject({ status: "uncertain", box: null, itemIds: [], origin: "imageTranscript", notInTranscript: true, message: NOT_IN_TRANSCRIPT_MESSAGE });
      expect("lineText" in v).toBe(false);
      expect("cell" in v).toBe(false);
    }
  });

  it("the message says the line is not in the transcript", () => {
    expect(NOT_IN_TRANSCRIPT_MESSAGE).toBe(
      "The AI reader read this value from a line that is not in its transcript of the image, so there is no box on the page. A person finds it on the page and checks it.",
    );
  });

  it("examples: a line value, the invoice date by the date rule, a packing list total", () => {
    expect(get("invoice.lines.1.description")).toMatchObject({ status: "uncertain", value: "Paper lantern, bat print", box: null });
    expect(get("invoice.date")).toMatchObject({ status: "uncertain", value: "11/06/2026", quote: "Date: Nov 06, 2026", box: null });
    expect(get("packingList.totalGrossKg")).toMatchObject({ status: "uncertain", value: "488.0", box: null });
    expect(get("invoice.seller.address")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
  });

  it("a value whose quote is in the transcript is accepted with its box as today", () => {
    const r = get("invoice.number");
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;
    expect(r.box).not.toBeNull();
    expect(r.notInTranscript).toBeUndefined();
    expect(r.lineText).toBe("Invoice No.: WLW-0457");
  });
});

// Small pages built in the test
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
const lineArb = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 5 }).map((ws) => ws.join(" "));
// Values and labels use capital letters and digits, which no generated line has.
const valueArb = fc.stringMatching(/^ZQ[A-Z0-9]{1,6}$/);
const confidenceArb = fc.constantFrom<("high" | "low" | undefined)>("high", "low", undefined);

function imagePage(lines: string[]): PageText {
  return transcriptToPageText(
    "invoice",
    1,
    1000,
    1000,
    lines.map((t, i) => ({ text: t, box: { x: 0.1, y: 0.05 + i * 0.04, w: 0.6, h: 0.03 } })),
  );
}

function textPage(lines: string[], origin: "textLayer" | "sheet" | undefined): PageText {
  const items = lines.map((str, i) => ({ id: `invoice:p1:t${i + 1}`, str, box: { x: 50, y: 40 + i * 20, w: 300, h: 12 } }));
  const spans: PageText["spans"] = [];
  let pos = 0;
  for (const it of items) {
    spans.push({ itemId: it.id, start: pos, end: pos + it.str.length });
    pos += it.str.length + 1;
  }
  const page: PageText = { page: 1, width: 612, height: 792, items, text: items.map((i) => i.str).join(" "), spans };
  if (origin) page.origin = origin;
  return page;
}

function verifyOne(page: PageText, value: string, quote: string, confidence: "high" | "low" | undefined, field = "invoice.terms"): VerifiedReading {
  const answer: ReadingAnswer = {
    schemaVersion: 1,
    bundle: "test",
    reader: "test",
    documents: [{ docId: "invoice", kind: "invoice" }],
    fields: [{ field, value, quote, doc: "invoice", page: 1, ...(confidence ? { confidence } : {}) }],
  };
  const docs: DocumentText[] = [{ docId: "invoice", kind: "invoice", pages: [page] }];
  return verifyReadings(answer, docs)[0];
}

describe("Feature: document-intake, Property 68: An Image Value Missing From the Transcript Waits, Without a Box (Validates: Requirement 50.1)", () => {
  it("a value inside its quote is uncertain with no box, whatever its confidence; never accepted, never quote_not_found", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 8 }), valueArb, fc.constantFrom("Terms:", "Ref", ""), confidenceArb, (lines, value, label, confidence) => {
        const quote = label ? `${label} ${value}` : value;
        const r = verifyOne(imagePage(lines), value, quote, confidence);
        expect(r.status).toBe("uncertain");
        if (r.status !== "uncertain") return;
        expect(r.box).toBeNull();
        expect(r.itemIds).toEqual([]);
        expect(r.notInTranscript).toBe(true);
        expect(r.origin).toBe("imageTranscript");
        expect(r.message).toBe(NOT_IN_TRANSCRIPT_MESSAGE);
      }),
      { numRuns: 100 },
    );
  });

  it("a value that is not inside its quote is rejected with value_not_in_quote", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 8 }), valueArb, confidenceArb, (lines, value, confidence) => {
        const r = verifyOne(imagePage(lines), `${value}X`, `Terms: ${value}`, confidence);
        expect(r.status).toBe("rejected");
        if (r.status !== "rejected") return;
        expect(r.reason).toBe("value_not_in_quote");
      }),
      { numRuns: 100 },
    );
  });

  it("the date rule of Requirement 35.1 holds for a quote missing from the transcript", () => {
    const r = verifyOne(imagePage(["COMMERCIAL INVOICE"]), "11/06/2026", "Date: Nov 06, 2026", "high", "invoice.date");
    expect(r).toMatchObject({ status: "uncertain", box: null, notInTranscript: true });
    const wrongDay = verifyOne(imagePage(["COMMERCIAL INVOICE"]), "11/07/2026", "Date: Nov 06, 2026", "high", "invoice.date");
    expect(wrongDay).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
  });

  it("the earlier checks come first: a missing value is value_missing, an empty quote is empty_quote", () => {
    const page = imagePage(["alpha bravo"]);
    expect(verifyOne(page, "", "ZQ1", "high")).toMatchObject({ status: "rejected", reason: "value_missing" });
    expect(verifyOne(page, "ZQ1", "   ", "high")).toMatchObject({ status: "rejected", reason: "empty_quote" });
  });

  it("a quote that is in the transcript is checked as today: accepted with the box of its line", () => {
    const r = verifyOne(imagePage(["alpha bravo", "Terms: ZQ7 charlie"]), "ZQ7", "Terms: ZQ7", "high");
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;
    expect(r.box).toEqual({ x: 100, y: 90, w: 600, h: 30 });
    expect(r.notInTranscript).toBeUndefined();
  });

  it("a value on a transcript line with no box waits with no box (Requirement 58.1)", () => {
    const page = transcriptToPageText("invoice", 1, 1000, 1000, [{ text: "Terms: ZQ9", box: null }]);
    expect(verifyOne(page, "ZQ9", "Terms: ZQ9", "high")).toMatchObject({ status: "uncertain", box: null, itemIds: [], lineWithoutBox: true, lineText: "Terms: ZQ9" });
  });
});

describe("Feature: document-intake, Property 69: A Text Page Still Rejects a Quote It Does Not Have (Validates: Requirement 50.2)", () => {
  it("on a PDF text page or a sheet page a quote that is not on the page is rejected with quote_not_found, whatever its confidence", () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 8 }),
        valueArb,
        fc.constantFrom<("textLayer" | "sheet" | undefined)>("textLayer", "sheet", undefined),
        confidenceArb,
        (lines, value, origin, confidence) => {
          const r = verifyOne(textPage(lines, origin), value, `Terms: ${value}`, confidence);
          expect(r.status).toBe("rejected");
          if (r.status !== "rejected") return;
          expect(r.reason).toBe("quote_not_found");
        },
      ),
      { numRuns: 100 },
    );
  });
});
