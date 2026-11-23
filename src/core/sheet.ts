import { RuleResult } from "../rules/types";
import { PageText, Box, normalizeSpace } from "./pdfText";
import { parseCsv } from "./csv";
import { Inflate } from "fflate";

export type SheetCell = { ref: string; row: number; col: number; text: string };
export type Sheet = {
  name: string;
  cells: SheetCell[];
  colWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  defaultColWidth: number;
  defaultRowHeight: number;
};
export type Workbook = { sheets: Sheet[] };
export type SheetLimits = {
  maxEntries: number;
  maxPartBytes: number;
  maxTotalBytes: number;
  maxSheets: number;
  maxCells: number;
  maxCol: number;
  maxRow: number;
  maxCellChars: number;
};

export const SHEET_LIMITS: SheetLimits = {
  maxEntries: 1000,
  maxPartBytes: 5_000_000,
  maxTotalBytes: 20_000_000,
  maxSheets: 4,
  maxCells: 5000,
  maxCol: 52,
  maxRow: 1000,
  maxCellChars: 1000,
};

export const PARTS_LIST_LIMITS: SheetLimits = {
  ...SHEET_LIMITS,
  maxCells: 20_000,
  maxRow: 2000,
};

export function columnName(n: number): string {
  if (n < 1) return "";
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function cellAddress(sheetName: string, ref: string): string {
  const needsQuote = !/^[A-Za-z0-9_]+$/.test(sheetName);
  if (needsQuote) {
    const escaped = sheetName.replace(/'/g, "''");
    return `'${escaped}'!${ref}`;
  }
  return `${sheetName}!${ref}`;
}

// Helper: decode HTML entities and character references
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// Helper: extract text from XML tag content
function getXmlTagContent(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1]);
  }
  return results;
}

// Helper: get attribute value
function getXmlAttr(xml: string, attr: string): string | null {
  const regex = new RegExp(`${attr}="([^"]*)"`, "i");
  const match = xml.match(regex);
  return match ? decodeXmlEntities(match[1]) : null;
}

// Helper: extract all attributes from an XML tag
function attrsOf(tag: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let a;
  while ((a = re.exec(tag)) !== null) m.set(a[1], decodeXmlEntities(a[2]));
  return m;
}

// Helper: a number with a fixed count of decimals, with a comma every three digits in the integer part when grouping
function formatNumber(n: number, decimals: number, grouping: boolean): string {
  const fixed = Math.abs(n).toFixed(decimals);
  const [intPart, fracPart] = fixed.split(".");
  const grouped = grouping ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : intPart;
  const sign = n < 0 && Number(fixed) !== 0 ? "-" : "";
  return sign + grouped + (fracPart !== undefined ? "." + fracPart : "");
}

// Helper: "0", "0.0...", "#,##0", "#,##0.0..." give their decimals and whether they group thousands
function matchesNumberFormat(code: string): { decimals: number; grouping: boolean } | null {
  const match = code.match(/^(#,##0|0)(\.0+)?$/);
  if (!match) return null;
  return { decimals: match[2] ? match[2].length - 1 : 0, grouping: match[1] === "#,##0" };
}

// Helper: check if a format code is a date format
function isDateFormat(numFmtId: number, code: string): boolean {
  if (numFmtId >= 14 && numFmtId <= 22) return true;
  // Remove quoted parts, [parts], and \x escapes
  const simplified = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\x/g, "");
  // Check if it contains d, m, or y (any case) but not 0 or #
  const hasDateChars = /[dmy]/i.test(simplified);
  const hasNumberChars = /[0#]/.test(simplified);
  return hasDateChars && !hasNumberChars;
}

export function readXlsx(bytes: Uint8Array, fileName: string, limits: SheetLimits = SHEET_LIMITS): RuleResult<Workbook> {
  try {
    // Step 1: Find end-of-central-directory record
    const data = bytes;
    if (data.length < 22) {
      return { ok: false, reason: `${fileName}: could not read the Excel file.` };
    }

    let eocdOffset = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
      if (
        data[i] === 0x50 &&
        data[i + 1] === 0x4b &&
        data[i + 2] === 0x05 &&
        data[i + 3] === 0x06
      ) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      return { ok: false, reason: `${fileName}: could not read the Excel file.` };
    }

    const dv = new DataView(data.buffer, data.byteOffset);
    const entryCount = dv.getUint16(eocdOffset + 10, true);
    const cdOffset = dv.getUint32(eocdOffset + 16, true);

    if (entryCount === 0xffff || cdOffset === 0xffffffff) {
      return { ok: false, reason: `${fileName}: could not read the Excel file.` };
    }

    if (entryCount > limits.maxEntries) {
      return { ok: false, reason: `${fileName}: the Excel file unpacks to too much data; it may be damaged.` };
    }

    // Step 2: the zip directory (entries have variable length); a part is inflated only when it is asked for
    type ZipEntry = { flags: number; method: number; compressedSize: number; localOffset: number };
    const entries = new Map<string, ZipEntry>();
    let cd = cdOffset;
    for (let i = 0; i < entryCount; i++) {
      if (cd + 46 > data.length || dv.getUint32(cd, true) !== 0x02014b50) {
        return { ok: false, reason: `${fileName}: could not read the Excel file.` };
      }
      const nameLength = dv.getUint16(cd + 28, true);
      const extraLength = dv.getUint16(cd + 30, true);
      const commentLength = dv.getUint16(cd + 32, true);
      const name = new TextDecoder("utf-8").decode(data.subarray(cd + 46, cd + 46 + nameLength));
      entries.set(name, {
        flags: dv.getUint16(cd + 8, true),
        method: dv.getUint16(cd + 10, true),
        compressedSize: dv.getUint32(cd + 20, true),
        localOffset: dv.getUint32(cd + 42, true),
      });
      cd += 46 + nameLength + extraLength + commentLength;
    }

    let totalBytes = 0;
    const cache = new Map<string, Uint8Array>();
    const readPart = (name: string): Uint8Array | undefined => {
      const cached = cache.get(name);
      if (cached) return cached;
      const e = entries.get(name);
      if (!e) return undefined;
      if ((e.flags & 1) !== 0 || (e.method !== 0 && e.method !== 8)) throw new Error("UNREADABLE");
      const lh = e.localOffset;
      if (lh + 30 > data.length || dv.getUint32(lh, true) !== 0x04034b50) throw new Error("UNREADABLE");
      const dataStart = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
      if (dataStart + e.compressedSize > data.length) throw new Error("UNREADABLE");
      const compressed = data.subarray(dataStart, dataStart + e.compressedSize);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const take = (chunk: Uint8Array) => {
        size += chunk.length;
        totalBytes += chunk.length;
        if (size > limits.maxPartBytes || totalBytes > limits.maxTotalBytes) throw new Error("PART_TOO_LARGE");
        chunks.push(chunk.slice());
      };
      if (e.method === 0) {
        take(compressed);
      } else {
        const inflate = new Inflate((chunk) => take(chunk));
        for (let j = 0; j < compressed.length; j += 4096) {
          inflate.push(compressed.subarray(j, Math.min(j + 4096, compressed.length)));
        }
        inflate.push(new Uint8Array(0), true);
      }
      const out = new Uint8Array(size);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      cache.set(name, out);
      return out;
    };
    const parts = { get: readPart };

    // Step 3: Read and parse workbook.xml
    const workbookXml = parts.get("xl/workbook.xml");
    if (!workbookXml) {
      return { ok: false, reason: `${fileName}: could not read the Excel file.` };
    }

    const workbookText = new TextDecoder("utf-8").decode(workbookXml);

    // Step 4: Read relationships
    const relsXml = parts.get("xl/_rels/workbook.xml.rels");
    if (!relsXml) {
      return { ok: false, reason: `${fileName}: could not read the Excel file.` };
    }

    const relsText = new TextDecoder("utf-8").decode(relsXml);
    const rels = new Map<string, string>();

    let sharedStringsPath = "xl/sharedStrings.xml";
    let stylesPath = "xl/styles.xml";
    for (const tag of relsText.match(/<Relationship\b[^>]*>/g) ?? []) {
      const a = attrsOf(tag);
      const id = a.get("Id");
      const type = a.get("Type") ?? "";
      const target = a.get("Target");
      if (!id || !target) continue;
      const path = target.startsWith("/") ? target.substring(1) : "xl/" + target;
      if (type.endsWith("/worksheet")) rels.set(id, path);
      else if (type.endsWith("/sharedStrings")) sharedStringsPath = path;
      else if (type.endsWith("/styles")) stylesPath = path;
    }

    // Parse sheets
    const visibleSheets: Array<{ name: string; id: string }> = [];
    for (const tag of workbookText.match(/<sheet\b[^>]*>/g) ?? []) {
      const a = attrsOf(tag);
      const state = a.get("state");
      const name = a.get("name");
      const id = a.get("r:id");
      if (!name || !id) throw new Error("UNREADABLE");
      if (state !== "hidden" && state !== "veryHidden") visibleSheets.push({ name, id });
    }

    if (visibleSheets.length > limits.maxSheets) {
      return {
        ok: false,
        reason: `${fileName}: ${visibleSheets.length} visible sheets is over the ${limits.maxSheets} sheet limit.`,
      };
    }

    // Read shared strings
    const sharedStringsXml = parts.get(sharedStringsPath);
    const sharedStrings: string[] = [];
    if (sharedStringsXml) {
      const ssText = new TextDecoder("utf-8").decode(sharedStringsXml);
      const siTexts = getXmlTagContent(ssText, "si");
      for (const siText of siTexts) {
        // Remove rPh elements
        const cleaned = siText.replace(/<rPh[^>]*>.*?<\/rPh>/gs, "");
        const tContents = getXmlTagContent(cleaned, "t");
        const str = tContents.map((t) => decodeXmlEntities(t)).join("");
        sharedStrings.push(str);
      }
    }

    // Read styles
    const stylesXml = parts.get(stylesPath);
    const numFmtMap: Map<number, string> = new Map();
    const xfList: Array<{ numFmtId: number }> = [];

    if (stylesXml) {
      const stylesText = new TextDecoder("utf-8").decode(stylesXml);

      // Parse custom number formats
      for (const tag of stylesText.match(/<numFmt\b[^>]*>/g) ?? []) {
        const a = attrsOf(tag);
        const idStr = a.get("numFmtId");
        const code = a.get("formatCode");
        if (!idStr || !code) continue;
        const id = parseInt(idStr, 10);
        numFmtMap.set(id, code);
      }

      // Parse cell formats
      const cellXfsRegex = /<cellXfs[^>]*>(.*?)<\/cellXfs>/s;
      const cellXfsMatch = stylesText.match(cellXfsRegex);
      if (cellXfsMatch) {
        // <xf .../> is usually self-closing; take every opening or self-closing xf tag in order
        for (const xfTag of cellXfsMatch[1].match(/<xf\b[^>]*>/g) ?? []) {
          const a = attrsOf(xfTag);
          const numFmtIdStr = a.get("numFmtId");
          const numFmtId = numFmtIdStr ? parseInt(numFmtIdStr, 10) : 0;
          xfList.push({ numFmtId });
        }
      }
    }

    // Helper: format cell value based on type and number format
    function formatCellValue(value: string, cellType: string | null, styleIndex: number): string {
      if (cellType === "s") {
        return sharedStrings[parseInt(value, 10)] ?? "";
      } else if (cellType === "b") {
        return value === "1" ? "TRUE" : "FALSE";
      } else if (cellType === "e") {
        return value;
      } else if (cellType === "inlineStr" || cellType === "str") {
        return value;
      } else {
        // Number with optional format
        const numValue = parseFloat(value);
        if (!isFinite(numValue)) {
          return value;
        }

        const xf = xfList[styleIndex];
        const numFmtId = xf?.numFmtId ?? 0;

        // Check if date format
        const code = numFmtMap.get(numFmtId);
        if (isDateFormat(numFmtId, code ?? "")) {
          // Convert Excel serial date to MM/DD/YYYY
          const wholeValue = Math.floor(numValue);
          const base = wholeValue >= 61 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
          const d = new Date(base + wholeValue * 86_400_000);
          return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
        }

        // Number formats made only of 0, 0.0..., #,##0, #,##0.0... (custom code, or built-in 1 to 4)
        const builtIn: Record<number, string> = { 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00" };
        const fmt = matchesNumberFormat(code ?? builtIn[numFmtId] ?? "");
        if (fmt) {
          return formatNumber(numValue, fmt.decimals, fmt.grouping);
        }

        // General format
        return String(parseFloat(numValue.toPrecision(15)));
      }
    }

    // Read sheets
    const sheets: Sheet[] = [];
    for (const visibleSheet of visibleSheets) {
      const sheetXmlPath = rels.get(visibleSheet.id);
      if (!sheetXmlPath) {
        return { ok: false, reason: `${fileName}: could not read the Excel file.` };
      }

      const sheetXml = parts.get(sheetXmlPath);
      if (!sheetXml) {
        return { ok: false, reason: `${fileName}: could not read the Excel file.` };
      }

      const sheetText = new TextDecoder("utf-8").decode(sheetXml);

      // Parse sheet format properties
      let defaultColWidth = 8.43;
      let defaultRowHeight = 15;
      for (const tag of sheetText.match(/<sheetFormatPr\b[^>]*>/g) ?? []) {
        const a = attrsOf(tag);
        const dcw = a.get("defaultColWidth");
        if (dcw) defaultColWidth = parseFloat(dcw);
        const drh = a.get("defaultRowHeight");
        if (drh) defaultRowHeight = parseFloat(drh);
      }

      // Parse column widths
      const colWidths: Record<number, number> = {};
      for (const tag of sheetText.match(/<col\b[^>]*>/g) ?? []) {
        const a = attrsOf(tag);
        const minStr = a.get("min");
        const maxStr = a.get("max");
        const widthStr = a.get("width");
        const hiddenStr = a.get("hidden");
        if (!minStr || !maxStr || !widthStr) continue;
        const min = parseInt(minStr, 10);
        const max = Math.min(parseInt(maxStr, 10), limits.maxCol);
        const width = parseFloat(widthStr);
        const hidden = hiddenStr === "1" || hiddenStr === "true";
        for (let c = min; c <= max; c++) {
          colWidths[c] = hidden ? 0 : width;
        }
      }

      // Parse row heights
      const rowHeights: Record<number, number> = {};
      for (const tag of sheetText.match(/<row\b[^>]*>/g) ?? []) {
        const a = attrsOf(tag);
        const rStr = a.get("r");
        const htStr = a.get("ht");
        const hiddenStr = a.get("hidden");
        if (!rStr) continue;
        const r = parseInt(rStr, 10);
        const ht = htStr ? parseFloat(htStr) : defaultRowHeight;
        const hidden = hiddenStr === "1" || hiddenStr === "true";
        rowHeights[r] = hidden ? 0 : ht;
      }

      // Build set of hidden rows and cols
      const hiddenRows = new Set<number>();
      const hiddenCols = new Set<number>();
      for (const [r, h] of Object.entries(rowHeights)) {
        if (h === 0) hiddenRows.add(parseInt(r, 10));
      }
      for (const [c, w] of Object.entries(colWidths)) {
        if (w === 0) hiddenCols.add(parseInt(c, 10));
      }

      // Parse cells
      const cells: SheetCell[] = [];
      // A cell is <c .../> (no content) or <c ...>content</c>
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(sheetText)) !== null) {
        const a = attrsOf(cellMatch[1]);
        const ref = a.get("r");
        const styleStr = a.get("s");
        const type = a.get("t");
        if (!ref) continue;
        
        const content = cellMatch[2] ?? "";

        // Parse row and col from ref
        const refMatch = ref.match(/^([A-Z]+)(\d+)$/);
        if (!refMatch) continue;

        const colStr = refMatch[1];
        const row = parseInt(refMatch[2], 10);

        // Calculate column number
        let col = 0;
        for (const ch of colStr) {
          col = col * 26 + (ch.charCodeAt(0) - 64);
        }

        if (hiddenRows.has(row) || hiddenCols.has(col)) continue;

        // Get cell text
        let text = "";
        const styleIndex = styleStr ? parseInt(styleStr, 10) : 0;

        const valueMatch = content.match(/<v(?:\s[^>]*)?>([^<]*)<\/v>/);
        if (valueMatch) {
          const value = decodeXmlEntities(valueMatch[1]);
          text = formatCellValue(value, type ?? null, styleIndex);
        } else {
          // Try inline string
          const isMatch = content.match(/<is>([\s\S]*?)<\/is>/);
          if (isMatch) {
            text = getXmlTagContent(isMatch[1], "t")
              .map((t) => decodeXmlEntities(t))
              .join("");
          }
        }

        // Filter out empty cells
        if (normalizeSpace(text) === "") continue;

        // Check cell length
        if (text.length > limits.maxCellChars) {
          return {
            ok: false,
            reason: `${fileName}: sheet "${visibleSheet.name}" is too large (at most ${limits.maxCells.toLocaleString("en-US")} cells with text, columns A to ${columnName(limits.maxCol)}, rows 1 to ${limits.maxRow.toLocaleString("en-US")} and ${limits.maxCellChars.toLocaleString("en-US")} characters in a cell).`,
          };
        }

        if (col > limits.maxCol || row > limits.maxRow) {
          return {
            ok: false,
            reason: `${fileName}: sheet "${visibleSheet.name}" is too large (at most ${limits.maxCells.toLocaleString("en-US")} cells with text, columns A to ${columnName(limits.maxCol)}, rows 1 to ${limits.maxRow.toLocaleString("en-US")} and ${limits.maxCellChars.toLocaleString("en-US")} characters in a cell).`,
          };
        }

        cells.push({ ref, row, col, text });
      }

      // Check cell limits
      if (cells.length > limits.maxCells) {
        return {
          ok: false,
          reason: `${fileName}: sheet "${visibleSheet.name}" is too large (at most ${limits.maxCells.toLocaleString("en-US")} cells with text, columns A to ${columnName(limits.maxCol)}, rows 1 to ${limits.maxRow.toLocaleString("en-US")} and ${limits.maxCellChars.toLocaleString("en-US")} characters in a cell).`,
        };
      }

      // Check column/row bounds
      for (const cell of cells) {
        if (cell.col > limits.maxCol || cell.row > limits.maxRow) {
          return {
            ok: false,
            reason: `${fileName}: sheet "${visibleSheet.name}" is too large (at most ${limits.maxCells.toLocaleString("en-US")} cells with text, columns A to ${columnName(limits.maxCol)}, rows 1 to ${limits.maxRow.toLocaleString("en-US")} and ${limits.maxCellChars.toLocaleString("en-US")} characters in a cell).`,
          };
        }
      }

      if (cells.length > 0) {
        // Sort cells by row then column
        cells.sort((a, b) => a.row - b.row || a.col - b.col);

        sheets.push({
          name: visibleSheet.name,
          cells,
          colWidths,
          rowHeights,
          defaultColWidth,
          defaultRowHeight,
        });
      }
    }

    if (sheets.length === 0) {
      return { ok: false, reason: `${fileName}: the Excel file has no visible sheet with text.` };
    }

    return { ok: true, value: { sheets } };
  } catch (e) {
    if (e instanceof Error && e.message === "PART_TOO_LARGE") {
      return { ok: false, reason: `${fileName}: the Excel file unpacks to too much data; it may be damaged.` };
    }
    return { ok: false, reason: `${fileName}: could not read the Excel file.` };
  }
}

export function readCsvSheet(text: string, fileName: string, limits: SheetLimits = PARTS_LIST_LIMITS): RuleResult<Sheet> {
  try {
    // Remove leading U+FEFF
    let csv = text;
    if (csv.charCodeAt(0) === 0xfeff) {
      csv = csv.substring(1);
    }

    // Parse CSV
    const rows = parseCsv(csv);

    // Drop last empty line if present
    if (rows.length > 0 && rows[rows.length - 1].every((cell) => normalizeSpace(cell) === "")) {
      rows.pop();
    }

    // Check row limit
    if (rows.length > 2000) {
      return { ok: false, reason: `${fileName}: the list has more than 2,000 lines.` };
    }

    // Build cells
    const cells: SheetCell[] = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        const text = row[c];
        if (normalizeSpace(text) === "") continue;

        const ref = columnName(c + 1) + (r + 1);
        cells.push({ ref, row: r + 1, col: c + 1, text });
      }
    }

    // Check cell limits
    if (cells.length > limits.maxCells) {
      return {
        ok: false,
        reason: `${fileName}: sheet "${fileName.replace(/\.[^.]*$/, "")}" is too large (at most ${limits.maxCells.toLocaleString("en-US")} cells with text, columns A to ${columnName(limits.maxCol)}, rows 1 to ${limits.maxRow.toLocaleString("en-US")} and ${limits.maxCellChars.toLocaleString("en-US")} characters in a cell).`,
      };
    }

    // Check column/row bounds
    for (const cell of cells) {
      if (cell.col > limits.maxCol || cell.row > limits.maxRow || cell.text.length > limits.maxCellChars) {
        return {
          ok: false,
          reason: `${fileName}: sheet "${fileName.replace(/\.[^.]*$/, "")}" is too large (at most ${limits.maxCells.toLocaleString("en-US")} cells with text, columns A to ${columnName(limits.maxCol)}, rows 1 to ${limits.maxRow.toLocaleString("en-US")} and ${limits.maxCellChars.toLocaleString("en-US")} characters in a cell).`,
        };
      }
    }

    if (cells.length === 0) {
      return { ok: false, reason: `${fileName}: the Excel file has no visible sheet with text.` };
    }

    const sheetName = fileName.replace(/\.[^.]*$/, "");
    return {
      ok: true,
      value: {
        name: sheetName,
        cells,
        colWidths: {},
        rowHeights: {},
        defaultColWidth: 8.43,
        defaultRowHeight: 15,
      },
    };
  } catch (e) {
    return { ok: false, reason: `${fileName}: could not read the Excel file.` };
  }
}

export function sheetToPageText(sheet: Sheet, docId: string, page: number): PageText {
  // Find max col and row
  let maxCol = 0;
  let maxRow = 0;
  for (const cell of sheet.cells) {
    maxCol = Math.max(maxCol, cell.col);
    maxRow = Math.max(maxRow, cell.row);
  }

  // Calculate column positions
  const colPositions: Array<{ x: number; w: number }> = [];
  let xPos = 36;
  for (let c = 1; c <= maxCol; c++) {
    const width = (sheet.colWidths[c] ?? sheet.defaultColWidth) * 6;
    colPositions.push({ x: Math.round(xPos * 100) / 100, w: Math.round(width * 100) / 100 });
    xPos += width;
  }

  // Calculate row positions
  const rowPositions: Array<{ y: number; h: number }> = [];
  let yPos = 20;
  for (let r = 1; r <= maxRow; r++) {
    const height = sheet.rowHeights[r] ?? sheet.defaultRowHeight;
    rowPositions.push({ y: Math.round(yPos * 100) / 100, h: Math.round(height * 100) / 100 });
    yPos += height;
  }

  // Build grid
  const cols = [];
  for (let c = 1; c <= maxCol; c++) {
    const pos = colPositions[c - 1];
    cols.push({ label: columnName(c), x: pos.x, w: pos.w });
  }

  const rows = [];
  for (let r = 1; r <= maxRow; r++) {
    const pos = rowPositions[r - 1];
    rows.push({ label: String(r), y: pos.y, h: pos.h });
  }

  const width = Math.round((36 + colPositions.reduce((s, p) => s + p.w, 0)) * 100) / 100;
  const height = Math.round((20 + rowPositions.reduce((s, p) => s + p.h, 0)) * 100) / 100;

  // Build items and text
  const items = [];
  let itemIndex = 1;

  for (const cell of sheet.cells) {
    const colPos = colPositions[cell.col - 1];
    const rowPos = rowPositions[cell.row - 1];

    items.push({
      id: `${docId}:p${page}:i${itemIndex}`,
      str: normalizeSpace(cell.text),
      box: { x: colPos.x, y: rowPos.y, w: colPos.w, h: rowPos.h },
      cell: cellAddress(sheet.name, cell.ref),
    });

    itemIndex++;
  }

  // Build text and spans
  const textParts: string[] = [];
  const spans = [];

  for (const item of items) {
    const start = textParts.join(" ").length + (textParts.length > 0 ? 1 : 0);
    textParts.push(item.str);
    const end = start + item.str.length;
    spans.push({ itemId: item.id, start, end });
  }

  const text = textParts.join(" ");

  return {
    page,
    width,
    height,
    items,
    text,
    spans,
    origin: "sheet" as const,
    grid: { cols, rows },
  };
}
