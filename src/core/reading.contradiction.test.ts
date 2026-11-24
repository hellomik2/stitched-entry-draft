import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { verifyReadings, NOT_IN_TRANSCRIPT_MESSAGE } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import type { DocumentText, PageText } from "./pdfText";
import { transcriptToPageText } from "./transcript";
import { loadBundleFromDisk } from "../node/index";

// Requirement 50.8 (2026-11-24): on an image page, a quote missing from the transcript is still rejected with
// "quote_not_found" when the transcript has the quote's line without the value: the value sits between two non-empty
// parts of its quote, and the part before, one space and the part after occur in the page text. The sample bundle's
// line 7 origin (a deliberate fabricated quote) is such a reading.

function imagePage(lines: string[]): PageText {
  return transcriptToPageText(
    "invoice",
    1,
    1000,
    1000,
    lines.map((t, i) => ({ text: t, box: { x: 0.1, y: 0.05 + i * 0.04, w: 0.6, h: 0.03 } })),
  );
}

function verifyOne(page: PageText, value: string, quote: string, confidence: "high" | "low" | undefined): VerifiedReading {
  const answer: ReadingAnswer = {
    schemaVersion: 1,
    bundle: "test",
    reader: "test",
    documents: [{ docId: "invoice", kind: "invoice" }],
    fields: [{ field: "invoice.terms", value, quote, doc: "invoice", page: 1, ...(confidence ? { confidence } : {}) }],
  };
  const docs: DocumentText[] = [{ docId: "invoice", kind: "invoice", pages: [page] }];
  return verifyReadings(answer, docs)[0];
}

// Lines use small words only; values use capital letters and digits, which no generated line has.
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
const lineArb = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 5 }).map((ws) => ws.join(" "));
const valueArb = fc.stringMatching(/^ZQ[A-Z0-9]{1,6}$/);
const confidenceArb = fc.constantFrom<("high" | "low" | undefined)>("high", "low", undefined);

describe("Feature: document-intake, Requirement 50.8: A Value Put Into a Transcribed Line Is Rejected", () => {
  it("the sample bundle with every page an image page: line 7 origin is rejected with quote_not_found and the text page's message, every other reading is accepted", async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    const imageDocs = bundle.documents.map((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, origin: "imageTranscript" as const })) }));
    const onText = verifyReadings(bundle.answer, bundle.documents);
    const onImage = verifyReadings(bundle.answer, imageDocs);
    const l7 = onImage.find((v) => v.field === "invoice.lines.7.origin")!;
    const l7Text = onText.find((v) => v.field === "invoice.lines.7.origin")!;
    expect(l7).toMatchObject({ status: "rejected", reason: "quote_not_found" });
    expect(l7Text).toMatchObject({ status: "rejected", reason: "quote_not_found" });
    expect(l7.status === "rejected" && l7Text.status === "rejected" ? l7.message : null).toBe(l7Text.status === "rejected" ? l7Text.message : "");
    expect(onImage.filter((v) => v.status !== "accepted").map((v) => v.field)).toEqual(["invoice.lines.7.origin"]);
  });

  it("Property 72: a value between two parts of its quote that the transcript has side by side is rejected with quote_not_found, whatever its confidence", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 0, maxLength: 6 }), lineArb, lineArb, valueArb, confidenceArb, (others, left, right, value, confidence) => {
        const r = verifyOne(imagePage([...others, `${left} ${right}`]), value, `${left} ${value} ${right}`, confidence);
        expect(r.status).toBe("rejected");
        if (r.status === "rejected") expect(r.reason).toBe("quote_not_found");
      }),
      { numRuns: 200 },
    );
  });

  it("Property 72: when the transcript does not have the two parts side by side, the value waits as not in the transcript (Property 68)", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 6 }), valueArb, confidenceArb, (lines, value, confidence) => {
        const r = verifyOne(imagePage(lines), value, `Ref ${value} due`, confidence);
        expect(r).toMatchObject({ status: "uncertain", box: null, itemIds: [], notInTranscript: true, message: NOT_IN_TRANSCRIPT_MESSAGE });
      }),
      { numRuns: 200 },
    );
  });

  it("a value at the start or the end of its quote is not checked this way and waits as not in the transcript", () => {
    const page = imagePage(["Terms:", "Net days"]);
    expect(verifyOne(page, "ZQ30", "Terms: ZQ30", "high")).toMatchObject({ status: "uncertain", box: null, notInTranscript: true });
    expect(verifyOne(page, "ZQ30", "ZQ30 Net days", "high")).toMatchObject({ status: "uncertain", box: null, notInTranscript: true });
    expect(verifyOne(page, "ZQ30", "Net ZQ30 days", "high")).toMatchObject({ status: "rejected", reason: "quote_not_found" });
  });
});
