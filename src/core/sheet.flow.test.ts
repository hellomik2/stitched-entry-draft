import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readXlsx, sheetToPageText } from "./sheet";
import { extractDocumentText, type DocumentText } from "./pdfText";
import { verifyReadings, type ReadingAnswer, type VerifiedReading } from "./reading";
import { buildDraft, allFields, type DocSource, type Draft } from "./draft";
import { formatSource, draftToCsv } from "./csv";
import type { HtsTable } from "./hts";
import { openPdf } from "../node/index";

// Feature: document-intake, Requirement 45.6 and 45.7 (task 56.1): a sheet page goes the way of a text page and its readings carry the cell.

const FILES = join(process.cwd(), "samples", "upload-test", "files");
const REC = join(process.cwd(), "samples", "upload-test", "recordings", "upload-test-gloamwick.json");

let documents: DocumentText[];
let verified: VerifiedReading[];
let draft: Draft;
let hts: HtsTable;

beforeAll(async () => {
  hts = JSON.parse(readFileSync(join(process.cwd(), "data", "hts", "2026HTSRev23-subset.json"), "utf8"));
  const invoice = await extractDocumentText(await openPdf(new Uint8Array(readFileSync(join(FILES, "gloamwick-invoice.pdf")))), "invoice", "invoice");
  const bl = await extractDocumentText(await openPdf(new Uint8Array(readFileSync(join(FILES, "gloamwick-bill-of-lading.pdf")))), "billOfLading", "billOfLading");
  const wb = readXlsx(new Uint8Array(readFileSync(join(FILES, "gloamwick-packing-list.xlsx"))), "gloamwick-packing-list.xlsx");
  if (!wb.ok) throw new Error(wb.reason);
  const packing: DocumentText = { docId: "packingList", kind: "packingList", pages: [sheetToPageText(wb.value.sheets[0], "packingList", 1)] };
  documents = [invoice, packing, bl];
  const rec = JSON.parse(readFileSync(REC, "utf8"));
  const answer: ReadingAnswer = {
    schemaVersion: 1,
    bundle: "upload",
    reader: rec.output.reader,
    documents: [
      { docId: "invoice", kind: "invoice" },
      { docId: "packingList", kind: "packingList" },
      { docId: "billOfLading", kind: "billOfLading" },
    ],
    fields: rec.output.fields,
    invoiceLineCount: rec.output.invoiceLineCount,
  };
  verified = verifyReadings(answer, documents);
  draft = buildDraft({ bundle: "upload", reader: answer.reader, readings: verified, hts, invoiceLineCount: answer.invoiceLineCount ?? null });
});

const get = (field: string) => verified.find((v) => v.field === field)!;

describe("Requirement 45: the parts-list test bundle's Excel packing list through the quote check", () => {
  it("45.6 every recorded reading of the three documents passes the same quote check as a text PDF page", () => {
    const notAccepted = verified.filter((v) => v.status !== "accepted").map((v) => `${v.field}: ${v.status}`);
    expect(notAccepted).toEqual([]);
    expect(verified.filter((v) => v.field.startsWith("packingList.")).length).toBe(32);
  });

  it("45.7 a reading on the sheet page carries the address of the cell its value is in", () => {
    expect(get("packingList.totalGrossKg")).toMatchObject({ status: "accepted", value: "437.4", cell: "'Packing List'!G13" });
    expect(get("packingList.number")).toMatchObject({ status: "accepted", cell: "'Packing List'!B3" });
    expect(get("packingList.lines.2.quantity")).toMatchObject({ status: "accepted", value: "1,200", cell: "'Packing List'!D9" });
    expect(get("packingList.lines.1.itemNo")).toMatchObject({ status: "accepted", cell: "'Packing List'!A8" });
    // Readings on PDF pages have no cell.
    expect("cell" in get("invoice.number")).toBe(false);
    expect("cell" in get("billOfLading.grossKg")).toBe(false);
  });

  it("45.7 a quote over two cells gives the first and last cell", () => {
    const docs = documents;
    const answer: ReadingAnswer = {
      schemaVersion: 1,
      bundle: "upload",
      reader: "test",
      documents: [{ docId: "packingList", kind: "packingList" }],
      fields: [{ field: "packingList.invoiceRef", value: "Invoice Ref.: GPL-26-1131", quote: "Invoice Ref.: GPL-26-1131", doc: "packingList", page: 1, confidence: "high" }],
    };
    const [r] = verifyReadings(answer, docs);
    expect(r).toMatchObject({ status: "accepted", cell: "'Packing List'!A4:B4" });
  });

  it("45.7 the draft source made from a sheet reading carries the cell, and the CSV shows it after the quote", () => {
    const sheetSources = allFields(draft)
      .flatMap((f) => f.sources)
      .filter((s): s is DocSource => s.kind === "document" && s.doc === "packingList");
    expect(sheetSources.length).toBeGreaterThan(0);
    for (const s of sheetSources) expect(s.cell).toMatch(/^'Packing List'!(A|B|C|D|E|F|G)\d+(:[A-G]\d+)?$/);
    const pdfSources = allFields(draft)
      .flatMap((f) => f.sources)
      .filter((s): s is DocSource => s.kind === "document" && s.doc !== "packingList");
    expect(pdfSources.length).toBeGreaterThan(0);
    for (const s of pdfSources) expect("cell" in s).toBe(false);

    const src: DocSource = {
      kind: "document",
      doc: "packingList",
      page: 1,
      quote: "437.4",
      box: { x: 522, y: 200, w: 78, h: 15 },
      readingField: "packingList.totalGrossKg",
      cell: "'Packing List'!G13",
    };
    expect(formatSource(src)).toBe(`packingList p.1 [522.0,200.0,78.0,15.0] "437.4" (cell 'Packing List'!G13)`);
    const withoutCell: DocSource = { kind: "document", doc: "packingList", page: 1, quote: "437.4", box: src.box, readingField: "packingList.totalGrossKg" };
    expect(formatSource(withoutCell)).toBe(`packingList p.1 [522.0,200.0,78.0,15.0] "437.4"`);
    expect(draftToCsv(draft)).toContain("(cell 'Packing List'!");
  });

  it("46.9 without a parts list, the invoice lines without an HTS number wait as today", () => {
    const l1 = draft.lines.find((l) => l.invoiceLines.includes(1))!;
    const f = l1.fields.find((x) => x.block === "33A")!;
    expect(f.status).toBe("needsReview");
    expect(f.value).toBeNull();
    expect(f.reason).toBe("The HTS number of invoice line 1 was not read. A person reads it on the invoice. The app does not choose a number.");
    expect(allFields(draft).some((x) => x.sources.some((s) => s.kind === "document" && s.doc === "partsList"))).toBe(false);
  });
});
