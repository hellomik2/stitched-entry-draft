import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { verifyReadings, LINE_WITHOUT_BOX_MESSAGE, type ReadingAnswer, type VerifiedReading } from "./reading";
import { transcriptToPageText, type TranscriptLine } from "./transcript";
import type { Box, PageText } from "./pdfText";

// Feature: document-intake, Requirement 60 (task 75.1): an address that the AI reader wrote from its printed lines, joined
// with ", ", is inside its quote when the quote starts at its first line and the other parts are the lines right under it.

type Item = [string, Box];

/** A text page made of the given items, in this order, as the PDF text layer gives them. */
function textPage(items: Item[]): PageText {
  const its = items.map(([str, box], i) => ({ id: `invoice:p1:i${i + 1}`, str, box }));
  const spans: PageText["spans"] = [];
  let pos = 0;
  for (const it of its) {
    spans.push({ itemId: it.id, start: pos, end: pos + it.str.length });
    pos += it.str.length + 1;
  }
  return { page: 1, width: 612, height: 792, items: its, text: its.map((i) => i.str).join(" "), spans };
}

function verifyOn(page: PageText, field: string, value: string, quote: string, confidence?: "high" | "low"): VerifiedReading {
  const answer: ReadingAnswer = {
    schemaVersion: 1,
    bundle: "t",
    reader: "t",
    documents: [{ docId: "invoice", kind: "invoice" }],
    fields: [{ field, value, quote, doc: "invoice", page: 1, ...(confidence ? { confidence } : {}) }],
  };
  return verifyReadings(answer, [{ docId: "invoice", kind: "invoice", pages: [page] }])[0];
}

// The text layer of the bundle A invoice (test document A1), items 5 to 17 as pdf.js gives them.
const A1: Item[] = [
  ["Seller / Exporter:", { x: 42, y: 78.45, w: 72.03, h: 9 }],
  ["Invoice No.: MCA-INV-2611-07", { x: 317, y: 78.45, w: 128.03, h: 9 }],
  ["Mothlight Ceramics Atelier, Lda.", { x: 42, y: 92.25, w: 127.54, h: 9 }],
  ["Date: 03 Nov 2026", { x: 317, y: 92.25, w: 75.04, h: 9 }],
  ["Rua das Corujas 12, Vila Nevoa", { x: 42, y: 106.05, w: 128.05, h: 9 }],
  ["Terms: FOB Leixoes, Portugal", { x: 317, y: 106.05, w: 121.04, h: 9 }],
  ["0000-000 Portugal", { x: 42, y: 119.85, w: 74.04, h: 9 }],
  ["Currency: USD", { x: 317, y: 119.85, w: 60.51, h: 9 }],
  ["Country of export: Portugal", { x: 317, y: 133.65, w: 107.55, h: 9 }],
  ["B/L No.: OWFL2611LXS0419", { x: 317, y: 147.45, w: 118.06, h: 9 }],
  ["Sold to / Importer:", { x: 42, y: 181.25, w: 77.51, h: 9 }],
  ["Ship to:", { x: 365.2, y: 181.25, w: 33.5, h: 9 }],
  ["Same as importer", { x: 365.2, y: 195.05, w: 66.5, h: 9 }],
];
// The text layer of the bundle B invoice (test document B1), items 5 to 14.
const B1: Item[] = [
  ["Duskhaven Glaswerk GmbH", { x: 42, y: 78.45, w: 120.04, h: 9 }],
  ["Rechnungs-Nr. / Invoice No.: DHG-26-0981", { x: 317, y: 78.45, w: 181.54, h: 9 }],
  ["Nebelgasse 5", { x: 42, y: 92.25, w: 55.03, h: 9 }],
  ["Datum / Date: 09.11.2026", { x: 317, y: 92.25, w: 103.06, h: 9 }],
  ["00000 Kraehenfeld, Germany", { x: 42, y: 106.05, w: 118.06, h: 9 }],
  ["Lieferbedingung / Terms: FCA Hamburg", { x: 317, y: 106.05, w: 160.06, h: 9 }],
  ["Waehrung / Currency: EUR", { x: 317, y: 119.85, w: 109.53, h: 9 }],
  ["Country of export: Germany", { x: 317, y: 133.65, w: 111.04, h: 9 }],
  ["Buyer / Importer:", { x: 42, y: 167.45, w: 72.51, h: 9 }],
  ["Corvid & Quill Party Supply Inc.", { x: 42, y: 181.25, w: 125.54, h: 9 }],
];
// The first ten transcript lines of the bundle C invoice photo in the read of 2026-11-26 (boxes in thousandths).
const C1: TranscriptLine[] = [
  { text: "COMMERCIAL INVOICE", box: { x: 0.27, y: 0.235, w: 0.24, h: 0.03 } },
  { text: "Wispwood Lantern Works Co., Ltd.", box: { x: 0.27, y: 0.29, w: 0.21, h: 0.02 } },
  { text: "Lot 9, Fernlight Industrial Cluster", box: { x: 0.27, y: 0.31, w: 0.19, h: 0.02 } },
  { text: "Viet Nam", box: { x: 0.27, y: 0.328, w: 0.06, h: 0.018 } },
  { text: "Invoice No.: WLW-0457", box: { x: 0.645, y: 0.315, w: 0.14, h: 0.02 } },
  { text: "Date: Nov 06, 2026", box: { x: 0.645, y: 0.335, w: 0.11, h: 0.018 } },
  { text: "Terms: FOB Hai Phong", box: { x: 0.645, y: 0.355, w: 0.13, h: 0.018 } },
  { text: "Currency: USD", box: { x: 0.645, y: 0.375, w: 0.09, h: 0.018 } },
  { text: "Country of export: Viet Nam", box: { x: 0.645, y: 0.398, w: 0.16, h: 0.018 } },
  { text: "Bill to:", box: { x: 0.26, y: 0.41, w: 0.05, h: 0.018 } },
];
const SELLER = "invoice.seller.address";

describe("Feature: document-intake, Requirement 60.4: the recorded reads", () => {
  it("bundle A: the street line quoted, the post code line under it: accepted with the box of both items", () => {
    const r = verifyOn(textPage(A1), SELLER, "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal", "Rua das Corujas 12, Vila Nevoa");
    expect(r).toMatchObject({ status: "accepted", box: { x: 42, y: 106.05, w: 128.05, h: 22.8 }, itemIds: ["invoice:p1:i5", "invoice:p1:i7"] });
    expect("origin" in r).toBe(false);
    expect("lineText" in r).toBe(false);
  });

  it("bundle A: the same value quoted over both lines (Requirements 35.3 and 35.4) gets the same box as today", () => {
    const r = verifyOn(textPage(A1), SELLER, "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal", "Rua das Corujas 12, Vila Nevoa 0000-000 Portugal");
    expect(r).toMatchObject({ status: "accepted", box: { x: 42, y: 106.05, w: 128.05, h: 22.8 } });
  });

  it("bundle B: the quote runs over the date of the next column; the two address lines make the value", () => {
    const r = verifyOn(textPage(B1), SELLER, "Nebelgasse 5, 00000 Kraehenfeld, Germany", "Nebelgasse 5 Datum / Date: 09.11.2026 00000 Kraehenfeld, Germany");
    expect(r).toMatchObject({ status: "accepted", box: { x: 42, y: 92.25, w: 118.06, h: 22.8 }, itemIds: ["invoice:p1:i3", "invoice:p1:i5"] });
  });

  it("bundle C of 2026-11-26: two transcript lines of the photo, accepted as an image reading with their box and line text", () => {
    const page = transcriptToPageText("invoice", 1, 1000, 1000, C1);
    const r = verifyOn(page, SELLER, "Lot 9, Fernlight Industrial Cluster, Viet Nam", "Lot 9, Fernlight Industrial Cluster");
    expect(r).toMatchObject({ status: "accepted", box: { x: 270, y: 310, w: 190, h: 36 }, origin: "imageTranscript", lineText: "Lot 9, Fernlight Industrial Cluster Viet Nam" });
  });

  it("bundle C with the second line without a box: Requirement 58.1, uncertain with no box", () => {
    const lines = C1.map((l, i) => (i === 3 ? { ...l, box: null } : l));
    const r = verifyOn(transcriptToPageText("invoice", 1, 1000, 1000, lines), SELLER, "Lot 9, Fernlight Industrial Cluster, Viet Nam", "Lot 9, Fernlight Industrial Cluster");
    expect(r).toMatchObject({ status: "uncertain", box: null, itemIds: [], lineWithoutBox: true, message: LINE_WITHOUT_BOX_MESSAGE, lineText: "Lot 9, Fernlight Industrial Cluster Viet Nam" });
  });

  it("with confidence low the kept value is uncertain with its box", () => {
    expect(verifyOn(textPage(A1), SELLER, "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal", "Rua das Corujas 12, Vila Nevoa", "low")).toMatchObject({
      status: "uncertain",
      box: { x: 42, y: 106.05, w: 128.05, h: 22.8 },
    });
  });

  it("the other address fields get the rule too", () => {
    for (const field of ["invoice.buyer.address", "invoice.shipTo.address"]) {
      expect([field, verifyOn(textPage(B1), field, "Nebelgasse 5, 00000 Kraehenfeld, Germany", "Nebelgasse 5")]).toMatchObject([field, { status: "accepted" }]);
    }
  });
});

describe("Feature: document-intake, Requirement 60.2: not kept", () => {
  const a = textPage(A1);
  const rejectedA = (field: string, value: string, quote: string) => expect([value, verifyOn(a, field, value, quote)]).toMatchObject([value, { status: "rejected", reason: "value_not_in_quote" }]);

  it("a part that is not a line under the quoted line, even when it is printed elsewhere on the page", () => {
    rejectedA(SELLER, "Rua das Corujas 12, Vila Nevoa, Portugal", "Rua das Corujas 12, Vila Nevoa");
    rejectedA(SELLER, "Rua das Corujas 12, Vila Nevoa, Terms: FOB Leixoes, Portugal", "Rua das Corujas 12, Vila Nevoa");
    rejectedA(SELLER, "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal, Sold to / Importer:", "Rua das Corujas 12, Vila Nevoa");
    rejectedA(SELLER, "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal, Portugal", "Rua das Corujas 12, Vila Nevoa");
    rejectedA(SELLER, "Rua das Corujas 12, 0000-000 Portugal", "Rua das Corujas 12, Vila Nevoa");
    rejectedA(SELLER, "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal.", "Rua das Corujas 12, Vila Nevoa");
  });

  it("a quote that does not start at an item, or ends past the address lines", () => {
    rejectedA(SELLER, "das Corujas 12, Vila Nevoa, 0000-000 Portugal", "das Corujas 12, Vila Nevoa");
    rejectedA(SELLER, "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal", "Rua das Corujas 12, Vila Nevoa Terms: FOB Leixoes, Portugal");
  });

  it("a field that is not an address field", () => {
    rejectedA("invoice.terms", "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal", "Rua das Corujas 12, Vila Nevoa");
    rejectedA("invoice.seller.name", "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal", "Rua das Corujas 12, Vila Nevoa");
  });

  it("\"Same as importer\" written out as the importer's name or address", () => {
    rejectedA("invoice.shipTo.name", "Bramblewick Home Goods LLC", "Same as importer");
    rejectedA("invoice.shipTo.address", "88 Thistle Lane, Fernhollow, GA 00000, USA", "Same as importer");
  });

  it("on an image page: a line that is not the next one, and a quote that is not in the transcript", () => {
    const page = transcriptToPageText("invoice", 1, 1000, 1000, C1);
    expect(verifyOn(page, SELLER, "Lot 9, Fernlight Industrial Cluster, Invoice No.: WLW-0457", "Lot 9, Fernlight Industrial Cluster")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
    expect(verifyOn(page, SELLER, "Wispwood Lantern Works Co., Ltd., Viet Nam", "Wispwood Lantern Works Co., Ltd.")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
    const short = transcriptToPageText("invoice", 1, 1000, 1000, C1.slice(0, 2));
    expect(verifyOn(short, SELLER, "Lot 9, Fernlight Industrial Cluster Viet Nam", "Lot 9, Fernlight Industrial Cluster")).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
  });
});

// Generated pages: column A (x 50) items stacked 14 points apart, column B (x 300) beside them; every text is different.
const WORDS = fc.array(fc.stringMatching(/^[A-Z][a-z]{1,6}$/), { minLength: 1, maxLength: 3 });

describe("Feature: document-intake, Property 80: An Address Over Lines Is Kept Only When Every Part Is One of Its Lines (Validates: Requirements 60.1, 60.2)", () => {
  it("text pages: S and the next k - 1 lines of its column are kept with their union box; one part replaced is rejected; another field is rejected", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(WORDS, WORDS), { minLength: 2, maxLength: 7 }), fc.nat(), fc.integer({ min: 2, max: 4 }), fc.nat(), fc.nat(), (rows, sPick, kWant, partPick, howPick) => {
        const colA = rows.map(([w], i) => `A${i}q ${w.join(" ")}`);
        const colB = rows.map(([, w], i) => `B${i}q ${w.join(" ")}`);
        const items: Item[] = [];
        rows.forEach((_, i) => {
          items.push([colA[i], { x: 50, y: 40 + i * 14, w: 120, h: 10 }]);
          items.push([colB[i], { x: 300, y: 40 + i * 14, w: 120, h: 10 }]);
        });
        const page = textPage(items);
        const s = sPick % (rows.length - 1);
        const k = Math.min(kWant, rows.length - s);
        const parts = colA.slice(s, s + k);
        const r = verifyOn(page, SELLER, parts.join(", "), colA[s]);
        expect(r).toMatchObject({ status: "accepted", box: { x: 50, y: 40 + s * 14, w: 120, h: (k - 1) * 14 + 10 }, itemIds: parts.map((_, j) => `invoice:p1:i${2 * (s + j) + 1}`) });
        const j = 1 + (partPick % (k - 1));
        const others = [colB[s + j], ...(s > 0 ? [colA[s - 1]] : []), ...(s + k < rows.length ? [colA[s + k]] : []), parts[j] + "x"];
        const bad = parts.map((p, i) => (i === j ? others[howPick % others.length] : p)).join(", ");
        expect([bad, verifyOn(page, SELLER, bad, colA[s])]).toMatchObject([bad, { status: "rejected", reason: "value_not_in_quote" }]);
        expect(verifyOn(page, "invoice.terms", parts.join(", "), colA[s])).toMatchObject({ status: "rejected", reason: "value_not_in_quote" });
      }),
      { numRuns: 150 },
    );
  });

  it("image pages: S and the next k - 1 transcript lines are kept as an image reading; one part replaced is rejected", () => {
    fc.assert(
      fc.property(fc.array(WORDS, { minLength: 2, maxLength: 7 }), fc.nat(), fc.integer({ min: 2, max: 4 }), fc.nat(), fc.nat(), (rows, sPick, kWant, partPick, howPick) => {
        const texts = rows.map((w, i) => `L${i}q ${w.join(" ")}`);
        const page = transcriptToPageText("invoice", 1, 1000, 1000, texts.map((t, i) => ({ text: t, box: { x: 0.1, y: 0.05 + i * 0.1, w: 0.5, h: 0.05 } })));
        const s = sPick % (rows.length - 1);
        const k = Math.min(kWant, rows.length - s);
        const parts = texts.slice(s, s + k);
        const r = verifyOn(page, SELLER, parts.join(", "), texts[s]);
        expect(r).toMatchObject({ status: "accepted", origin: "imageTranscript", lineText: parts.join(" "), box: { x: 100, y: 50 + s * 100, w: 500, h: (k - 1) * 100 + 50 } });
        const j = 1 + (partPick % (k - 1));
        const others = [...(s > 0 ? [texts[s - 1]] : []), ...(s + k < rows.length ? [texts[s + k]] : []), parts[j] + "x"];
        const bad = parts.map((p, i) => (i === j ? others[howPick % others.length] : p)).join(", ");
        expect([bad, verifyOn(page, SELLER, bad, texts[s])]).toMatchObject([bad, { status: "rejected", reason: "value_not_in_quote" }]);
      }),
      { numRuns: 150 },
    );
  });
});
