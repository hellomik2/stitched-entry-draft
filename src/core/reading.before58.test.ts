import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { verifyReadings, LINE_WITHOUT_BOX_MESSAGE, type ReadingAnswer, type VerifiedReading } from "./reading";
import { verifyReadings as verifyBefore } from "./reading.before58";
import { readerOutputToAnswer, composeDocumentTexts, type ReaderInput, type ReaderOutput } from "./readerContract";
import { transcriptToPageText } from "./transcript";
import type { DocumentText, PageText } from "./pdfText";
import { loadBundleFromDisk } from "../node/index";

// Feature: document-intake, Property 81 (task 76.1): the check of Requirements 58 to 60 gives what the check of commit d4bfff6
// gives (src/core/reading.before58.ts, a byte copy), except the readings the new rules keep: a value on a transcript line with
// no usable place (58.1), and a number field or an address field that the old check rejected with "value_not_in_quote" (59, 60).

const NUMBER = /^(invoice\.lines\.\d+\.(quantity|unitPrice|amount)|invoice\.(subtotal|total)|packingList\.lines\.\d+\.(cartons|quantity|netKg|grossKg)|packingList\.total(Cartons|Quantity|NetKg|GrossKg)|billOfLading\.grossKg)$/;
const ADDRESS = /^invoice\.(seller|buyer|shipTo)\.address$/;
const OLD_LINE_MESSAGE = "The value was found on a line of the image that the AI reader gave no usable place for, so there is nothing to point to.";

const FIELDS = [
  "invoice.seller.address",
  "invoice.buyer.address",
  "invoice.shipTo.address",
  "invoice.seller.name",
  "invoice.terms",
  "invoice.date",
  "invoice.total",
  "invoice.lines.1.quantity",
  "invoice.lines.1.amount",
  "invoice.lines.1.itemNo",
  "invoice.lines.2.description",
  "invoice.number",
];
const TOKENS = ["Rua das Corujas 12, Vila Nevoa", "0000-000 Portugal", "Same as importer", "Gross 1,284.0 KGS", "1,200", "1200", "PCS", "Total USD 9,840.00", "9840.00", "Date: 03 Nov 2026", "MCA-101", "Lot 9", "Viet Nam", "Terms: FOB", "77 CTNS", "4,980", "12"];
const textArb = fc.array(fc.constantFrom(...TOKENS), { minLength: 1, maxLength: 3 }).map((ts) => ts.join(" "));

type Pick = { field: string; quoteHow: number; quoteAt: number; valueHow: number; valueAt: number; len: number; confidence?: "high" | "low" };
const pickArb: fc.Arbitrary<Pick> = fc.record({
  field: fc.constantFrom(...FIELDS),
  quoteHow: fc.nat(5),
  quoteAt: fc.nat(),
  valueHow: fc.nat(6),
  valueAt: fc.nat(),
  len: fc.integer({ min: 1, max: 30 }),
  confidence: fc.constantFrom<("high" | "low" | undefined)>("high", "low", undefined),
});

/** A quote and a value made from the page's item texts in the ways the AI reader writes them, right or wrong. */
function reading(texts: string[], below: (i: number) => number | null, p: Pick) {
  const i = p.quoteAt % texts.length;
  const next = i + 1 < texts.length ? texts[i + 1] : "";
  const b = below(i);
  // 5: the item and the one below it, a stacked run of Requirement 35.3 on a text page
  const quote = [texts[i], `${texts[i]} ${next}`.trim(), texts[i].slice(p.valueAt % Math.max(1, texts[i].length - 1)), "Gross 1,284.0 KGS", "Same as importer", b !== null ? `${texts[i]} ${texts[b]}` : texts[i]][p.quoteHow];
  const start = p.valueAt % Math.max(1, quote.length);
  const value = [
    quote.slice(start, start + p.len),
    quote.replace(/(\d),(\d{3})/g, "$1$2"),
    b !== null ? `${texts[i]}, ${texts[b]}` : texts[i],
    texts[(i + 2) % texts.length],
    "",
    quote,
    "11/03/2026",
  ][p.valueHow];
  return { field: p.field, value, quote, confidence: p.confidence };
}

function answerOf(doc: string, kind: "invoice", rs: { field: string; value: string; quote: string; confidence?: "high" | "low" }[]): ReadingAnswer {
  return {
    schemaVersion: 1,
    bundle: "t",
    reader: "t",
    documents: [{ docId: doc, kind }],
    fields: rs.map((r) => ({ field: r.field, value: r.value, quote: r.quote, doc, page: 1, ...(r.confidence ? { confidence: r.confidence } : {}) })),
  };
}

/** Compare one reading of the new check with the old one. */
function same(oldR: VerifiedReading, newR: VerifiedReading, image: boolean) {
  if (!image) expect("lineWithoutBox" in newR).toBe(false);
  // Requirement 61: a number field reading may now be rejected because its value is only inside longer printed numbers, also one
  // the old check rejected with "no_source_box" for a line with no usable place (Property 82 checks this exactly against b41d1cc).
  if (NUMBER.test(oldR.field) && newR.status === "rejected" && newR.reason === "value_not_in_quote" && !(oldR.status === "rejected" && oldR.reason === "value_not_in_quote")) return;
  if (image && oldR.status === "rejected" && oldR.reason === "no_source_box" && oldR.message === OLD_LINE_MESSAGE) {
    const { reason: _r, message: _m, status: _s, ...rest } = oldR;
    expect(newR).toMatchObject({ ...rest, status: "uncertain", box: null, itemIds: [], origin: "imageTranscript", lineWithoutBox: true, message: LINE_WITHOUT_BOX_MESSAGE });
    return;
  }
  if (oldR.status === "rejected" && oldR.reason === "value_not_in_quote" && (NUMBER.test(oldR.field) || ADDRESS.test(oldR.field))) {
    if (newR.status === "rejected") expect(["value_not_in_quote", "quote_not_found"]).toContain(newR.reason);
    return;
  }
  expect(newR).toEqual(oldR);
}

describe("Feature: document-intake, Property 81: The New Rules Keep Only What the Old Check Rejected (Validates: Requirements 58.2, 59.4, 60.3)", () => {
  it("text pages (two columns): every reading is judged as before, except a number or an address field the old check rejected with value_not_in_quote", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(textArb, textArb), { minLength: 1, maxLength: 6 }), fc.array(pickArb, { minLength: 1, maxLength: 4 }), fc.boolean(), (rows, picks, sheet) => {
        const items = rows.flatMap(([a, bb], r) => [
          { id: `invoice:p1:i${2 * r + 1}`, str: a, box: { x: 50, y: 40 + r * 14, w: 200, h: 10 } },
          { id: `invoice:p1:i${2 * r + 2}`, str: bb, box: { x: 300, y: 40 + r * 14, w: 200, h: 10 } },
        ]);
        const spans: PageText["spans"] = [];
        let pos = 0;
        for (const it of items) {
          spans.push({ itemId: it.id, start: pos, end: pos + it.str.length });
          pos += it.str.length + 1;
        }
        const page: PageText = { page: 1, width: 612, height: 792, items, text: items.map((x) => x.str).join(" "), spans, ...(sheet ? { origin: "sheet" as const } : {}) };
        const texts = items.map((x) => x.str);
        const below = (i: number) => (i + 2 < texts.length ? i + 2 : null);
        const docs: DocumentText[] = [{ docId: "invoice", kind: "invoice", pages: [page] }];
        const answer = answerOf("invoice", "invoice", picks.map((p) => reading(texts, below, p)));
        const oldV = verifyBefore(answer, docs) as VerifiedReading[];
        const newV = verifyReadings(answer, docs);
        oldV.forEach((o, i) => same(o, newV[i], false));
      }),
      { numRuns: 300 },
    );
  });

  it("image transcripts (any lines without a box): every reading is judged as before, except the readings the new rules keep", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(textArb, fc.boolean()), { minLength: 1, maxLength: 8 }), fc.array(pickArb, { minLength: 1, maxLength: 4 }), (lines, picks) => {
        const page = transcriptToPageText("invoice", 1, 1000, 1000, lines.map(([t, hasBox], i) => ({ text: t, box: hasBox ? { x: 0.1, y: 0.05 + i * 0.1, w: 0.6, h: 0.05 } : null })));
        const texts = page.items.map((x) => x.str);
        const below = (i: number) => (i + 1 < texts.length ? i + 1 : null);
        const docs: DocumentText[] = [{ docId: "invoice", kind: "invoice", pages: [page] }];
        const answer = answerOf("invoice", "invoice", picks.map((p) => reading(texts, below, p)));
        const oldV = verifyBefore(answer, docs) as VerifiedReading[];
        const newV = verifyReadings(answer, docs);
        oldV.forEach((o, i) => same(o, newV[i], true));
      }),
      { numRuns: 300 },
    );
  });

  it("a date quoted over two stacked lines (Requirements 35.1 and 35.3) is judged as before: accepted", () => {
    const items = [
      { id: "invoice:p1:i1", str: "Date:", box: { x: 50, y: 40, w: 30, h: 10 } },
      { id: "invoice:p1:i2", str: "Terms: FOB", box: { x: 300, y: 40, w: 60, h: 10 } },
      { id: "invoice:p1:i3", str: "03 Nov 2026", box: { x: 50, y: 54, w: 60, h: 10 } },
    ];
    const page: PageText = { page: 1, width: 612, height: 792, items, text: "Date: Terms: FOB 03 Nov 2026", spans: [{ itemId: "invoice:p1:i1", start: 0, end: 5 }, { itemId: "invoice:p1:i2", start: 6, end: 16 }, { itemId: "invoice:p1:i3", start: 17, end: 28 }] };
    const docs: DocumentText[] = [{ docId: "invoice", kind: "invoice", pages: [page] }];
    const answer = answerOf("invoice", "invoice", [{ field: "invoice.date", value: "11/03/2026", quote: "Date: 03 Nov 2026" }]);
    const r = verifyReadings(answer, docs)[0];
    expect(r).toMatchObject({ status: "accepted", itemIds: ["invoice:p1:i1", "invoice:p1:i3"] });
    expect(r).toEqual(verifyBefore(answer, docs)[0]);
  });

  it("the sample bundle: every reading as before, on its text pages and with every page an image page", async () => {
    const b = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    expect(verifyReadings(b.answer, b.documents)).toEqual(verifyBefore(b.answer, b.documents));
    const img = b.documents.map((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, origin: "imageTranscript" as const })) }));
    expect(verifyReadings(b.answer, img)).toEqual(verifyBefore(b.answer, img));
  });

  it("the recorded reads of bundles A and C (image documents): the only changes are the ones Requirements 58 and 59 name", () => {
    for (const [file, drop] of [["test-bundle-c.json", "billOfLading"], ["test-bundle-a.json", "invoice"]] as const) {
      const body = JSON.parse(readFileSync(join(process.cwd(), "samples", "real-reads", file), "utf8"));
      const output: ReaderOutput = { ...body.output, fields: body.output.fields.filter((f: { doc: string }) => f.doc !== drop), transcripts: body.output.transcripts.filter((t: { doc: string }) => t.doc !== drop) };
      const docIds = [...new Set(output.transcripts.map((t) => t.doc))];
      const input = {
        bundle: "upload",
        documents: docIds.map((docId) => ({ docId, kind: docId, fileName: `${docId}.jpg`, fileSha256: "0".repeat(64), pages: [{ page: 1, width: 1000, height: 1000, text: null, image: { mediaType: "image/jpeg", base64: "QUJD" } }] })),
      } as unknown as ReaderInput;
      const answer = readerOutputToAnswer(input, output);
      const docs = composeDocumentTexts([], input, output);
      const oldV = verifyBefore(answer, docs) as VerifiedReading[];
      const newV = verifyReadings(answer, docs);
      const canon = (o: unknown) => JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y))) : v));
      const changed = newV.filter((n, i) => canon(n) !== canon(oldV[i])).map((n) => n.field);
      oldV.forEach((o, i) => same(o, newV[i], true));
      if (file === "test-bundle-c.json") expect(changed).toEqual([]);
      else expect(changed.length).toBe(29);
    }
  });
});
