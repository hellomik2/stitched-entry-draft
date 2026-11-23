import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { readXlsx, readCsvSheet, sheetToPageText, cellAddress } from "./sheet";
import { normalizeSpace } from "./pdfText";

// Feature: document-intake, Requirement 45 (task 56.1): an Excel document is read with cell addresses.

const FILES = join(process.cwd(), "samples", "upload-test", "files");

type TCell = {
  ref: string;
  v: string | number | boolean;
  t?: "s" | "b" | "e" | "str";
  fmt?: string;
  numFmtId?: number;
  formula?: string;
  noValue?: boolean;
  rich?: boolean;
  rawV?: string;
};
type TSheet = {
  name: string;
  cells: TCell[];
  state?: "hidden" | "veryHidden";
  hiddenRows?: number[];
  hiddenCols?: number[];
  colWidths?: Record<number, number>;
  rowHeights?: Record<number, number>;
  pad?: number;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rowOf = (ref: string) => Number(ref.replace(/^[A-Z]+/, ""));
const colOf = (ref: string) => [...ref.replace(/\d+$/, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n: number) => {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A small .xlsx writer for the tests: inline or shared strings, number formats, hidden parts, extra zip entries. */
function buildXlsx(sheets: TSheet[], opts: { shared?: boolean; extra?: Record<string, string> } = {}): Uint8Array {
  const shared: string[] = [];
  const fmts: string[] = [];
  const xfs: number[] = [0];
  const styleOf = (c: TCell) => {
    let id = c.numFmtId;
    if (c.fmt !== undefined) {
      let i = fmts.indexOf(c.fmt);
      if (i < 0) {
        fmts.push(c.fmt);
        i = fmts.length - 1;
      }
      id = 164 + i;
    }
    if (!id) return 0;
    let s = xfs.indexOf(id);
    if (s < 0) {
      xfs.push(id);
      s = xfs.length - 1;
    }
    return s;
  };
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sh, i) => {
    const rows = new Map<number, string[]>();
    for (const c of sh.cells) {
      const s = styleOf(c);
      const sa = s ? ` s="${s}"` : "";
      let x: string;
      if (c.rawV !== undefined) x = `<c r="${c.ref}"${sa}><v>${c.rawV}</v></c>`;
      else if (c.formula !== undefined) {
        const t = c.t === "str" ? ' t="str"' : "";
        x = `<c r="${c.ref}"${sa}${t}><f>${esc(c.formula)}</f>${c.noValue ? "" : `<v>${esc(String(c.v))}</v>`}</c>`;
      } else if (c.t === "b") x = `<c r="${c.ref}" t="b"><v>${c.v ? 1 : 0}</v></c>`;
      else if (c.t === "e") x = `<c r="${c.ref}" t="e"><v>${esc(String(c.v))}</v></c>`;
      else if (typeof c.v === "string") {
        if (opts.shared || c.rich) {
          const si = c.rich
            ? `<si><r><t xml:space="preserve">${esc(c.v.slice(0, 3))}</t></r><r><rPr><b/></rPr><t xml:space="preserve">${esc(c.v.slice(3))}</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>`
            : `<si><t xml:space="preserve">${esc(c.v)}</t></si>`;
          shared.push(si);
          x = `<c r="${c.ref}"${sa} t="s"><v>${shared.length - 1}</v></c>`;
        } else x = `<c r="${c.ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
      } else x = `<c r="${c.ref}"${sa}><v>${c.v}</v></c>`;
      const r = rowOf(c.ref);
      if (!rows.has(r)) rows.set(r, []);
      rows.get(r)!.push(x);
    }
    const rowXml = [...rows.keys()]
      .sort((a, b) => a - b)
      .map((r) => {
        const ht = sh.rowHeights?.[r] ? ` ht="${sh.rowHeights[r]}" customHeight="1"` : "";
        const hid = sh.hiddenRows?.includes(r) ? ' hidden="1"' : "";
        return `<row r="${r}"${ht}${hid}>${rows.get(r)!.join("")}</row>`;
      })
      .join("");
    const colSet = [...new Set([...(sh.hiddenCols ?? []), ...Object.keys(sh.colWidths ?? {}).map(Number)])].sort((a, b) => a - b);
    const cols = colSet.length
      ? `<cols>${colSet
          .map((c) => `<col min="${c}" max="${c}" width="${sh.colWidths?.[c] ?? 8.43}" customWidth="1"${sh.hiddenCols?.includes(c) ? ' hidden="1"' : ""}/>`)
          .join("")}</cols>`
      : "";
    const pad = sh.pad ? " ".repeat(sh.pad) : "";
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowXml}</sheetData>${pad}</worksheet>`,
    );
  });
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS} xmlns:r="${REL}"><sheets>${sheets
      .map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}"${sh.state ? ` state="${sh.state}"` : ""} r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("")}<Relationship Id="rIdSt" Type="${REL}/styles" Target="styles.xml"/>${
      shared.length ? `<Relationship Id="rIdSs" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` : ""
    }</Relationships>`,
  );
  files["xl/styles.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${NS}><numFmts count="${fmts.length}">${fmts
      .map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`)
      .join("")}</numFmts><cellXfs count="${xfs.length}">${xfs
      .map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"${id ? ' applyNumberFormat="1"' : ""}/>`)
      .join("")}</cellXfs></styleSheet>`,
  );
  if (shared.length) {
    files["xl/sharedStrings.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst ${NS} count="${shared.length}" uniqueCount="${shared.length}">${shared.join("")}</sst>`,
    );
  }
  files["[Content_Types].xml"] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  for (const [k, v] of Object.entries(opts.extra ?? {})) files[k] = strToU8(v);
  return zipSync(files, { level: 6 });
}

/** Overwrite the uncompressed size that the zip headers claim for one entry (local header and central directory). */
function claimSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  const nameBytes = strToU8(name);
  const same = (at: number) => nameBytes.every((b, k) => out[at + k] === b);
  for (let p = 0; p + 46 < out.length; p++) {
    if (dv.getUint32(p, true) === 0x02014b50 && dv.getUint16(p + 28, true) === nameBytes.length && same(p + 46)) {
      dv.setUint32(p + 24, size, true);
      const local = dv.getUint32(p + 42, true);
      dv.setUint32(local + 22, size, true);
    }
  }
  return out;
}

const ok = <T,>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.value;
};
const textOf = (sheet: { cells: { ref: string; text: string }[] }, ref: string) => sheet.cells.find((c) => c.ref === ref)?.text;

describe("Requirement 45: readXlsx and sheetToPageText", () => {
  it("45.4, 45.5 reads the shipped Excel packing list (inline strings) with the texts a person sees and Excel cell addresses", () => {
    const bytes = new Uint8Array(readFileSync(join(FILES, "gloamwick-packing-list.xlsx")));
    const wb = ok(readXlsx(bytes, "gloamwick-packing-list.xlsx"));
    expect(wb.sheets.map((s) => s.name)).toEqual(["Packing List"]);
    const sh = wb.sheets[0];
    expect(textOf(sh, "B3")).toBe("GPL-PL-1131");
    expect(textOf(sh, "C8")).toBe("15");
    expect(textOf(sh, "D9")).toBe("1,200");
    expect(textOf(sh, "F8")).toBe("150.0");
    expect(textOf(sh, "G10")).toBe("46.5");
    expect(textOf(sh, "D13")).toBe("4,580");
    expect(textOf(sh, "G13")).toBe("437.4");
    expect(textOf(sh, "G1")).toBe("DEMO / FICTITIOUS");

    const page = sheetToPageText(sh, "packingList", 1);
    expect(page.origin).toBe("sheet");
    expect(page.page).toBe(1);
    const g13 = page.items.find((i) => i.cell === "'Packing List'!G13");
    expect(g13?.str).toBe("437.4");
    // Column widths 12, 32, 9, 9, 7, 12, 13 characters at 6 points each, 36 points for row numbers; rows of 15 points under 20 points of letters.
    expect(g13?.box).toEqual({ x: 522, y: 200, w: 78, h: 15 });
    expect(page.width).toBe(600);
    expect(page.height).toBe(245);
    expect(page.grid?.cols.map((c) => c.label)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(page.grid?.cols[1]).toEqual({ label: "B", x: 108, w: 192 });
    expect(page.grid?.rows.length).toBe(15);
    expect(page.grid?.rows[12]).toEqual({ label: "13", y: 200, h: 15 });
    expect(page.text).toContain("Packing List No.: GPL-PL-1131");
    expect(page.text).toContain("GPL-101 Glass lantern, non-electric 15 300 PCS 150.0 168.0");
    expect(page.text).toContain("TOTAL 44 4,580 PCS 388.0 437.4");
    // Items are in row then column order and their spans point into the text.
    expect(page.items[0].cell).toBe("'Packing List'!A1");
    expect(page.items[0].id).toBe("packingList:p1:i1");
    for (const sp of page.spans) {
      const item = page.items.find((i) => i.id === sp.itemId)!;
      expect(page.text.slice(sp.start, sp.end)).toBe(item.str);
    }
  });

  it("45.4 reads the shipped parts list written the Excel way (shared strings); a plain sheet name is not quoted", () => {
    const bytes = new Uint8Array(readFileSync(join(FILES, "gloamwick-customer-parts-list.xlsx")));
    const sh = ok(readXlsx(bytes, "gloamwick-customer-parts-list.xlsx")).sheets[0];
    expect(sh.name).toBe("Parts");
    expect(textOf(sh, "A7")).toBe("GPL 103");
    expect(textOf(sh, "C5")).toBe("9405.50.4000");
    expect(textOf(sh, "A1")).toBe("Customer parts list: Bramblecrypt Home & Party LLC");
    const page = sheetToPageText(sh, "partsList", 1);
    expect(page.items.find((i) => i.str === "9405.50.4000")?.cell).toBe("Parts!C5");
  });

  it("45.5 cellAddress quotes a sheet name that has anything other than letters, digits and _", () => {
    expect(cellAddress("Parts", "C5")).toBe("Parts!C5");
    expect(cellAddress("Sheet_1", "A1")).toBe("Sheet_1!A1");
    expect(cellAddress("Packing List", "G13")).toBe("'Packing List'!G13");
    expect(cellAddress("O'Brien-list", "B2")).toBe("'O''Brien-list'!B2");
  });

  it("45.4 number formats, dates, booleans, errors, formulas and rich text give the text a person sees", () => {
    const bytes = buildXlsx([
      {
        name: "Formats",
        cells: [
          { ref: "A1", v: 0, rawV: "132.30000000000001" },
          { ref: "A2", v: 1800, fmt: "#,##0" },
          { ref: "A3", v: 70, fmt: "0.0" },
          { ref: "A4", v: 1234.5, fmt: "#,##0.00" },
          { ref: "A5", v: 46344, numFmtId: 14 },
          { ref: "A6", v: 46344.75, fmt: "yyyy-mm-dd" },
          { ref: "A7", v: 0.25, fmt: "0.0%" },
          { ref: "A8", v: true, t: "b" },
          { ref: "A9", v: "#N/A", t: "e" },
          { ref: "A10", v: 44, fmt: "#,##0", formula: "SUM(C8:C12)" },
          { ref: "A11", v: 0, formula: "SUM(C8:C12)", noValue: true },
          { ref: "A12", v: 7, formula: "[1]Sheet1!A1" },
          { ref: "A13", v: "abc", t: "str", formula: "LOWER(\"ABC\")" },
          { ref: "A14", v: "Glass lantern", rich: true },
          { ref: "A15", v: -1234, numFmtId: 3 },
          { ref: "A16", v: 12, numFmtId: 1 },
          { ref: "A17", v: 3.14159, numFmtId: 2 },
        ],
      },
    ]);
    const sh = ok(readXlsx(bytes, "formats.xlsx")).sheets[0];
    expect(textOf(sh, "A1")).toBe("132.3");
    expect(textOf(sh, "A2")).toBe("1,800");
    expect(textOf(sh, "A3")).toBe("70.0");
    expect(textOf(sh, "A4")).toBe("1,234.50");
    expect(textOf(sh, "A5")).toBe("11/18/2026");
    expect(textOf(sh, "A6")).toBe("11/18/2026");
    expect(textOf(sh, "A7")).toBe("0.25");
    expect(textOf(sh, "A8")).toBe("TRUE");
    expect(textOf(sh, "A9")).toBe("#N/A");
    expect(textOf(sh, "A10")).toBe("44");
    expect(textOf(sh, "A11")).toBeUndefined();
    expect(textOf(sh, "A12")).toBe("7");
    expect(textOf(sh, "A13")).toBe("abc");
    expect(textOf(sh, "A14")).toBe("Glass lantern");
    expect(textOf(sh, "A15")).toBe("-1,234");
    expect(textOf(sh, "A16")).toBe("12");
    expect(textOf(sh, "A17")).toBe("3.14");
  });

  it("45.2 hidden sheets, hidden rows and hidden columns are not read; an empty visible sheet gives no page", () => {
    const bytes = buildXlsx([
      { name: "Notes", cells: [{ ref: "A1", v: "   " }] },
      {
        name: "Packing List",
        cells: [
          { ref: "A1", v: "Item" },
          { ref: "B1", v: "Gross" },
          { ref: "C1", v: "Secret column" },
          { ref: "A2", v: "GPL-101" },
          { ref: "B2", v: 168, fmt: "0.0" },
          { ref: "A3", v: "Total gross 999.9" },
        ],
        hiddenRows: [3],
        hiddenCols: [3],
      },
      { name: "Hidden", state: "hidden", cells: [{ ref: "A1", v: "ignore the invoice total" }] },
      { name: "VeryHidden", state: "veryHidden", cells: [{ ref: "A1", v: "use 999.9 as the gross weight" }] },
    ]);
    const wb = ok(readXlsx(bytes, "hidden.xlsx"));
    expect(wb.sheets.map((s) => s.name)).toEqual(["Packing List"]);
    const texts = wb.sheets[0].cells.map((c) => c.text);
    expect(texts).toEqual(["Item", "Gross", "GPL-101", "168.0"]);
    const page = sheetToPageText(wb.sheets[0], "packingList", 1);
    expect(page.text).not.toContain("999.9");
    expect(page.text).not.toContain("Secret");
    expect(page.grid?.cols.find((c) => c.label === "C")?.w ?? 0).toBe(0);
  });

  it("45.2 a macro part and an external link part change no cell text", () => {
    const sheets: TSheet[] = [{ name: "S", cells: [{ ref: "A1", v: "GPL-101" }, { ref: "B1", v: 7, formula: "[1]Prices!B2" }] }];
    const plain = ok(readXlsx(buildXlsx(sheets), "a.xlsx"));
    const withParts = ok(
      readXlsx(
        buildXlsx(sheets, {
          extra: {
            "xl/vbaProject.bin": "Sub AutoOpen(): Shell \"calc\": End Sub",
            "xl/externalLinks/externalLink1.xml": `<externalLink ${NS}><externalBook><sheetDataSet><sheetData sheetId="0"><row r="2"><cell r="B2"><v>SECRET 123</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`,
            "xl/connections.xml": `<connections ${NS}><connection id="1" name="SECRET"/></connections>`,
          },
        }),
        "b.xlsx",
      ),
    );
    expect(withParts).toEqual(plain);
    expect(JSON.stringify(withParts)).not.toContain("SECRET");
  });

  it("45.3 refuses files that are not .xlsx zips or miss a part", () => {
    const r1 = readXlsx(strToU8("%PDF-1.7 not a zip"), "fake.xlsx");
    expect(r1).toEqual({ ok: false, reason: "fake.xlsx: could not read the Excel file." });
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(readXlsx(ole, "old.xlsx")).toEqual({ ok: false, reason: "old.xlsx: could not read the Excel file." });
    const noWorkbook = zipSync({ "xl/worksheets/sheet1.xml": strToU8(`<worksheet ${NS}><sheetData/></worksheet>`) });
    expect(readXlsx(noWorkbook, "part.xlsx")).toEqual({ ok: false, reason: "part.xlsx: could not read the Excel file." });
  });

  it("45.3 refuses a workbook with no visible text and one with more than 4 visible sheets", () => {
    const empty = buildXlsx([{ name: "S", cells: [{ ref: "A1", v: "  " }] }, { name: "H", state: "hidden", cells: [{ ref: "A1", v: "text" }] }]);
    expect(readXlsx(empty, "e.xlsx")).toEqual({ ok: false, reason: "e.xlsx: the Excel file has no visible sheet with text." });
    const five = buildXlsx([1, 2, 3, 4, 5].map((n) => ({ name: `S${n}`, cells: [{ ref: "A1", v: `sheet ${n}` }] })));
    expect(readXlsx(five, "f.xlsx")).toEqual({ ok: false, reason: "f.xlsx: 5 visible sheets is over the 4 sheet limit." });
    const fourAndHidden = buildXlsx([
      ...[1, 2, 3, 4].map((n) => ({ name: `S${n}`, cells: [{ ref: "A1", v: `sheet ${n}` }] })),
      { name: "H", state: "hidden" as const, cells: [{ ref: "A1", v: "hidden" }] },
    ]);
    expect(ok(readXlsx(fourAndHidden, "g.xlsx")).sheets.length).toBe(4);
  });

  it("45.3 refuses a sheet over the cell, column, row or cell length limits", () => {
    const tooLarge = (name: string) => `x.xlsx: sheet "${name}" is too large (at most 5,000 cells with text, columns A to AZ, rows 1 to 1,000 and 1,000 characters in a cell).`;
    const many: TCell[] = [];
    for (let r = 1; r <= 101; r++) for (let c = 1; c <= 50; c++) many.push({ ref: `${colName(c)}${r}`, v: `${r}-${c}` });
    expect(readXlsx(buildXlsx([{ name: "Big", cells: many }]), "x.xlsx")).toEqual({ ok: false, reason: tooLarge("Big") });
    expect(readXlsx(buildXlsx([{ name: "Wide", cells: [{ ref: "BA1", v: "x" }] }]), "x.xlsx")).toEqual({ ok: false, reason: tooLarge("Wide") });
    expect(readXlsx(buildXlsx([{ name: "Long", cells: [{ ref: "A1001", v: "x" }] }]), "x.xlsx")).toEqual({ ok: false, reason: tooLarge("Long") });
    expect(readXlsx(buildXlsx([{ name: "Text", cells: [{ ref: "A1", v: "y".repeat(1001) }] }]), "x.xlsx")).toEqual({ ok: false, reason: tooLarge("Text") });
    // At the limits it reads.
    expect(ok(readXlsx(buildXlsx([{ name: "Edge", cells: [{ ref: "AZ1000", v: "y".repeat(1000) }] }]), "x.xlsx")).sheets[0].cells.length).toBe(1);
  });

  it("45.3 refuses a zip with more than 1,000 entries", () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) extra[`docProps/custom${i}.xml`] = "<x/>";
    const bytes = buildXlsx([{ name: "S", cells: [{ ref: "A1", v: "a" }] }], { extra });
    expect(readXlsx(bytes, "n.xlsx")).toEqual({ ok: false, reason: "n.xlsx: the Excel file unpacks to too much data; it may be damaged." });
  });
});

describe("Property 60: A Sheet Cell Keeps Its Text and Address (Validates: Requirements 45.2, 45.4, 45.5)", () => {
  const textArb = fc
    .array(fc.constantFrom(..."abcXYZ0129 .,-/()#:;&<>\"'".split("")), { minLength: 1, maxLength: 12 })
    .map((a) => a.join(""));
  const numArb = fc.record({ n: fc.integer({ min: -99999, max: 999999 }), fmt: fc.constantFrom("0", "0.0", "0.00", "#,##0", "#,##0.0", "#,##0.00") });
  const expectNum = (n: number, fmt: string) => {
    const dec = (fmt.split(".")[1] ?? "").length;
    return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: fmt.includes(",") });
  };

  it("any grid of texts and formatted numbers comes back cell by cell with its address, boxes that do not overlap and a page text that holds every cell", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.oneof(textArb, numArb)), { minLength: 1, maxLength: 60 }),
        fc.boolean(),
        fc.constantFrom("Packing List", "Sheet1", "Q&A <list>"),
        (rows, cols, raw, shared, name) => {
          const byRef = new Map<string, TCell>();
          for (const [r, c, v] of raw) {
            const ref = `${colName((c % cols) + 1)}${(r % rows) + 1}`;
            byRef.set(ref, typeof v === "string" ? { ref, v } : { ref, v: v.n, fmt: v.fmt });
          }
          const cells = [...byRef.values()];
          const wb = readXlsx(buildXlsx([{ name, cells }], { shared }), "p.xlsx");
          const expected = cells
            .map((c) => ({ ref: c.ref, text: typeof c.v === "string" ? c.v : expectNum(c.v as number, c.fmt!) }))
            .filter((c) => normalizeSpace(c.text) !== "")
            .sort((a, b) => rowOf(a.ref) - rowOf(b.ref) || colOf(a.ref) - colOf(b.ref));
          if (expected.length === 0) {
            expect(wb.ok).toBe(false);
            return;
          }
          if (!wb.ok) throw new Error(wb.reason);
          const page = sheetToPageText(wb.value.sheets[0], "packingList", 1);
          expect(page.items.map((i) => i.cell)).toEqual(expected.map((e) => cellAddress(name, e.ref)));
          expect(page.items.map((i) => i.str)).toEqual(expected.map((e) => normalizeSpace(e.text)));
          for (const item of page.items) expect(page.text).toContain(item.str);
          for (let a = 0; a < page.items.length; a++)
            for (let b = a + 1; b < page.items.length; b++) {
              const p = page.items[a].box;
              const q = page.items[b].box;
              const overlap = p.x < q.x + q.w - 0.01 && q.x < p.x + p.w - 0.01 && p.y < q.y + q.h - 0.01 && q.y < p.y + p.h - 0.01;
              expect(overlap).toBe(false);
            }
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("Property 61: A Hostile Workbook Is Refused Before It Is Unpacked (Validates: Requirements 45.2, 45.3)", () => {
  const TOO_MUCH = "h.xlsx: the Excel file unpacks to too much data; it may be damaged.";

  it("a part that inflates past 5,000,000 bytes is refused whether the zip header claims a small size or the true one", () => {
    fc.assert(
      fc.property(fc.integer({ min: 5_000_001, max: 6_500_000 }), fc.boolean(), (size, lie) => {
        let bytes = buildXlsx([{ name: "S", cells: [{ ref: "A1", v: "GPL-101" }], pad: size }]);
        if (lie) bytes = claimSize(bytes, "xl/worksheets/sheet1.xml", 400);
        expect(readXlsx(bytes, "h.xlsx")).toEqual({ ok: false, reason: TOO_MUCH });
      }),
      { numRuns: 4 },
    );
  });

  it("parts that each stay under 5,000,000 bytes but pass 20,000,000 together are refused", () => {
    // Four sheets of about 4.1 MB and a shared string table of about 4 MB: each part is under 5 MB, together over 20 MB.
    const sheets: TSheet[] = [1, 2, 3, 4].map((n) => ({ name: `S${n}`, cells: [{ ref: "A1", v: `s${n}` }], pad: 4_100_000 }));
    const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst ${NS} count="4" uniqueCount="4"><si><t>s1</t></si><si><t>s2</t></si><si><t>s3</t></si><si><t>s4</t></si>${" ".repeat(4_000_000)}</sst>`;
    const bytes = buildXlsx(sheets, { shared: true, extra: { "xl/sharedStrings.xml": sst } });
    expect(readXlsx(bytes, "h.xlsx")).toEqual({ ok: false, reason: TOO_MUCH });
    // Without the padding of the shared strings the same workbook reads.
    expect(ok(readXlsx(buildXlsx(sheets, { shared: true }), "h.xlsx")).sheets.length).toBe(4);
  });

  it("any count of cells or sheets over a limit gives the limit's reason and no cells", () => {
    fc.assert(
      fc.property(fc.integer({ min: 5, max: 7 }), (n) => {
        const r = readXlsx(buildXlsx(Array.from({ length: n }, (_, i) => ({ name: `S${i + 1}`, cells: [{ ref: "A1", v: "x" }] }))), "h.xlsx");
        expect(r).toEqual({ ok: false, reason: `h.xlsx: ${n} visible sheets is over the 4 sheet limit.` });
      }),
      { numRuns: 3 },
    );
  });
});

describe("Requirement 46.1 (shared with 45): readCsvSheet", () => {
  it("reads a CSV as one sheet named after the file, with Excel-style addresses, a byte order mark removed", () => {
    const sh = ok(readCsvSheet("\uFEFFPart No,HTS\r\nGPL-101,0901.21.00.20\r\n\"A, B\",x\r\n", "my parts.csv"));
    expect(sh.name).toBe("my parts");
    expect(sh.cells.map((c) => [c.ref, c.text])).toEqual([
      ["A1", "Part No"],
      ["B1", "HTS"],
      ["A2", "GPL-101"],
      ["B2", "0901.21.00.20"],
      ["A3", "A, B"],
      ["B3", "x"],
    ]);
    const page = sheetToPageText(sh, "partsList", 1);
    expect(page.items.find((i) => i.str === "0901.21.00.20")?.cell).toBe("'my parts'!B2");
  });

  it("refuses a CSV of more than 2,000 lines", () => {
    const text = Array.from({ length: 2001 }, (_, i) => `P-${i},9405.50.4000`).join("\n");
    const r = readCsvSheet(text, "big.csv");
    expect(r.ok).toBe(false);
  });
});
