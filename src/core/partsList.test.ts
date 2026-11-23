import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readXlsx, readCsvSheet, sheetToPageText } from "./sheet";
import { readPartsList, type PartsList } from "./partsList";
import { buildDraft, allFields, type Draft, type DraftField, type DocSource } from "./draft";
import { draftToCsv } from "./csv";
import { verifyReadings, type ReadingAnswer, type VerifiedReading } from "./reading";
import { extractDocumentText, type DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { openPdf } from "../node/index";

// Feature: document-intake, Requirement 46 (task 57.1): a customer parts list gives the HTS number, origin and MID.

const FILES = join(process.cwd(), "samples", "upload-test", "files");
const hts: HtsTable = JSON.parse(readFileSync(join(process.cwd(), "data", "hts", "2026HTSRev23-subset.json"), "utf8"));
const BOX = { x: 10, y: 10, w: 40, h: 10 };
const TODAY_B13 = "Invoice names a trading company; manufacturer per line not in bundle.";
const SUFFIX = " A person reads it on the invoice. The app does not choose a number.";

let seq = 0;
function acc(field: string, value: string): VerifiedReading {
  const doc = field.split(".")[0];
  seq += 1;
  return { field, value, quote: value, doc, page: 1, confidence: "high", status: "accepted", box: BOX, itemIds: [`${doc}:p1:i${seq}`] };
}
type Line = { item?: string; hts?: string; origin?: string };
function readingsFor(lines: Line[]): VerifiedReading[] {
  const out: VerifiedReading[] = [acc("invoice.currency", "USD")];
  lines.forEach((l, i) => {
    const n = i + 1;
    if (l.item !== undefined) out.push(acc(`invoice.lines.${n}.itemNo`, l.item));
    out.push(acc(`invoice.lines.${n}.description`, `Item ${n}`));
    if (l.hts) out.push(acc(`invoice.lines.${n}.hts`, l.hts));
    if (l.origin) out.push(acc(`invoice.lines.${n}.origin`, l.origin));
    out.push(acc(`invoice.lines.${n}.quantity`, "100"));
    out.push(acc(`invoice.lines.${n}.unit`, "PCS"));
    out.push(acc(`invoice.lines.${n}.unitPrice`, "1.00"));
    out.push(acc(`invoice.lines.${n}.amount`, "100.00"));
  });
  return out;
}
function list(csv: string, name = "parts.csv"): PartsList {
  const sh = readCsvSheet(csv, name);
  if (!sh.ok) throw new Error(sh.reason);
  const pl = readPartsList(sh.value);
  if (!pl.ok) throw new Error(pl.reason);
  return pl.value;
}
const draftOf = (lines: Line[], partsList: PartsList | null = null): Draft =>
  buildDraft({ bundle: "upload", reader: "test", readings: readingsFor(lines), hts, partsList });
const lineOf = (d: Draft, n: number) => d.lines.find((l) => l.invoiceLines.includes(n))!;
const fieldOf = (d: Draft, n: number, block: string) => lineOf(d, n).fields.find((f) => f.block === block)!;
const header = (d: Draft, id: string) => d.header.find((f) => f.id === id)!;
const listSources = (f: DraftField) => f.sources.filter((s): s is DocSource => s.kind === "document" && s.doc === "partsList");
const docKinds = (f: DraftField) => f.sources.filter((s) => s.kind === "document").map((s) => (s as DocSource).doc).sort();

describe("Requirement 46.2: readPartsList", () => {
  it("finds the header row under title rows, knows the other column names and skips rows without a part code", () => {
    const pl = list(
      [
        "Customer parts list,,,,",
        ",,,,",
        "SKU:,Item Description,US HTS Code,Country of Origin,Manufacturer ID",
        "A-1,Lantern,9405.50.4000,VN,VNGLOPAP88THO",
        ",no code,9405.50.4000,VN,",
        "A-2,Votive,7013993500,Vietnam,",
      ].join("\r\n"),
    );
    expect(pl.docId).toBe("partsList");
    expect(pl.sheetName).toBe("parts");
    expect(pl.page.origin).toBe("sheet");
    expect(pl.rows.map((r) => r.row)).toEqual([4, 6]);
    const r = pl.rows[0];
    expect(r.partNo).toMatchObject({ text: "A-1", cell: "parts!A4" });
    expect(r.description).toMatchObject({ text: "Lantern", cell: "parts!B4" });
    expect(r.hts).toMatchObject({ text: "9405.50.4000", cell: "parts!C4" });
    expect(r.origin).toMatchObject({ text: "VN", cell: "parts!D4" });
    expect(r.mid).toMatchObject({ text: "VNGLOPAP88THO", cell: "parts!E4" });
    expect(pl.rows[1].mid).toBeNull();
    expect(pl.rows[1].hts?.text).toBe("7013993500");
    // The cell box is the box of that cell on the drawn sheet page.
    const item = pl.page.items.find((i) => i.cell === "parts!C4")!;
    expect(r.hts?.box).toEqual(item.box);
  });

  it("refuses a list without a part code column and an HTS column in the first 20 rows", () => {
    const reason =
      "No header row with a part code column and an HTS column in the first 20 rows. Use the template's column names: Part No, Description, HTS, Origin, MID.";
    const noHts = readCsvSheet("Part No,Description\nA-1,Lantern\n", "a.csv");
    if (!noHts.ok) throw new Error(noHts.reason);
    expect(readPartsList(noHts.value)).toEqual({ ok: false, reason });
    const late = readCsvSheet([...Array.from({ length: 20 }, () => "note,"), "Part No,HTS", "A-1,9405.50.4000"].join("\n"), "b.csv");
    if (!late.ok) throw new Error(late.reason);
    expect(readPartsList(late.value)).toEqual({ ok: false, reason });
  });

  it("reads the shipped lists: Excel rows and cells, and the CSV with line numbers", () => {
    const wb = readXlsx(new Uint8Array(readFileSync(join(FILES, "gloamwick-customer-parts-list.xlsx"))), "gloamwick-customer-parts-list.xlsx");
    if (!wb.ok) throw new Error(wb.reason);
    const x = readPartsList(wb.value.sheets[0]);
    if (!x.ok) throw new Error(x.reason);
    expect(x.value.rows.map((r) => [r.row, r.partNo.text, r.hts?.text ?? null])).toEqual([
      [5, "GPL-101", "9405.50.4000"],
      [6, "GPL-102", "7013.99.3500"],
      [7, "GPL 103", "9505.90.4000"],
      [8, "GPL-104", "6913.90.1000"],
      [9, "GPL-105", "3926.40.0090"],
      [10, "GPL-110", "9505.90.6000"],
      [12, "DEMO / FICTITIOUS. Invented companies, goods and addresses. Not a real shipment.", null],
    ]);
    expect(x.value.rows[0].hts?.cell).toBe("Parts!C5");
    const c = list(readFileSync(join(FILES, "gloamwick-customer-parts-list.csv"), "utf8"), "gloamwick-customer-parts-list.csv");
    expect(c.rows[0]).toMatchObject({ row: 2, partNo: { text: "GPL-101" }, hts: { text: "9405.50.4000", cell: "'gloamwick-customer-parts-list'!C2" } });
  });
});

describe("Requirement 46.3 to 46.7: the draft takes the list's values", () => {
  const ONE = "Part No,HTS,Origin,MID\r\nA-1,9405.50.4000,VN,VNGLOPAP88THO\r\n";

  it("46.4a with no invoice HTS number, 33A is the list number with the list cell before the tariff source", () => {
    const d = draftOf([{ item: "A-1", origin: "VN" }], list(ONE));
    const f = fieldOf(d, 1, "33A");
    expect(f.status).toBe("copied");
    expect(f.value).toBe("9405.50.4000");
    expect(f.rule).toBe("P15");
    expect(f.note?.startsWith('From the customer parts list row 2 (part code "A-1"). Found in ')).toBe(true);
    expect(f.sources[0]).toMatchObject({ kind: "document", doc: "partsList", page: 1, quote: "9405.50.4000", readingField: "partsList.rows.2.hts", cell: "parts!B2" });
    expect(f.sources[f.sources.length - 1]).toMatchObject({ kind: "hts", htsno: "9405.50.40.00" });
    for (const b of ["35", "37A"]) expect(fieldOf(d, 1, b).reason ?? "").not.toContain("Waiting on L001.33A");
    expect(fieldOf(d, 1, "37A").value).not.toBeNull();
  });

  it("46.4b the same 10 digits keep the invoice number and add the list cell", () => {
    const d = draftOf([{ item: "A-1", hts: "9405.50.4000", origin: "VN" }], list("Part No,HTS\nA-1,9405504000\n"));
    const f = fieldOf(d, 1, "33A");
    expect(f.status).toBe("copied");
    expect(f.value).toBe("9405.50.4000");
    expect(f.note?.startsWith('The customer parts list row 2 (part code "A-1") gives the same number. Found in ')).toBe(true);
    expect(docKinds(f)).toEqual(["invoice", "partsList"]);
    expect(f.sources[0]).toMatchObject({ doc: "invoice" });
  });

  it("46.4c a different number gives the line its own 7501 line, waits and shows both", () => {
    const d = draftOf(
      [
        { item: "A-1", hts: "6913.90.5000", origin: "VN" },
        { item: "A-2", hts: "6913.90.5000", origin: "VN" },
      ],
      list("Part No,HTS\nA-1,6913.90.1000\n"),
    );
    expect(d.lines.map((l) => l.invoiceLines)).toEqual([[1], [2]]);
    const f = fieldOf(d, 1, "33A");
    expect(f.status).toBe("needsReview");
    expect(f.value).toBeNull();
    expect(f.rule).toBe("P15");
    expect(f.reason).toBe('Invoice line 1 gives HTS 6913.90.5000, and the customer parts list row 2 (part code "A-1") gives 6913.90.1000. A person picks the number.');
    expect(docKinds(f)).toEqual(["invoice", "partsList"]);
    // 35 first compares the invoice quantity with the packing list (none here), as it does without a list
    expect(fieldOf(d, 1, "35").value).toBeNull();
    expect(fieldOf(d, 1, "37A").value).toBeNull();
    expect(fieldOf(d, 1, "37A").reason).toBe("Waiting on L001.33A: the invoice and the customer parts list give different HTS numbers.");
    expect(fieldOf(d, 1, "38").value).toBeNull();
    expect(fieldOf(d, 1, "38").status).toBe("needsReview");
    expect(fieldOf(d, 2, "33A")).toMatchObject({ status: "copied", value: "6913.90.5000" });
    expect(listSources(fieldOf(d, 2, "33A"))).toEqual([]);
  });

  it("46.3, 46.5 only an exactly equal part code matches; otherwise the reason says the code is not in the list", () => {
    for (const code of ["a-1", "A 1", "A1", "A-01", "A-1X"]) {
      const d = draftOf([{ item: code, origin: "VN" }], list(ONE));
      const f = fieldOf(d, 1, "33A");
      expect(f.status).toBe("needsReview");
      expect(f.value).toBeNull();
      expect(f.reason).toBe(`The HTS number of invoice line 1 was not read. Part code "${code}" of invoice line 1 is not in the customer parts list.${SUFFIX}`);
      expect(allFields(d).flatMap(listSources)).toEqual([]);
    }
    // Outer spaces are removed before comparing.
    expect(fieldOf(draftOf([{ item: " A-1 ", origin: "VN" }], list(ONE)), 1, "33A").value).toBe("9405.50.4000");
  });

  it("46.3 two rows with the code are not used", () => {
    const d = draftOf([{ item: "A-1", origin: "VN" }], list("Part No,HTS\nA-1,9405.50.4000\nA-1,7013.99.3500\n"));
    const f = fieldOf(d, 1, "33A");
    expect(f.value).toBeNull();
    expect(f.reason).toBe(
      `The HTS number of invoice line 1 was not read. Part code "A-1" of invoice line 1 is on 2 rows of the customer parts list (rows 2, 3), so the list was not used.${SUFFIX}`,
    );
  });

  it("46.5 an unusable list number is named; with an invoice number it changes nothing", () => {
    const d = draftOf([{ item: "A-1", origin: "VN" }], list("Part No,HTS\nA-1,940550400\n"));
    expect(fieldOf(d, 1, "33A").reason).toBe(
      `The HTS number of invoice line 1 was not read. Customer parts list row 2 (part code "A-1") has no usable HTS number ("940550400").${SUFFIX}`,
    );
    const lines = [{ item: "A-1", hts: "9405.50.4000", origin: "VN" }];
    expect(fieldOf(draftOf(lines, list("Part No,HTS\nA-1,940550400\n")), 1, "33A")).toEqual(fieldOf(draftOf(lines), 1, "33A"));
    expect(fieldOf(draftOf(lines, list("Part No,HTS\nB-2,7013.99.3500\n")), 1, "33A")).toEqual(fieldOf(draftOf(lines), 1, "33A"));
  });

  it("46.6 origin from the list, the same origin, and a different origin", () => {
    const from = fieldOf(draftOf([{ item: "A-1" }], list(ONE)), 1, "10");
    expect(from).toMatchObject({ status: "copied", value: "VN", note: 'From the customer parts list row 2 (part code "A-1").' });
    expect(from.sources).toEqual([expect.objectContaining({ doc: "partsList", readingField: "partsList.rows.2.origin", cell: "parts!C2" })]);
    expect(header(draftOf([{ item: "A-1" }], list(ONE)), "B10").value).toBe("VN");

    const same = fieldOf(draftOf([{ item: "A-1", origin: "VN" }], list("Part No,HTS,Origin\nA-1,9405.50.4000,Vietnam\n")), 1, "10");
    expect(same).toMatchObject({ status: "copied", value: "VN", note: 'The customer parts list row 2 (part code "A-1") gives the same country.' });
    expect(docKinds(same)).toEqual(["invoice", "partsList"]);

    const d = draftOf(
      [
        { item: "A-1", hts: "9405.50.4000", origin: "CN" },
        { item: "A-2", hts: "9405.50.4000", origin: "CN" },
      ],
      list(ONE),
    );
    expect(d.lines.map((l) => l.invoiceLines)).toEqual([[1], [2]]);
    const diff = fieldOf(d, 1, "10");
    expect(diff.status).toBe("needsReview");
    expect(diff.value).toBeNull();
    expect(diff.reason).toBe('Invoice line 1 gives origin CN, and the customer parts list row 2 (part code "A-1") gives VN. A person picks the country of origin.');
    expect(docKinds(diff)).toEqual(["invoice", "partsList"]);
  });

  it("46.7 one MID for every line fills B13; otherwise B13 waits and lists them", () => {
    const both = list("Part No,HTS,MID\nA-1,9405.50.4000,VNGLOPAP88THO\nA-2,7013.99.3500,VNGLOPAP88THO\n");
    const d = draftOf([{ item: "A-1", origin: "VN" }, { item: "A-2", origin: "VN" }], both);
    const b13 = header(d, "B13");
    expect(b13).toMatchObject({ status: "copied", value: "VNGLOPAP88THO", note: "From the customer parts list (one MID for every line)." });
    expect(listSources(b13).map((s) => s.readingField)).toEqual(["partsList.rows.2.mid", "partsList.rows.3.mid"]);

    const missing = header(draftOf([{ item: "A-1", origin: "VN" }, { item: "Z-9", origin: "VN" }], both), "B13");
    expect(missing.status).toBe("needsReview");
    expect(missing.value).toBeNull();
    expect(missing.reason).toBe(
      `${TODAY_B13} The customer parts list gives: invoice line 1 VNGLOPAP88THO; invoice line 2 none. A person checks the manufacturer of each line.`,
    );
    expect(listSources(missing).map((s) => s.readingField)).toEqual(["partsList.rows.2.mid"]);

    const two = list("Part No,HTS,MID\nA-1,9405.50.4000,VNAAABBB11HAN\nA-2,7013.99.3500,VNCCCDDD22HAN\n");
    expect(header(draftOf([{ item: "A-1", origin: "VN" }, { item: "A-2", origin: "VN" }], two), "B13").reason).toBe(
      `${TODAY_B13} The customer parts list gives: invoice line 1 VNAAABBB11HAN; invoice line 2 VNCCCDDD22HAN. A person checks the manufacturer of each line.`,
    );
    // Without a usable MID in the list, B13 is as today.
    const noMid = header(draftOf([{ item: "A-1", origin: "VN" }], list("Part No,HTS,MID\nA-1,9405.50.4000,vn-glo\n")), "B13");
    expect(noMid).toEqual(header(draftOf([{ item: "A-1", origin: "VN" }]), "B13"));
  });

  it("46.9 without a list the draft is exactly as before", () => {
    const lines = [{ item: "A-1", origin: "VN" }, { item: "A-2", hts: "7013.99.3500", origin: "VN" }];
    const a = buildDraft({ bundle: "upload", reader: "test", readings: readingsFor(lines), hts });
    const b = buildDraft({ bundle: "upload", reader: "test", readings: readingsFor(lines), hts, partsList: null });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

const TABLE = ["9405.50.4000", "7013.99.3500", "9505.90.4000", "6913.90.5000", "3926.40.0090", "9505.90.6000"];

describe("Property 62: Only an Exactly Equal Part Code Takes the List's Number (Validates: Requirements 46.3, 46.4, 46.5)", () => {
  const mutate = (code: string, how: string) =>
    how === "case" ? code.toLowerCase() : how === "space" ? code.replace("-", " ") : how === "hyphen" ? code.replace("-", "") : code + "X";

  it("an equal code takes the row's number with its cell; any other code takes nothing from the list", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            code: fc.constantFrom("A-1", "B-22", "C-333", "D-4", "E-5"),
            how: fc.constantFrom("same", "case", "space", "hyphen", "char"),
            origin: fc.constantFrom("VN", "CN"),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.array(fc.constantFrom(...TABLE), { minLength: 5, maxLength: 5 }),
        (spec, numbers) => {
          const codes = ["A-1", "B-22", "C-333", "D-4", "E-5"];
          const csv = ["Part No,HTS", ...codes.map((c, i) => `${c},${numbers[i]}`)].join("\n");
          const lines = spec.map((s) => ({ item: s.how === "same" ? s.code : mutate(s.code, s.how), origin: s.origin }));
          const d = draftOf(lines, list(csv));
          const d0 = draftOf(lines);
          spec.forEach((s, i) => {
            const n = i + 1;
            const f = fieldOf(d, n, "33A");
            const row = codes.indexOf(s.code) + 2;
            if (s.how === "same") {
              expect(f.value).toBe(numbers[row - 2]);
              expect(listSources(f).map((x) => x.readingField)).toContain(`partsList.rows.${row}.hts`);
            } else {
              for (const g of lineOf(d, n).fields) expect(listSources(g)).toEqual([]);
              const f0 = fieldOf(d0, n, "33A");
              expect([f.status, f.value]).toEqual([f0.status, f0.value]);
              expect(f.reason).toContain(`Part code "${lines[i].item}" of invoice line ${n} is not in the customer parts list.`);
            }
          });
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("Property 63: A Disagreement Waits and Shows Both (Validates: Requirements 46.4, 46.6)", () => {
  it("a different number or origin waits with both sources; the same keeps the value with both sources", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TABLE),
        fc.constantFrom(...TABLE),
        fc.constantFrom("VN", "CN"),
        fc.constantFrom("VN", "CN"),
        fc.boolean(),
        (invHts, listHts, invOrigin, listOrigin, dotted) => {
          const csv = `Part No,HTS,Origin\nA-1,${dotted ? listHts : listHts.replace(/\./g, "")},${listOrigin}\n`;
          const d = draftOf([{ item: "A-1", hts: invHts, origin: invOrigin }], list(csv));
          const f33 = fieldOf(d, 1, "33A");
          const f10 = fieldOf(d, 1, "10");
          expect(docKinds(f33)).toEqual(["invoice", "partsList"]);
          expect(docKinds(f10)).toEqual(["invoice", "partsList"]);
          if (invHts === listHts) {
            expect(f33.value).toBe(invHts);
          } else {
            expect([f33.status, f33.value]).toEqual(["needsReview", null]);
            for (const b of ["35", "37A", "38"]) expect(fieldOf(d, 1, b).value).toBeNull();
          }
          if (invOrigin === listOrigin) expect(f10.value).toBe(invOrigin);
          else expect([f10.status, f10.value]).toEqual(["needsReview", null]);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("Requirement 46: the parts-list test bundle end to end (recorded answer, no AI call)", () => {
  let verified: VerifiedReading[];
  let partsXlsx: PartsList;
  let partsCsv: PartsList;
  let d: Draft;

  beforeAll(async () => {
    const invoice = await extractDocumentText(await openPdf(new Uint8Array(readFileSync(join(FILES, "gloamwick-invoice.pdf")))), "invoice", "invoice");
    const bl = await extractDocumentText(await openPdf(new Uint8Array(readFileSync(join(FILES, "gloamwick-bill-of-lading.pdf")))), "billOfLading", "billOfLading");
    const wb = readXlsx(new Uint8Array(readFileSync(join(FILES, "gloamwick-packing-list.xlsx"))), "gloamwick-packing-list.xlsx");
    if (!wb.ok) throw new Error(wb.reason);
    const packing: DocumentText = { docId: "packingList", kind: "packingList", pages: [sheetToPageText(wb.value.sheets[0], "packingList", 1)] };
    const rec = JSON.parse(readFileSync(join(process.cwd(), "samples", "upload-test", "recordings", "upload-test-gloamwick.json"), "utf8"));
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
    verified = verifyReadings(answer, [invoice, packing, bl]);
    const lw = readXlsx(new Uint8Array(readFileSync(join(FILES, "gloamwick-customer-parts-list.xlsx"))), "gloamwick-customer-parts-list.xlsx");
    if (!lw.ok) throw new Error(lw.reason);
    const x = readPartsList(lw.value.sheets[0]);
    if (!x.ok) throw new Error(x.reason);
    partsXlsx = x.value;
    partsCsv = list(readFileSync(join(FILES, "gloamwick-customer-parts-list.csv"), "utf8"), "gloamwick-customer-parts-list.csv");
    d = buildDraft({ bundle: "upload", reader: "recorded", readings: verified, hts, invoiceLineCount: 5, partsList: partsXlsx });
  });

  it("builds one 7501 line per invoice line", () => {
    expect(verified.filter((v) => v.status !== "accepted")).toEqual([]);
    expect(d.lines.map((l) => l.invoiceLines)).toEqual([[1], [2], [3], [4], [5]]);
  });

  it("lines 1 and 2 take the list number, line 2 also the list origin", () => {
    const f1 = fieldOf(d, 1, "33A");
    expect(f1).toMatchObject({ status: "copied", value: "9405.50.4000" });
    expect(f1.note?.startsWith('From the customer parts list row 5 (part code "GPL-101").')).toBe(true);
    expect(listSources(f1)[0]).toMatchObject({ cell: "Parts!C5", readingField: "partsList.rows.5.hts", quote: "9405.50.4000" });
    expect(fieldOf(d, 2, "33A")).toMatchObject({ status: "copied", value: "7013.99.3500" });
    expect(fieldOf(d, 2, "10")).toMatchObject({ status: "copied", value: "VN", note: 'From the customer parts list row 6 (part code "GPL-102").' });
    expect(listSources(fieldOf(d, 2, "10"))[0]).toMatchObject({ cell: "Parts!D6" });
    expect(header(d, "B10").value).toBe("VN");
  });

  it("line 3 is not in the list (the list has GPL 103 with a space), line 4 disagrees, line 5 agrees", () => {
    expect(fieldOf(d, 3, "33A").reason).toBe(
      `The HTS number of invoice line 3 was not read. Part code "GPL-103" of invoice line 3 is not in the customer parts list.${SUFFIX}`,
    );
    const f4 = fieldOf(d, 4, "33A");
    expect(f4).toMatchObject({ status: "needsReview", value: null });
    expect(f4.reason).toBe('Invoice line 4 gives HTS 6913.90.5000, and the customer parts list row 8 (part code "GPL-104") gives 6913.90.1000. A person picks the number.');
    expect(listSources(f4)[0]).toMatchObject({ cell: "Parts!C8" });
    expect(fieldOf(d, 4, "37A").reason).toBe("Waiting on L004.33A: the invoice and the customer parts list give different HTS numbers.");
    // The packing list quantity of GPL-104 agrees, so 35 waits on 33A
    expect(fieldOf(d, 4, "35").reason).toBe("Waiting on L004.33A: the invoice and the customer parts list give different HTS numbers.");
    const f5 = fieldOf(d, 5, "33A");
    expect(f5).toMatchObject({ status: "copied", value: "3926.40.0090" });
    expect(f5.note?.startsWith('The customer parts list row 9 (part code "GPL-105") gives the same number.')).toBe(true);
  });

  it("B13 lists the MIDs because line 3 has none", () => {
    const b13 = header(d, "B13");
    expect(b13.status).toBe("needsReview");
    expect(b13.reason).toBe(
      `${TODAY_B13} The customer parts list gives: invoice line 1 VNGLOPAP88THO; invoice line 2 VNGLOPAP88THO; invoice line 3 none; invoice line 4 VNGLOPAP88THO; invoice line 5 VNGLOPAP88THO. A person checks the manufacturer of each line.`,
    );
    expect(listSources(b13).map((s) => s.cell)).toEqual(["Parts!E5", "Parts!E6", "Parts!E8", "Parts!E9"]);
  });

  it("the CSV shows the list cells, and the CSV list gives the same values", () => {
    expect(draftToCsv(d)).toContain("(cell Parts!C5)");
    const dc = buildDraft({ bundle: "upload", reader: "recorded", readings: verified, hts, invoiceLineCount: 5, partsList: partsCsv });
    const pick = (x: Draft) => allFields(x).map((f) => [f.id, f.status, f.value]);
    expect(pick(dc)).toEqual(pick(d));
  });

  it("46.8 a person's number replaces the waiting one", () => {
    const o = buildDraft({
      bundle: "upload",
      reader: "recorded",
      readings: verified,
      hts,
      invoiceLineCount: 5,
      partsList: partsXlsx,
      overrides: [{ fieldId: "L004.33A", value: "6913.90.5000" }],
    });
    expect(fieldOf(o, 4, "33A")).toMatchObject({ status: "personEdited", value: "6913.90.5000" });
    expect(fieldOf(o, 4, "37A").value).not.toBeNull();
  });
});
