import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { verifyReadings, type ReadingAnswer, type VerifiedReading } from "./reading";
import { verifyReadings as verifyBefore } from "./reading.before61";
import { readerOutputToAnswer, composeDocumentTexts, type ReaderInput, type ReaderOutput } from "./readerContract";
import { transcriptToPageText } from "./transcript";
import type { DocumentText, PageText } from "./pdfText";
import { loadBundleFromDisk } from "../node/index";

// Feature: document-intake, Requirement 61 and Property 82 (task 78.1): for a number field, a value is inside its quote only at a
// place that is not inside a longer printed number. src/core/reading.before61.ts is a byte copy of src/core/reading.ts at 698d601.

const NUMBER = /^(invoice\.lines\.\d+\.(quantity|unitPrice|amount)|invoice\.(subtotal|total)|packingList\.lines\.\d+\.(cartons|quantity|netKg|grossKg)|packingList\.total(Cartons|Quantity|NetKg|GrossKg)|billOfLading\.grossKg)$/;

/** Requirement 61.1, written again here: the place i of v in q is inside a longer printed number. */
function insideLonger(q: string, i: number, len: number): boolean {
  const d = (c: string | undefined) => c !== undefined && /\d/.test(c);
  const b = q[i - 1];
  const a = q[i + len];
  return d(b) || ((b === "," || b === ".") && d(q[i - 2])) || d(a) || ((a === "," || a === ".") && d(q[i + len + 1]));
}
function places(q: string, v: string): number[] {
  const out: number[] = [];
  for (let k = q.indexOf(v); k !== -1; k = q.indexOf(v, k + 1)) out.push(k);
  return out;
}
const onlyInsideLonger = (q: string, v: string) => places(q, v).length > 0 && places(q, v).every((i) => insideLonger(q, i, v.length));
const ns = (s: string) => s.replace(/\s+/g, " ").trim();

/** A text page with one item per row. */
function textPage(texts: string[]): PageText {
  const items = texts.map((str, r) => ({ id: `invoice:p1:i${r + 1}`, str, box: { x: 50, y: 40 + r * 14, w: 200, h: 10 } }));
  const spans: PageText["spans"] = [];
  let pos = 0;
  for (const it of items) {
    spans.push({ itemId: it.id, start: pos, end: pos + it.str.length });
    pos += it.str.length + 1;
  }
  return { page: 1, width: 612, height: 792, items, text: texts.join(" "), spans };
}
function answerOf(rs: { field: string; value: string; quote: string; confidence?: "high" | "low" }[]): ReadingAnswer {
  return {
    schemaVersion: 1,
    bundle: "t",
    reader: "t",
    documents: [{ docId: "invoice", kind: "invoice" }],
    fields: rs.map((r) => ({ field: r.field, value: r.value, quote: r.quote, doc: "invoice", page: 1, ...(r.confidence ? { confidence: r.confidence } : {}) })),
  };
}
function one(page: PageText, field: string, value: string, quote: string) {
  const docs: DocumentText[] = [{ docId: "invoice", kind: "invoice", pages: [page] }];
  const answer = answerOf([{ field, value, quote }]);
  return { now: verifyReadings(answer, docs)[0], before: verifyBefore(answer, docs)[0] as VerifiedReading };
}

describe("Feature: document-intake, Requirement 61: A Number Inside a Longer Printed Number Is Not Inside Its Quote", () => {
  it("61.5: a number cut short is rejected with value_not_in_quote on a text page (the check before accepted it)", () => {
    const cases: [string, string, string][] = [
      ["invoice.lines.1.quantity", "980", "TOTAL 77 4,980"],
      ["invoice.lines.1.quantity", "200", "1,200"],
      ["invoice.lines.1.amount", "160,00", "2.160,00"],
      ["packingList.lines.1.grossKg", "468", "468.0 KGS"],
      ["packingList.totalQuantity", "80", "TOTAL 77 4,980"],
    ];
    for (const [field, value, quote] of cases) {
      const r = one(textPage([quote]), field, value, quote);
      expect(r.before.status, `${value} in "${quote}" before`).toBe("accepted");
      expect(r.now.status, `${value} in "${quote}"`).toBe("rejected");
      expect(r.now).toMatchObject({ reason: "value_not_in_quote", message: `The value "${value}" is not found within the quote "${quote}" on invoice page 1.` });
    }
  });

  it("61.2: the first place that stands alone is the value's place, with its box", () => {
    const r = one(textPage(["4,980 PCS", "980 PCS"]), "invoice.lines.1.quantity", "980", "4,980 PCS 980 PCS");
    expect(r.now).toMatchObject({ status: "accepted", itemIds: ["invoice:p1:i2"], box: { x: 50, y: 54, w: 200, h: 10 } });
    expect(r.before).toMatchObject({ status: "accepted", itemIds: ["invoice:p1:i1"] });
    const s = one(textPage(["980 PCS", "4,980"]), "invoice.lines.1.quantity", "980", "980 PCS 4,980");
    expect(s.now).toMatchObject({ status: "accepted", itemIds: ["invoice:p1:i1"] });
    expect(s.now).toEqual(s.before);
  });

  it("61.3 and 61.5: a period or comma with no digit after it, Requirement 59, and fields that are not number fields stay as before", () => {
    const keep: [string, string, string][] = [
      ["invoice.lines.1.quantity", "77", "Total 77."],
      ["invoice.lines.1.quantity", "77", "77, 80 PCS"],
      ["invoice.lines.1.quantity", "1200", "1,200"],
      ["billOfLading.grossKg", "1284.0", "1,284.0 KGS"],
      ["invoice.lines.1.itemNo", "MCA-101", "MCA-1012"],
      ["invoice.number", "980", "INV 4,980"],
      ["billOfLading.packages", "77", "177 CTNS"],
    ];
    for (const [field, value, quote] of keep) {
      const r = one(textPage([quote]), field, value, quote);
      expect(r.now, `${field} ${value} in "${quote}"`).toEqual(r.before);
    }
    expect(one(textPage(["Total 77."]), "invoice.lines.1.quantity", "77", "Total 77.").now.status).toBe("accepted");
  });

  it("61.2 on an image page: a quote found in the transcript, and a quote that is not in the transcript (50.1)", () => {
    const page = transcriptToPageText("invoice", 1, 1000, 1000, [{ text: "TOTAL 77 4,980", box: { x: 0.1, y: 0.1, w: 0.6, h: 0.05 } }]);
    const docs: DocumentText[] = [{ docId: "invoice", kind: "invoice", pages: [page] }];
    const found = answerOf([{ field: "packingList.totalQuantity", value: "980", quote: "TOTAL 77 4,980" }]);
    expect(verifyBefore(found, docs)[0].status).toBe("accepted");
    expect(verifyReadings(found, docs)[0]).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
    const outside = answerOf([{ field: "packingList.totalQuantity", value: "980", quote: "Total Qty 4,980" }]);
    expect(verifyBefore(outside, docs)[0]).toMatchObject({ status: "uncertain", notInTranscript: true });
    expect(verifyReadings(outside, docs)[0]).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
    const alone = answerOf([{ field: "packingList.totalQuantity", value: "980", quote: "Total Qty 980" }]);
    expect(verifyReadings(alone, docs)[0]).toEqual(verifyBefore(alone, docs)[0]);
  });

  it("61.5: the sample bundle and the recorded reads of bundles A and C give the same readings as before", async () => {
    const b = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    expect(verifyReadings(b.answer, b.documents)).toEqual(verifyBefore(b.answer, b.documents));
    const img = b.documents.map((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, origin: "imageTranscript" as const })) }));
    expect(verifyReadings(b.answer, img)).toEqual(verifyBefore(b.answer, img));
    for (const file of ["test-bundle-a.json", "test-bundle-c.json"]) {
      const body = JSON.parse(readFileSync(join(process.cwd(), "samples", "real-reads", file), "utf8"));
      const output: ReaderOutput = body.output;
      const docIds = [...new Set(output.transcripts.map((t) => t.doc))];
      const input = {
        bundle: "upload",
        documents: docIds.map((docId) => ({ docId, kind: docId, fileName: `${docId}.jpg`, fileSha256: "0".repeat(64), pages: [{ page: 1, width: 1000, height: 1000, text: null, image: { mediaType: "image/jpeg", base64: "QUJD" } }] })),
      } as unknown as ReaderInput;
      const answer = readerOutputToAnswer(input, output);
      const docs = composeDocumentTexts([], input, output);
      expect(verifyReadings(answer, docs), file).toEqual(verifyBefore(answer, docs));
    }
  });
});

const TOKENS = ["TOTAL 77 4,980", "4,980", "980 PCS", "1,200", "1200", "2.160,00", "160,00", "468.0 KGS", "Total 77.", "77, 80", "MCA-1012", "Gross 1,284.0 KGS", "12", "USD 9,840.00"];
const textArb = fc.array(fc.constantFrom(...TOKENS), { minLength: 1, maxLength: 3 }).map((ts) => ts.join(" "));
const FIELDS = ["invoice.lines.1.quantity", "invoice.lines.1.amount", "invoice.total", "packingList.totalQuantity", "packingList.lines.2.grossKg", "billOfLading.grossKg", "invoice.lines.1.itemNo", "invoice.number", "billOfLading.packages"];
type Pick = { field: string; at: number; start: number; len: number; whole: boolean };
const pickArb: fc.Arbitrary<Pick> = fc.record({ field: fc.constantFrom(...FIELDS), at: fc.nat(), start: fc.nat(), len: fc.integer({ min: 1, max: 8 }), whole: fc.boolean() });

/** The only change Property 82 allows: a number field reading kept before, now rejected because its value is only inside longer numbers. */
function sameOrAllowed(before: VerifiedReading, now: VerifiedReading, quote: string, value: string) {
  if (NUMBER.test(now.field) && before.status !== "rejected" && now.status === "rejected") {
    expect(now.reason).toBe("value_not_in_quote");
    const q = ns(quote);
    const v = ns(value);
    expect(onlyInsideLonger(q, v) || !q.includes(v), `${now.field} "${v}" in "${q}"`).toBe(true);
    return;
  }
  expect(now).toEqual(before);
}

describe("Feature: document-intake, Property 82: A Number Is Inside Its Quote Only Where It Is Not Part of a Longer Number (Validates: Requirements 61.1, 61.2, 61.3, 61.4)", () => {
  it("text pages (two columns) and image transcripts: every reading is judged as before, except a number cut short", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(textArb, textArb), { minLength: 1, maxLength: 5 }), fc.array(pickArb, { minLength: 1, maxLength: 4 }), fc.boolean(), (rows, picks, image) => {
        let page: PageText;
        if (image) {
          page = transcriptToPageText("invoice", 1, 1000, 1000, rows.map(([a, b], i) => ({ text: `${a} ${b}`, box: { x: 0.1, y: 0.05 + i * 0.1, w: 0.6, h: 0.05 } })));
        } else {
          const items = rows.flatMap(([a, b], r) => [
            { id: `invoice:p1:i${2 * r + 1}`, str: a, box: { x: 50, y: 40 + r * 14, w: 200, h: 10 } },
            { id: `invoice:p1:i${2 * r + 2}`, str: b, box: { x: 300, y: 40 + r * 14, w: 200, h: 10 } },
          ]);
          const spans: PageText["spans"] = [];
          let pos = 0;
          for (const it of items) {
            spans.push({ itemId: it.id, start: pos, end: pos + it.str.length });
            pos += it.str.length + 1;
          }
          page = { page: 1, width: 612, height: 792, items, text: items.map((x) => x.str).join(" "), spans };
        }
        const texts = page.items.map((x) => x.str);
        const rs = picks.map((p) => {
          const quote = texts[p.at % texts.length];
          const s = p.start % Math.max(1, quote.length);
          return { field: p.field, quote, value: p.whole ? quote : quote.slice(s, s + p.len) };
        });
        const docs: DocumentText[] = [{ docId: "invoice", kind: "invoice", pages: [page] }];
        const answer = answerOf(rs);
        const before = verifyBefore(answer, docs) as VerifiedReading[];
        const now = verifyReadings(answer, docs);
        before.forEach((b, i) => sameOrAllowed(b, now[i], rs[i].quote, rs[i].value));
      }),
      { numRuns: 300 },
    );
  });

  it("a number inside a longer printed number is rejected; the same number standing alone too is accepted with its own box", () => {
    const extend = fc.oneof(
      fc.tuple(fc.integer({ min: 0, max: 9 }), fc.constantFrom("", ",", ".")).map(([dg, sep]) => ({ before: `${dg}${sep}`, after: "" })),
      fc.oneof(fc.integer({ min: 0, max: 9 }).map(String), fc.integer({ min: 0, max: 999 }).map((n) => `,${String(n).padStart(3, "0")}`), fc.integer({ min: 0, max: 9 }).map((n) => `.${n}`)).map((a) => ({ before: "", after: a })),
    );
    const numberArb = fc.tuple(fc.integer({ min: 1, max: 9999 }), fc.option(fc.integer({ min: 0, max: 99 }), { nil: null })).map(([n, c]) => (c === null ? String(n) : `${n}.${String(c).padStart(2, "0")}`));
    const fieldArb = fc.constantFrom("invoice.lines.3.quantity", "invoice.lines.2.unitPrice", "invoice.subtotal", "packingList.lines.1.netKg", "packingList.totalCartons", "billOfLading.grossKg");
    fc.assert(
      fc.property(fieldArb, numberArb, extend, (field, d, e) => {
        const longer = `${e.before}${d}${e.after}`;
        const inside = `Qty ${longer} PCS`;
        const r = one(textPage([inside]), field, d, inside);
        expect(r.now).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
        const both = one(textPage([`Qty ${longer} or`, `${d} PCS`]), field, d, `Qty ${longer} or ${d} PCS`);
        expect(both.now).toMatchObject({ status: "accepted", itemIds: ["invoice:p1:i2"] });
      }),
      { numRuns: 300 },
    );
  });
});
