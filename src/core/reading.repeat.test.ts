import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { verifyReadings } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import type { DocumentText, PageText, Box } from "./pdfText";
import { buildPageText, normalizeSpace } from "./pdfText";
import { transcriptToPageText } from "./transcript";

// Helper: raw(str, x, base) = { str, transform: [8, 0, 0, 8, x, base], width: 8 * 0.5 * str.length, height: 8 }
function raw(str: string, x: number, base: number): { str: string; transform: number[]; width: number; height: number } {
  return {
    str,
    transform: [8, 0, 0, 8, x, base],
    width: 8 * 0.5 * str.length,
    height: 8,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// Helper: textPage(items) = buildPageText(1, 612, 792, items, "invoice")
function textPage(items: unknown[]): PageText {
  return buildPageText(1, 612, 792, items, "invoice");
}

// Helper: imagePage(docId, lines) = transcriptToPageText(docId, 1, 1000, 1000, lines)
function imagePage(
  docId: string,
  lines: Array<{ text: string; box: { x: number; y: number; w: number; h: number } }>,
): PageText {
  return transcriptToPageText(docId, 1, 1000, 1000, lines);
}

// Helper: answer(fields) = { schemaVersion: 1, bundle: "t", reader: "t", documents: [], fields }
function answer(fields: any[]): ReadingAnswer {
  return { schemaVersion: 1, bundle: "t", reader: "t", documents: [], fields };
}

// Helper: check(fields, docs) = verifyReadings(answer(fields), docs)
function check(fields: any[], docs: DocumentText[]): VerifiedReading[] {
  return verifyReadings(answer(fields), docs);
}

// Helper: build invoice page with header and five rows
function invoicePage(move0000?: boolean, extra?: unknown[]): PageText {
  const items = [
    raw("Mothlight Ceramics Atelier, Lda.", 42, 714),
    raw("Date: 03 Nov 2026", 317, 714),
    raw("Rua das Corujas 12, Vila Nevoa", 42, 700),
    raw("Terms: FOB Leixoes, Portugal", 317, 700),
    raw("0000-000 Portugal", move0000 ? 60 : 42, 686),
    raw("Currency: USD", 317, 686),
    raw("MCA-101", 40, 600),
    raw("Stoneware owl figurine, hand-glazed", 90, 600),
    raw("6913.90.5000", 270, 600),
    raw("PT", 350, 600),
    raw("1,200", 400, 600),
    raw("PCS", 430, 600),
    raw("2.85", 490, 600),
    raw("3,420.00", 540, 600),
    raw("MCA-102", 40, 580),
    raw("Glass votive candle holder, amber", 90, 580),
    raw("7013.99.3500", 270, 580),
    raw("PT", 350, 580),
    raw("2,400", 400, 580),
    raw("PCS", 430, 580),
    raw("0.95", 490, 580),
    raw("2,280.00", 540, 580),
    raw("MCA-103", 40, 560),
    raw("Tin lantern with glass panes", 90, 560),
    raw("9405.05.4000", 270, 560),
    raw("PT", 350, 560),
    raw("300", 400, 560),
    raw("PCS", 430, 560),
    raw("6.40", 490, 560),
    raw("1,920.00", 540, 560),
    raw("MCA-104", 40, 540),
    raw("Artificial bittersweet stems, polyester", 90, 540),
    raw("6702.90.6500", 270, 540),
    raw("CN", 350, 540),
    raw("600", 400, 540),
    raw("PCS", 430, 540),
    raw("1.10", 490, 540),
    raw("660.00", 540, 540),
    raw("MCA-105", 40, 520),
    raw("Ceramic pumpkin, small", 90, 520),
    raw("6913.90.5000", 270, 520),
    raw("PT", 350, 520),
    raw("480", 400, 520),
    raw("PCS", 430, 520),
    raw("3.25", 490, 520),
    raw("1,560.00", 540, 520),
  ];
  
  if (extra) {
    items.push(...(extra as any[]));
  }
  
  return textPage(items);
}

// Helper: find item by text and base (row y coordinate)
// y = 792 - base - 6.4 for an 8-point item (item size is 8, baseline is at base, top is at base + 0.8*8)
function itemIdOf(page: PageText, str: string, base: number): string | undefined {
  const expectedY = round2(792 - base - 6.4);
  const item = page.items.find((item) => item.str === str && item.box.y === expectedY);
  return item?.id;
}

function itemOf(page: PageText, str: string, base: number): any {
  const expectedY = round2(792 - base - 6.4);
  return page.items.find((item) => item.str === str && item.box.y === expectedY);
}

describe("Requirement 34: Quote Uniqueness and Line Items", () => {
  it("1. Item number readings with cell quotes for lines 1-5 — each accepts with itemIds", () => {
    const page = invoicePage();
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    // Build the row quotes
    const rowQuotes = [
      "MCA-101 Stoneware owl figurine, hand-glazed 6913.90.5000 PT 1,200 PCS 2.85 3,420.00",
      "MCA-102 Glass votive candle holder, amber 7013.99.3500 PT 2,400 PCS 0.95 2,280.00",
      "MCA-103 Tin lantern with glass panes 9405.05.4000 PT 300 PCS 6.40 1,920.00",
      "MCA-104 Artificial bittersweet stems, polyester 6702.90.6500 CN 600 PCS 1.10 660.00",
      "MCA-105 Ceramic pumpkin, small 6913.90.5000 PT 480 PCS 3.25 1,560.00",
    ];
    const bases = [600, 580, 560, 540, 520];

    const fields = [
      { field: "invoice.lines.1.itemNo", value: "MCA-101", quote: rowQuotes[0], doc: "invoice", page: 1 },
      { field: "invoice.lines.1.origin", value: "PT", quote: "PT", doc: "invoice", page: 1 },
      { field: "invoice.lines.1.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.1.hts", value: "6913.90.5000", quote: "6913.90.5000", doc: "invoice", page: 1 },
      { field: "invoice.lines.2.itemNo", value: "MCA-102", quote: rowQuotes[1], doc: "invoice", page: 1 },
      { field: "invoice.lines.2.origin", value: "PT", quote: "PT", doc: "invoice", page: 1 },
      { field: "invoice.lines.2.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.3.itemNo", value: "MCA-103", quote: rowQuotes[2], doc: "invoice", page: 1 },
      { field: "invoice.lines.3.origin", value: "PT", quote: "PT", doc: "invoice", page: 1 },
      { field: "invoice.lines.3.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.4.itemNo", value: "MCA-104", quote: rowQuotes[3], doc: "invoice", page: 1 },
      { field: "invoice.lines.4.origin", value: "CN", quote: "CN", doc: "invoice", page: 1 },
      { field: "invoice.lines.4.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.5.itemNo", value: "MCA-105", quote: rowQuotes[4], doc: "invoice", page: 1 },
      { field: "invoice.lines.5.origin", value: "PT", quote: "PT", doc: "invoice", page: 1 },
      { field: "invoice.lines.5.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.1.hts", value: "6913.90.5000", quote: "6913.90.5000", doc: "invoice", page: 1 },
      { field: "invoice.lines.5.hts", value: "6913.90.5000", quote: "6913.90.5000", doc: "invoice", page: 1 },
    ];

    const verified = check(fields, [doc]);

    // Check itemNo readings
    expect(verified[0].status).toBe("accepted");
    expect(verified[4].status).toBe("accepted");
    expect(verified[7].status).toBe("accepted");
    expect(verified[10].status).toBe("accepted");
    expect(verified[13].status).toBe("accepted");

    // Check origin readings
    for (let i = 0; i < 5; i++) {
      const lineIdx = [1, 5, 8, 11, 14][i];
      expect(verified[lineIdx].status).toBe("accepted");
      if (verified[lineIdx].status === "accepted") {
        expect(verified[lineIdx].itemIds).toEqual([itemIdOf(page, ["PT", "PT", "PT", "CN", "PT"][i], bases[i])]);
        expect(verified[lineIdx].box).toEqual(itemOf(page, ["PT", "PT", "PT", "CN", "PT"][i], bases[i]).box);
      }
    }

    // Check unit readings
    for (let i = 0; i < 5; i++) {
      const lineIdx = [2, 6, 9, 12, 15][i];
      expect(verified[lineIdx].status).toBe("accepted");
      if (verified[lineIdx].status === "accepted") {
        expect(verified[lineIdx].itemIds).toEqual([itemIdOf(page, "PCS", bases[i])]);
        expect(verified[lineIdx].box).toEqual(itemOf(page, "PCS", bases[i]).box);
      }
    }

    // Check hts readings at indices 3, 16, 17
    expect(verified[3].status).toBe("accepted");
    if (verified[3].status === "accepted") {
      expect(verified[3].itemIds).toEqual([itemIdOf(page, "6913.90.5000", 600)]);
      expect(verified[3].box).toEqual(itemOf(page, "6913.90.5000", 600).box);
    }

    expect(verified[16].status).toBe("accepted");
    if (verified[16].status === "accepted") {
      expect(verified[16].itemIds).toEqual([itemIdOf(page, "6913.90.5000", 600)]);
    }

    expect(verified[17].status).toBe("accepted");
    if (verified[17].status === "accepted") {
      expect(verified[17].itemIds).toEqual([itemIdOf(page, "6913.90.5000", 520)]);
    }
  });

  it("2. Item number readings quoting only 'MCA-10<k>' — same results", () => {
    const page = invoicePage();
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };
    const bases = [600, 580, 560, 540, 520];

    const fields = [
      { field: "invoice.lines.1.itemNo", value: "MCA-101", quote: "MCA-101", doc: "invoice", page: 1 },
      { field: "invoice.lines.1.origin", value: "PT", quote: "PT", doc: "invoice", page: 1 },
      { field: "invoice.lines.1.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.1.hts", value: "6913.90.5000", quote: "6913.90.5000", doc: "invoice", page: 1 },
      { field: "invoice.lines.2.itemNo", value: "MCA-102", quote: "MCA-102", doc: "invoice", page: 1 },
      { field: "invoice.lines.2.origin", value: "PT", quote: "PT", doc: "invoice", page: 1 },
      { field: "invoice.lines.2.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.2.hts", value: "7013.99.3500", quote: "7013.99.3500", doc: "invoice", page: 1 },
      { field: "invoice.lines.3.itemNo", value: "MCA-103", quote: "MCA-103", doc: "invoice", page: 1 },
      { field: "invoice.lines.3.origin", value: "PT", quote: "PT", doc: "invoice", page: 1 },
      { field: "invoice.lines.3.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.3.hts", value: "9405.05.4000", quote: "9405.05.4000", doc: "invoice", page: 1 },
      { field: "invoice.lines.4.itemNo", value: "MCA-104", quote: "MCA-104", doc: "invoice", page: 1 },
      { field: "invoice.lines.4.origin", value: "CN", quote: "CN", doc: "invoice", page: 1 },
      { field: "invoice.lines.4.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.4.hts", value: "6702.90.6500", quote: "6702.90.6500", doc: "invoice", page: 1 },
      { field: "invoice.lines.5.itemNo", value: "MCA-105", quote: "MCA-105", doc: "invoice", page: 1 },
      { field: "invoice.lines.5.origin", value: "PT", quote: "PT", doc: "invoice", page: 1 },
      { field: "invoice.lines.5.unit", value: "PCS", quote: "PCS", doc: "invoice", page: 1 },
      { field: "invoice.lines.5.hts", value: "6913.90.5000", quote: "6913.90.5000", doc: "invoice", page: 1 },
    ];

    const verified = check(fields, [doc]);

    // All readings should be accepted
    for (let i = 0; i < verified.length; i++) {
      expect(verified[i].status).toBe("accepted");
    }

    // Check that origin, unit, and hts readings have correct itemIds
    const origins = ["PT", "PT", "PT", "CN", "PT"];
    const units = ["PCS", "PCS", "PCS", "PCS", "PCS"];
    const htss = ["6913.90.5000", "7013.99.3500", "9405.05.4000", "6702.90.6500", "6913.90.5000"];

    for (let k = 0; k < 5; k++) {
      // origin at index k * 4 + 1
      const originIdx = k * 4 + 1;
      expect((verified[originIdx] as any).itemIds).toEqual([itemIdOf(page, origins[k], bases[k])]);

      // unit at index k * 4 + 2
      const unitIdx = k * 4 + 2;
      expect((verified[unitIdx] as any).itemIds).toEqual([itemIdOf(page, "PCS", bases[k])]);

      // hts at index k * 4 + 3
      const htsIdx = k * 4 + 3;
      expect((verified[htsIdx] as any).itemIds).toEqual([itemIdOf(page, htss[k], bases[k])]);
    }
  });

  it("3. Without item number reading but with description — matching line accepted, non-matching line rejected with 'quote_not_unique'", () => {
    const page = invoicePage();
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    const fields = [
      {
        field: "invoice.lines.3.description",
        value: "Tin lantern with glass panes",
        quote: "Tin lantern with glass panes",
        doc: "invoice",
        page: 1,
      },
      {
        field: "invoice.lines.3.origin",
        value: "PT",
        quote: "PT",
        doc: "invoice",
        page: 1,
      },
      {
        field: "invoice.lines.2.origin",
        value: "PT",
        quote: "PT",
        doc: "invoice",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    // Line 3 origin with anchor should be accepted
    expect(verified[1].status).toBe("accepted");

    // Line 2 origin without anchor should be rejected with quote_not_unique
    expect(verified[2].status).toBe("rejected");
    if (verified[2].status === "rejected") {
      expect(verified[2].reason).toBe("quote_not_unique");
    }
  });

  it("4. A non-line field (invoice.currency) is rejected with 'quote_not_unique' when quote appears multiple times", () => {
    const items = [
      raw("Currency: PT", 42, 714),
      raw("PT", 317, 714),
    ];

    const page = textPage(items);
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    const fields = [
      {
        field: "invoice.currency",
        value: "PT",
        quote: "PT",
        doc: "invoice",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    expect(verified[0].status).toBe("rejected");
    if (verified[0].status === "rejected") {
      expect(verified[0].reason).toBe("quote_not_unique");
    }
  });

  it("5. Page where row 1 has two 'PCS' cells — line 1 unit is rejected with 'quote_not_unique', line 2 is accepted", () => {
    const extra = [raw("PCS", 480, 600)];
    const page = invoicePage(false, extra);
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    const fields = [
      {
        field: "invoice.lines.1.itemNo",
        value: "MCA-101",
        quote: "MCA-101",
        doc: "invoice",
        page: 1,
      },
      {
        field: "invoice.lines.1.unit",
        value: "PCS",
        quote: "PCS",
        doc: "invoice",
        page: 1,
      },
      {
        field: "invoice.lines.2.itemNo",
        value: "MCA-102",
        quote: "MCA-102",
        doc: "invoice",
        page: 1,
      },
      {
        field: "invoice.lines.2.unit",
        value: "PCS",
        quote: "PCS",
        doc: "invoice",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    expect(verified[1].status).toBe("rejected");
    if (verified[1].status === "rejected") {
      expect(verified[1].reason).toBe("quote_not_unique");
    }

    expect(verified[3].status).toBe("accepted");
  });

  it("6. Packing list page with line item number readings — cartons and totalCartons accepted with imageTranscript origin", () => {
    const lines = [
      { text: "Item Description Ctn Nos. Ctns Qty (PCS) Net kg Gross kg", box: { x: 0.1, y: 0.2, w: 0.8, h: 0.05 } },
      { text: "MCA-101 Stoneware owl figurine 1-20 20 1,200 420.0 468.0", box: { x: 0.1, y: 0.26, w: 0.8, h: 0.05 } },
      { text: "MCA-102 Glass votive candle holder 21-44 24 2,400 336.0 384.0", box: { x: 0.1, y: 0.32, w: 0.8, h: 0.05 } },
      { text: "MCA-103 Tin lantern 45-59 15 300 255.0 285.0", box: { x: 0.1, y: 0.38, w: 0.8, h: 0.05 } },
      { text: "MCA-104 Artificial bittersweet stems 60-65 6 600 30.0 39.0", box: { x: 0.1, y: 0.44, w: 0.8, h: 0.05 } },
      { text: "MCA-105 Ceramic pumpkin, small 66-77 12 480 62.0 72.0", box: { x: 0.1, y: 0.5, w: 0.8, h: 0.05 } },
      { text: "TOTAL 77 4,980 1,103.0 1,248.0", box: { x: 0.1, y: 0.58, w: 0.8, h: 0.05 } },
    ];

    const page = imagePage("packingList", lines);
    const doc: DocumentText = { docId: "packingList", kind: "packingList", pages: [page] };

    const fields = [
      {
        field: "packingList.lines.1.itemNo",
        value: "MCA-101",
        quote: "MCA-101",
        doc: "packingList",
        page: 1,
      },
      {
        field: "packingList.lines.1.cartons",
        value: "20",
        quote: "20",
        doc: "packingList",
        page: 1,
      },
      {
        field: "packingList.lines.2.itemNo",
        value: "MCA-102",
        quote: "MCA-102",
        doc: "packingList",
        page: 1,
      },
      {
        field: "packingList.lines.2.cartons",
        value: "24",
        quote: "24",
        doc: "packingList",
        page: 1,
      },
      {
        field: "packingList.lines.4.itemNo",
        value: "MCA-104",
        quote: "MCA-104",
        doc: "packingList",
        page: 1,
      },
      {
        field: "packingList.lines.4.cartons",
        value: "6",
        quote: "6",
        doc: "packingList",
        page: 1,
      },
      {
        field: "packingList.totalCartons",
        value: "77",
        quote: "77",
        doc: "packingList",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    // All should be accepted with imageTranscript origin
    for (const v of verified) {
      expect(v.status).toBe("accepted");
      if (v.status === "accepted") {
        expect((v as any).origin).toBe("imageTranscript");
      }
    }
  });

  it("7. A quote that is found once gives the same status and box as the existing code", () => {
    const page = invoicePage();
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    const fields = [
      {
        field: "invoice.number",
        value: "Invoice No.: MCA-INV-1",
        quote: "Invoice No.: MCA-INV-1",
        doc: "invoice",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    // This should be rejected because "Invoice No.: MCA-INV-1" is not on the invoice page
    expect(verified[0].status).toBe("rejected");
  });
});

describe("Requirement 35: Date Parsing and Quote Matching", () => {
  it("1. 'Date: 03 Nov 2026' parsed to '11/03/2026' is accepted; 'Shipped on board: 05 NOV 2026' parsed to '11/05/2026' is accepted on bill of lading", () => {
    const page = invoicePage();
    const invoiceDoc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    const bilLines = [
      { text: "Shipped on board: 05 NOV 2026", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.05 } },
    ];
    const bilPage = imagePage("billOfLading", bilLines);
    const bilDoc: DocumentText = { docId: "billOfLading", kind: "billOfLading", pages: [bilPage] };

    const fields = [
      {
        field: "invoice.date",
        value: "11/03/2026",
        quote: "Date: 03 Nov 2026",
        doc: "invoice",
        page: 1,
      },
      {
        field: "billOfLading.onBoardDate",
        value: "11/05/2026",
        quote: "Shipped on board: 05 NOV 2026",
        doc: "billOfLading",
        page: 1,
      },
    ];

    const verified = check(fields, [invoiceDoc, bilDoc]);

    expect(verified[0].status).toBe("accepted");
    if (verified[0].status === "accepted") {
      expect(verified[0].itemIds).toEqual([itemIdOf(page, "Date: 03 Nov 2026", 714)]);
    }

    expect(verified[1].status).toBe("accepted");
    if (verified[1].status === "accepted") {
      expect((verified[1] as any).origin).toBe("imageTranscript");
    }
  });

  it("2. Various date formats parsed to 11/06/2026 — all accepted; some invalid dates rejected", () => {
    const testCases = [
      { quote: "Invoice date: Nov 06, 2026", value: "11/06/2026", shouldAccept: true },
      { quote: "Date: November 6, 2026", value: "11/06/2026", shouldAccept: true },
      { quote: "Date: 12-NOV-2026", value: "11/12/2026", shouldAccept: true },
      { quote: "Date: 2026-11-03", value: "11/03/2026", shouldAccept: true },
      { quote: "Datum: 09.11.2026", value: "11/09/2026", shouldAccept: true },
      { quote: "Datum: 09.11.2026", value: "09/11/2026", shouldAccept: false }, // day/month swapped
      { quote: "Date: 03/11/2026", value: "11/03/2026", shouldAccept: false }, // US format vs DD/MM
      { quote: "Date: 03 Nov 2026", value: "11/04/2026", shouldAccept: false }, // wrong day
      { quote: "Date: 03 Nov 2026", value: "02/30/2026", shouldAccept: false }, // invalid date
      { quote: "From 03 Nov 2026 to 05 Nov 2026", value: "11/03/2026", shouldAccept: false }, // multiple dates
    ];

    for (const testCase of testCases) {
      const items = [raw(testCase.quote, 317, 714)];
      const page = textPage(items);
      const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

      const fields = [
        {
          field: "invoice.date",
          value: testCase.value,
          quote: testCase.quote,
          doc: "invoice",
          page: 1,
        },
      ];

      const verified = check(fields, [doc]);

      if (testCase.shouldAccept) {
        expect(verified[0].status).toBe("accepted");
      } else {
        expect(verified[0].status).toBe("rejected");
      }
    }
  });

  it("3. Multi-item address accepted with comma-separated quote across items", () => {
    const page = invoicePage();
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    const fields = [
      {
        field: "invoice.seller.address",
        value: "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal",
        quote: "Rua das Corujas 12, Vila Nevoa 0000-000 Portugal",
        doc: "invoice",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    expect(verified[0].status).toBe("accepted");
    if (verified[0].status === "accepted") {
      expect(verified[0].itemIds).toEqual([
        itemIdOf(page, "Rua das Corujas 12, Vila Nevoa", 700),
        itemIdOf(page, "0000-000 Portugal", 686),
      ]);
    }
  });

  it("3b. Same address value without comma is accepted", () => {
    const page = invoicePage();
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    const fields = [
      {
        field: "invoice.seller.address",
        value: "Rua das Corujas 12, Vila Nevoa 0000-000 Portugal",
        quote: "Rua das Corujas 12, Vila Nevoa 0000-000 Portugal",
        doc: "invoice",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    expect(verified[0].status).toBe("accepted");
    if (verified[0].status === "accepted") {
      expect(verified[0].itemIds).toEqual([
        itemIdOf(page, "Rua das Corujas 12, Vila Nevoa", 700),
        itemIdOf(page, "0000-000 Portugal", 686),
      ]);
    }
  });

  it("3c. Address with semicolon instead of comma is rejected", () => {
    const page = invoicePage();
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    const fields = [
      {
        field: "invoice.seller.address",
        value: "Rua das Corujas 12, Vila Nevoa; 0000-000 Portugal",
        quote: "Rua das Corujas 12, Vila Nevoa 0000-000 Portugal",
        doc: "invoice",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    expect(verified[0].status).toBe("rejected");
    if (verified[0].status === "rejected") {
      expect(verified[0].reason).toBe("value_not_in_quote");
    }
  });

  it("4. Address with parts in different columns is rejected with 'quote_not_found'", () => {
    const page = invoicePage(true);
    const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

    const fields = [
      {
        field: "invoice.seller.address",
        value: "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal",
        quote: "Rua das Corujas 12, Vila Nevoa 0000-000 Portugal",
        doc: "invoice",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    expect(verified[0].status).toBe("rejected");
    if (verified[0].status === "rejected") {
      expect(verified[0].reason).toBe("quote_not_found");
    }
  });

  it("5. Bill of lading address over two transcript lines with comma at row change is accepted", () => {
    const lines = [
      { text: "Rua das Corujas 12, Vila Nevoa", box: { x: 0.17, y: 0.14, w: 0.65, h: 0.04 } },
      { text: "0000-000 Portugal", box: { x: 0.17, y: 0.18, w: 0.65, h: 0.04 } },
    ];

    const page = imagePage("billOfLading", lines);
    const doc: DocumentText = { docId: "billOfLading", kind: "billOfLading", pages: [page] };

    const fields = [
      {
        field: "billOfLading.packages",
        value: "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal",
        quote: "Rua das Corujas 12, Vila Nevoa 0000-000 Portugal",
        doc: "billOfLading",
        page: 1,
      },
    ];

    const verified = check(fields, [doc]);

    expect(verified[0].status).toBe("accepted");
    if (verified[0].status === "accepted") {
      expect(verified[0].itemIds).toHaveLength(2);
    }
  });
});

describe("Requirement 36.1: Low Confidence Readings", () => {
  it("1. A low reading with matching quote and value becomes 'uncertain' with same itemIds and box, origin 'imageTranscript'", () => {
    const lines = [
      { text: "TOTAL 77 4,980 1,103.0 1,248.0", box: { x: 0.1, y: 0.58, w: 0.8, h: 0.05 } },
    ];

    const page = imagePage("packingList", lines);
    const doc: DocumentText = { docId: "packingList", kind: "packingList", pages: [page] };

    // First, test the same reading without confidence (should be accepted)
    const fieldsNoConfidence = [
      {
        field: "packingList.totalGrossKg",
        value: "1,248.0",
        quote: "1,248.0",
        doc: "packingList",
        page: 1,
      },
    ];

    const verifiedNoConfidence = check(fieldsNoConfidence, [doc]);
    expect(verifiedNoConfidence[0].status).toBe("accepted");

    const acceptedBox = verifiedNoConfidence[0].status === "accepted" ? verifiedNoConfidence[0].box : null;
    const acceptedItemIds =
      verifiedNoConfidence[0].status === "accepted" ? verifiedNoConfidence[0].itemIds : null;

    // Now test with low confidence
    const fieldsWithLow = [
      {
        field: "packingList.totalGrossKg",
        value: "1,248.0",
        quote: "1,248.0",
        doc: "packingList",
        page: 1,
        confidence: "low",
      },
    ];

    const verifiedWithLow = check(fieldsWithLow, [doc]);

    expect(verifiedWithLow[0].status).toBe("uncertain");
    if ((verifiedWithLow[0] as any).status === "uncertain") {
      expect((verifiedWithLow[0] as any).box).toEqual(acceptedBox);
      expect((verifiedWithLow[0] as any).itemIds).toEqual(acceptedItemIds);
      expect((verifiedWithLow[0] as any).origin).toBe("imageTranscript");
      expect((verifiedWithLow[0] as any).message).toContain("not sure");
    }
  });

  it("2. A low reading whose quote is not on the page is rejected with 'quote_not_found', not 'low_confidence'", () => {
    const lines = [
      { text: "TOTAL 77 4,980", box: { x: 0.1, y: 0.58, w: 0.8, h: 0.05 } },
    ];

    const page = imagePage("packingList", lines);
    const doc: DocumentText = { docId: "packingList", kind: "packingList", pages: [page] };

    const fields = [
      {
        field: "packingList.totalGrossKg",
        value: "1,248.0",
        quote: "1,248.0",
        doc: "packingList",
        page: 1,
        confidence: "low",
      },
    ];

    const verified = check(fields, [doc]);

    expect(verified[0].status).toBe("rejected");
    if (verified[0].status === "rejected") {
      expect(verified[0].reason).toBe("quote_not_found");
    }
  });

  it("2b. A low reading whose value is not in its quote is rejected with 'value_not_in_quote'", () => {
    const lines = [
      { text: "TOTAL 77 4,980 1,103.0", box: { x: 0.1, y: 0.58, w: 0.8, h: 0.05 } },
    ];

    const page = imagePage("packingList", lines);
    const doc: DocumentText = { docId: "packingList", kind: "packingList", pages: [page] };

    const fields = [
      {
        field: "packingList.totalGrossKg",
        value: "1,248.0",
        quote: "TOTAL 77 4,980 1,103.0",
        doc: "packingList",
        page: 1,
        confidence: "low",
      },
    ];

    const verified = check(fields, [doc]);

    expect(verified[0].status).toBe("rejected");
    if (verified[0].status === "rejected") {
      expect(verified[0].reason).toBe("value_not_in_quote");
    }
  });
});

describe("Feature: document-intake, Property 51: A Repeated Value Is Checked in Its Own Line (Validates: Requirements 34.1, 34.2, 34.3, 34.4)", () => {
  it("should handle repeated values only accepting when unique in target line", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.array(
          fc.record({
            origin: fc.constantFrom("PT", "CN", "DE"),
            unit: fc.constantFrom("PCS", "DZ"),
            hts: fc.constantFrom("6913.90.5000", "7013.99.3500"),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (baseValue, rows) => {
          // Build page with rows - item numbers are IT-1, IT-2, etc. (never repeat)
          const rawItems: unknown[] = [];
          for (let k = 0; k < rows.length; k++) {
            const y = 600 - 20 * k;
            rawItems.push(raw(`IT-${k + 1}`, 40, y));
            rawItems.push(raw(rows[k].origin, 270, y));
            rawItems.push(raw(rows[k].unit, 350, y));
            rawItems.push(raw(rows[k].hts, 430, y));
          }

          const page = textPage(rawItems);
          const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

          // For each row, create readings with item number anchor
          const fields = [];
          for (let k = 0; k < rows.length; k++) {
            fields.push({
              field: `invoice.lines.${k + 1}.itemNo`,
              value: `IT-${k + 1}`,
              quote: `IT-${k + 1}`,
              doc: "invoice",
              page: 1,
            });
            fields.push({
              field: `invoice.lines.${k + 1}.origin`,
              value: rows[k].origin,
              quote: rows[k].origin,
              doc: "invoice",
              page: 1,
            });
            fields.push({
              field: `invoice.lines.${k + 1}.unit`,
              value: rows[k].unit,
              quote: rows[k].unit,
              doc: "invoice",
              page: 1,
            });
            fields.push({
              field: `invoice.lines.${k + 1}.hts`,
              value: rows[k].hts,
              quote: rows[k].hts,
              doc: "invoice",
              page: 1,
            });
          }

          const verified = check(fields, [doc]);

          // All readings should be accepted
          for (let k = 0; k < rows.length; k++) {
            const base = 600 - 20 * k;
            const cells: Array<[number, string]> = [[k * 4 + 1, rows[k].origin], [k * 4 + 2, rows[k].unit], [k * 4 + 3, rows[k].hts]];
            for (const [idx, text] of cells) {
              expect(verified[idx].status).toBe("accepted");
              expect((verified[idx] as any).itemIds).toEqual([itemIdOf(page, text, base)]);
            }
          }

          // Test that readings with non-matching origin that appears in 2+ other rows are not accepted
          for (let k = 0; k < rows.length; k++) {
            for (const o of ["PT", "CN", "DE"]) {
              if (rows[k].origin === o) continue;
              if (rows.filter((r, j) => j !== k && r.origin === o).length < 2) continue;
              const [v] = check(
                [
                  {
                    field: `invoice.lines.${k + 1}.itemNo`,
                    value: `IT-${k + 1}`,
                    quote: `IT-${k + 1}`,
                    doc: "invoice",
                    page: 1,
                  },
                  {
                    field: `invoice.lines.${k + 1}.origin`,
                    value: o,
                    quote: o,
                    doc: "invoice",
                    page: 1,
                  },
                ],
                [doc],
              ).slice(1);
              expect(v.status).not.toBe("accepted");
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-intake, Property 52: A Date Is Accepted Only for the Same Day (Validates: Requirements 35.1)", () => {
  it("should parse various date formats and accept only matching day", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 36500 }).map((days) => {
          const d = new Date("2000-01-01");
          d.setUTCDate(d.getUTCDate() + days);
          return d;
        }),
        fc.constantFrom("DD Mon YYYY", "DD-MON-YYYY", "Mon DD, YYYY", "Month D, YYYY", "YYYY-MM-DD", "DD.MM.YYYY"),
        (date, format) => {
          const year = date.getUTCFullYear();
          const month = String(date.getUTCMonth() + 1).padStart(2, "0");
          const day = String(date.getUTCDate()).padStart(2, "0");
          const monthName = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
          const monthNameFull = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" });

          let printed = "";
          if (format === "DD Mon YYYY") {
            printed = `${day} ${monthName} ${year}`;
          } else if (format === "DD-MON-YYYY") {
            printed = `${day}-${monthName.toUpperCase()}-${year}`;
          } else if (format === "Mon DD, YYYY") {
            printed = `${monthName} ${day}, ${year}`;
          } else if (format === "Month D, YYYY") {
            printed = `${monthNameFull} ${parseInt(day)}, ${year}`;
          } else if (format === "YYYY-MM-DD") {
            printed = `${year}-${month}-${day}`;
          } else if (format === "DD.MM.YYYY") {
            printed = `${day}.${month}.${year}`;
          }

          const items = [raw(`Date: ${printed}`, 317, 714)];
          const page = textPage(items);
          const doc: DocumentText = { docId: "invoice", kind: "invoice", pages: [page] };

          // Test: correct date should be accepted
          const correctValue = `${month}/${day}/${year}`;
          const fieldsCorrect = [
            {
              field: "invoice.date",
              value: correctValue,
              quote: `Date: ${printed}`,
              doc: "invoice",
              page: 1,
            },
          ];

          const verifiedCorrect = check(fieldsCorrect, [doc]);
          expect(verifiedCorrect[0].status).toBe("accepted");

          // Test: wrong date should be rejected
          const wrongDate = new Date(date);
          wrongDate.setUTCDate(wrongDate.getUTCDate() + 1);
          const wrongMonth = String(wrongDate.getUTCMonth() + 1).padStart(2, "0");
          const wrongDay = String(wrongDate.getUTCDate()).padStart(2, "0");
          const wrongValue = `${wrongMonth}/${wrongDay}/${wrongDate.getUTCFullYear()}`;

          const fieldsWrong = [
            {
              field: "invoice.date",
              value: wrongValue,
              quote: `Date: ${printed}`,
              doc: "invoice",
              page: 1,
            },
          ];

          const verifiedWrong = check(fieldsWrong, [doc]);
          expect(verifiedWrong[0].status).toBe("rejected");

          // For DD.MM.YYYY, test swapped day/month
          if (format === "DD.MM.YYYY" && parseInt(day) !== parseInt(month)) {
            const swappedValue = `${day}/${month}/${year}`;
            const fieldsSwapped = [
              {
                field: "invoice.date",
                value: swappedValue,
                quote: `Date: ${printed}`,
                doc: "invoice",
                page: 1,
              },
            ];

            const verifiedSwapped = check(fieldsSwapped, [doc]);
            expect(verifiedSwapped[0].status).toBe("rejected");
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
