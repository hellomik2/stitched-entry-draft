import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { verifyReadings, type ReadingAnswer, type VerifiedReading } from "./reading";
import { readerOutputToAnswer, composeDocumentTexts, type ReaderInput, type ReaderOutput } from "./readerContract";
import { transcriptToPageText } from "./transcript";
import type { DocKind, PageText } from "./pdfText";

// Feature: document-intake, Requirement 59 (task 74.1): a number field written without its thousands commas is inside its quote
// at the printed number with commas that gives the same digits; nothing else changes.

const NUMBER_FIELDS = [
  "invoice.lines.1.quantity",
  "invoice.lines.3.unitPrice",
  "invoice.lines.8.amount",
  "invoice.subtotal",
  "invoice.total",
  "packingList.lines.1.cartons",
  "packingList.lines.2.quantity",
  "packingList.lines.5.netKg",
  "packingList.lines.8.grossKg",
  "packingList.totalCartons",
  "packingList.totalQuantity",
  "packingList.totalNetKg",
  "packingList.totalGrossKg",
  "billOfLading.grossKg",
];
const OTHER_FIELDS = ["invoice.number", "invoice.lines.1.itemNo", "invoice.lines.1.hts", "packingList.number", "packingList.lines.1.itemNo", "billOfLading.number", "billOfLading.containerNo", "billOfLading.packages", "invoice.terms"];

const kindOf = (field: string): DocKind => field.split(".")[0] as DocKind;

/** One printed line on a text page, one item per word, 40 points per word. */
function textLine(words: string[]): PageText {
  const items = words.map((str, i) => ({ id: `d:p1:t${i + 1}`, str, box: { x: 40 + i * 60, y: 100, w: 50, h: 10 } }));
  const spans: PageText["spans"] = [];
  let pos = 0;
  for (const it of items) {
    spans.push({ itemId: it.id, start: pos, end: pos + it.str.length });
    pos += it.str.length + 1;
  }
  return { page: 1, width: 612, height: 792, items, text: words.join(" "), spans };
}

function verifyOn(page: PageText, field: string, value: string, quote: string, confidence?: "high" | "low"): VerifiedReading {
  const kind = kindOf(field);
  const answer: ReadingAnswer = {
    schemaVersion: 1,
    bundle: "t",
    reader: "t",
    documents: [{ docId: kind, kind }],
    fields: [{ field, value, quote, doc: kind, page: 1, ...(confidence ? { confidence } : {}) }],
  };
  return verifyReadings(answer, [{ docId: kind, kind, pages: [page] }])[0];
}

const imagePage = (field: string, lines: string[]): PageText =>
  transcriptToPageText(kindOf(field), 1, 1000, 1000, lines.map((t, i) => ({ text: t, box: { x: 0.1, y: 0.1 + i * 0.1, w: 0.6, h: 0.05 } })));

describe("Feature: document-intake, Requirement 59.5: the bundle A recording", () => {
  it("billOfLading.grossKg 1284.0 with the quote 1,284.0 KGS is accepted with the box of its transcript line", () => {
    const body = JSON.parse(readFileSync(join(process.cwd(), "samples", "real-reads", "test-bundle-a.json"), "utf8"));
    const output: ReaderOutput = {
      ...body.output,
      fields: body.output.fields.filter((f: { doc: string }) => f.doc === "billOfLading"),
      transcripts: body.output.transcripts.filter((t: { doc: string }) => t.doc === "billOfLading"),
    };
    const input = {
      bundle: "upload",
      documents: [{ docId: "billOfLading", kind: "billOfLading", fileName: "bl.jpg", fileSha256: "0".repeat(64), pages: [{ page: 1, width: 1000, height: 1000, text: null, image: { mediaType: "image/jpeg", base64: "QUJD" } }] }],
    } as unknown as ReaderInput;
    const verified = verifyReadings(readerOutputToAnswer(input, output), composeDocumentTexts([], input, output));
    const r = verified.find((v) => v.field === "billOfLading.grossKg")!;
    expect(r).toMatchObject({
      status: "accepted",
      value: "1284.0",
      quote: "1,284.0 KGS",
      box: { x: 180, y: 750, w: 800, h: 80 },
      origin: "imageTranscript",
      lineText: "ZZZU 418207 3 / SMPL-0000 77 CTNS Ceramic and glass home decor, tin lanterns, artificial stems 1,284.0 KGS 9.8 CBM",
    });
    expect(verified.filter((v) => v.status === "rejected").map((v) => v.field)).toEqual([]);
  });
});

describe("Feature: document-intake, Requirement 59.2 and 59.3: on a text page", () => {
  const page = textLine(["Gross", "weight:", "1,284.0", "KGS"]);
  const quote = "Gross weight: 1,284.0 KGS";

  it("1284.0 is inside the quote, with the box of the printed number", () => {
    const r = verifyOn(page, "billOfLading.grossKg", "1284.0", quote);
    expect(r).toMatchObject({ status: "accepted", value: "1284.0", box: { x: 160, y: 100, w: 50, h: 10 }, itemIds: ["d:p1:t3"] });
  });

  it("a quote that does not start the page: the box of the printed number, not of the start of the page", () => {
    const p = textLine(["Shipper", "Gloam", "Gross", "weight:", "1,284.0", "KGS"]);
    expect(verifyOn(p, "billOfLading.grossKg", "1284.0", quote)).toMatchObject({ status: "accepted", box: { x: 280, y: 100, w: 50, h: 10 }, itemIds: ["d:p1:t5"] });
  });

  it("with confidence low it is uncertain with the same box", () => {
    expect(verifyOn(page, "billOfLading.grossKg", "1284.0", quote, "low")).toMatchObject({ status: "uncertain", box: { x: 160, y: 100, w: 50, h: 10 } });
  });

  it("a value with one digit or the period different is rejected with value_not_in_quote", () => {
    for (const v of ["1284", "1284.00", "1248.0", "12840", "1284.1", "11284.0", "128.40"]) {
      expect([v, verifyOn(page, "billOfLading.grossKg", v, quote)]).toMatchObject([v, { status: "rejected", reason: "value_not_in_quote" }]);
    }
  });

  it("a number with two groups and decimals, and a quantity without decimals", () => {
    const p = textLine(["Total", "12,345,678.25"]);
    expect(verifyOn(p, "invoice.total", "12345678.25", "Total 12,345,678.25")).toMatchObject({ status: "accepted", itemIds: ["d:p1:t2"] });
    const q = textLine(["Qty", "4,980", "PCS"]);
    expect(verifyOn(q, "packingList.totalQuantity", "4980", "Qty 4,980 PCS")).toMatchObject({ status: "accepted", itemIds: ["d:p1:t2"] });
    expect(verifyOn(q, "packingList.totalQuantity", "498", "Qty 4,980 PCS")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
  });

  it("the first printed number with the same digits is used", () => {
    const p = textLine(["1,200", "PCS", "of", "1,200"]);
    expect(verifyOn(p, "invoice.lines.1.quantity", "1200", "1,200 PCS of 1,200")).toMatchObject({ status: "accepted", itemIds: ["d:p1:t1"] });
  });
});

describe("Feature: document-intake, Requirement 59.4: where the rule does not apply", () => {
  it("a value with a comma, a sign, a currency, a unit or a space is rejected as today", () => {
    const page = textLine(["Gross", "1284.0", "KGS"]);
    expect(verifyOn(page, "billOfLading.grossKg", "1,284.0", "Gross 1284.0 KGS")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
    const p2 = textLine(["Total", "USD", "9,840.00"]);
    for (const v of ["USD 9840.00", "+9840.00", "-9840.00", "9840.00 USD", "9 840.00"]) {
      expect([v, verifyOn(p2, "invoice.total", v, "Total USD 9,840.00")]).toMatchObject([v, { status: "rejected", reason: "value_not_in_quote" }]);
    }
  });

  it("a decimal comma and a comma that is not a thousands group are not printed numbers with thousands commas", () => {
    const eur = textLine(["Total", "EUR", "9.299,00"]);
    expect(verifyOn(eur, "invoice.total", "9299.00", "Total EUR 9.299,00")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
    expect(verifyOn(eur, "invoice.total", "929900", "Total EUR 9.299,00")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
    const odd = textLine(["Gross", "1,24.8", "KGS"]);
    expect(verifyOn(odd, "billOfLading.grossKg", "124.8", "Gross 1,24.8 KGS")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
    const glued = textLine(["Ref", "A1,284.0", "KGS"]);
    expect(verifyOn(glued, "billOfLading.grossKg", "1284.0", "Ref A1,284.0 KGS")).toMatchObject({ status: "accepted" });
    const glued2 = textLine(["Ref", "11,284.0.5"]);
    expect(verifyOn(glued2, "billOfLading.grossKg", "1284.0", "Ref 11,284.0.5")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
  });

  it("no other field gets the rule", () => {
    for (const field of OTHER_FIELDS) {
      const page = textLine(["No.", "1,284.0"]);
      expect([field, verifyOn(page, field, "1284.0", "No. 1,284.0")]).toMatchObject([field, { status: "rejected", reason: "value_not_in_quote" }]);
    }
  });
});

describe("Feature: document-intake, Requirement 59.3: on an image page", () => {
  it("a quote in the transcript: accepted with the box of its line, as an image reading", () => {
    const page = imagePage("billOfLading.grossKg", ["BILL OF LADING", "77 CTNS 1,284.0 KGS"]);
    expect(verifyOn(page, "billOfLading.grossKg", "1284.0", "1,284.0 KGS")).toMatchObject({ status: "accepted", box: { x: 100, y: 200, w: 600, h: 50 }, origin: "imageTranscript", lineText: "77 CTNS 1,284.0 KGS" });
  });

  it("a quote not in the transcript waits as Requirement 50.1 says", () => {
    const page = imagePage("billOfLading.grossKg", ["BILL OF LADING"]);
    expect(verifyOn(page, "billOfLading.grossKg", "1284.0", "1,284.0 KGS")).toMatchObject({ status: "uncertain", box: null, notInTranscript: true });
    expect(verifyOn(page, "billOfLading.grossKg", "1284.5", "1,284.0 KGS")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
  });

  it("the check of Requirement 50.8 uses the printed number: a number put into a transcribed line is rejected", () => {
    const page = imagePage("billOfLading.grossKg", ["BILL OF LADING", "Gross weight KGS"]);
    expect(verifyOn(page, "billOfLading.grossKg", "1284.0", "Gross weight 1,284.0 KGS")).toMatchObject({ status: "rejected", reason: "quote_not_found" });
  });
});

// A printed number with thousands commas: 1 to 3 digits, 1 or 2 groups, an optional decimal part of 1 to 3 digits.
const printedArb = fc
  .record({ head: fc.integer({ min: 1, max: 999 }), groups: fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 2 }), dec: fc.option(fc.stringMatching(/^[0-9]{1,3}$/), { nil: undefined }) })
  .map(({ head, groups, dec }) => `${head}${groups.map((g) => "," + String(g).padStart(3, "0")).join("")}${dec !== undefined ? "." + dec : ""}`);
const labelArb = fc.constantFrom("Gross", "Total", "Qty", "Net weight:", "Amount");
const unitArb = fc.constantFrom("KGS", "PCS", "CTNS", "USD", "");

/** Values that differ from the digits d in one character: a digit changed, added or removed, the period added or removed. */
function oneOff(d: string, pick: number, digit: string): string[] {
  const i = pick % d.length;
  const out: string[] = [];
  if (/[0-9]/.test(d[i])) out.push(d.slice(0, i) + (d[i] === digit ? String((Number(digit) + 1) % 10) : digit) + d.slice(i + 1));
  out.push(d.slice(0, i) + digit + d.slice(i));
  out.push(d + digit);
  if (/[0-9]/.test(d[i]) && d.length > 1) out.push(d.slice(0, i) + d.slice(i + 1));
  out.push(d.includes(".") ? d.replace(".", "") : d.slice(0, i + 1) + "." + d.slice(i + 1));
  return out.filter((v) => v !== d && /^[0-9]+(\.[0-9]+)?$/.test(v));
}

describe("Feature: document-intake, Property 79: A Number Without Its Thousands Commas Matches Only Its Own Digits (Validates: Requirements 59.1, 59.2, 59.4)", () => {
  it("the digits of the printed number are inside the quote; one character off is rejected; another field is rejected", () => {
    fc.assert(
      fc.property(printedArb, labelArb, unitArb, fc.constantFrom(...NUMBER_FIELDS), fc.constantFrom(...OTHER_FIELDS), fc.nat(), fc.constantFrom(..."0123456789".split("")), (p, label, unit, field, other, pick, digit) => {
        const words = [...label.split(" "), p, ...(unit ? [unit] : [])];
        const page = textLine(["Ref", "ZZ", ...words]);
        const quote = words.join(" ");
        const digits = p.replace(/,/g, "");
        const at = words.indexOf(p) + 3;
        expect(verifyOn(page, field, digits, quote)).toMatchObject({ status: "accepted", itemIds: [`d:p1:t${at}`] });
        for (const v of oneOff(digits, pick, digit)) {
          if (quote.includes(v)) continue;
          expect([v, verifyOn(page, field, v, quote)]).toMatchObject([v, { status: "rejected", reason: "value_not_in_quote" }]);
        }
        expect([other, verifyOn(page, other, digits, quote)]).toMatchObject([other, { status: "rejected", reason: "value_not_in_quote" }]);
      }),
      { numRuns: 200 },
    );
  });
});
