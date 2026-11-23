import { type Box, type PageText, normalizeSpace } from "./pdfText";
import type { RuleResult } from "../rules/types";
import type { DocSource } from "./draft";   // type-only import (no cycle at run time)
import { normalizeHts } from "./hts";
import { countryCode } from "./parse";
import { type Sheet, cellAddress, sheetToPageText } from "./sheet";

export type PartsListCell = { cell: string; text: string; box: Box };
export type PartsListRow = {
  row: number;
  partNo: PartsListCell;
  description: PartsListCell | null;
  hts: PartsListCell | null;
  origin: PartsListCell | null;
  mid: PartsListCell | null;
};
export type PartsList = { docId: "partsList"; sheetName: string; page: PageText; rows: PartsListRow[] };

export const PARTS_LIST_HEADER_REASON =
  "No header row with a part code column and an HTS column in the first 20 rows. Use the template's column names: Part No, Description, HTS, Origin, MID.";

/**
 * Normalize a header cell name: lowercase, collapse spaces, trim, remove one trailing colon.
 */
function normalizeHeaderName(text: string): string {
  let normalized = text.toLowerCase().trim();
  // Collapse multiple spaces into one
  normalized = normalized.replace(/\s+/g, " ");
  // Remove one trailing colon
  if (normalized.endsWith(":")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Check if a header cell matches one of the expected names.
 */
function matchesHeader(cellText: string, expectedNames: string[]): boolean {
  const normalized = normalizeHeaderName(cellText);
  return expectedNames.includes(normalized);
}

/**
 * Read a parts list from a sheet. The header row must be in the first 20 rows and
 * must have both a partNo column and an hts column.
 */
export function readPartsList(sheet: Sheet): RuleResult<PartsList> {
  const page = sheetToPageText(sheet, "partsList", 1);
  
  // Header name patterns for each column
  const partNoNames = ["part no", "part no.", "part number", "part code", "item code", "item no", "item no.", "item number", "product code", "product number", "sku"];
  const descriptionNames = ["description", "item description", "product description"];
  const htsNames = ["hts", "hts code", "hts number", "hts no", "hts no.", "us hts code", "htsus", "tariff number"];
  const originNames = ["origin", "country of origin", "origin country", "coo"];
  const midNames = ["mid", "manufacturer id", "mid code"];

  // Find the header row in the first 20 rows
  let headerRow: number | null = null;
  let partNoCol: number | null = null;
  let descriptionCol: number | null = null;
  let htsCol: number | null = null;
  let originCol: number | null = null;
  let midCol: number | null = null;

  for (let r = 1; r <= 20; r++) {
    // Get all cells in this row
    const rowCells = sheet.cells.filter((c) => c.row === r);
    if (rowCells.length === 0) continue;

    // Sort by column to get left-to-right order
    rowCells.sort((a, b) => a.col - b.col);

    // Find columns matching our headers (take the first match for each)
    let tempPartNoCol: number | null = null;
    let tempHtsCol: number | null = null;
    let tempDescriptionCol: number | null = null;
    let tempOriginCol: number | null = null;
    let tempMidCol: number | null = null;

    for (const cell of rowCells) {
      if (tempPartNoCol === null && matchesHeader(cell.text, partNoNames)) {
        tempPartNoCol = cell.col;
      }
      if (tempDescriptionCol === null && matchesHeader(cell.text, descriptionNames)) {
        tempDescriptionCol = cell.col;
      }
      if (tempHtsCol === null && matchesHeader(cell.text, htsNames)) {
        tempHtsCol = cell.col;
      }
      if (tempOriginCol === null && matchesHeader(cell.text, originNames)) {
        tempOriginCol = cell.col;
      }
      if (tempMidCol === null && matchesHeader(cell.text, midNames)) {
        tempMidCol = cell.col;
      }
    }

    // If we found both partNo and hts columns, this is the header row
    if (tempPartNoCol !== null && tempHtsCol !== null) {
      headerRow = r;
      partNoCol = tempPartNoCol;
      htsCol = tempHtsCol;
      descriptionCol = tempDescriptionCol;
      originCol = tempOriginCol;
      midCol = tempMidCol;
      break;
    }
  }

  if (headerRow === null || partNoCol === null || htsCol === null) {
    return { ok: false, reason: PARTS_LIST_HEADER_REASON };
  }

  // Read rows after the header
  const rows: PartsListRow[] = [];
  const dataRows = sheet.cells.filter((c) => c.row > headerRow);

  // Group by row number to process each row
  const rowNumbers = new Set<number>();
  for (const cell of dataRows) {
    rowNumbers.add(cell.row);
  }

  for (const rowNum of Array.from(rowNumbers).sort((a, b) => a - b)) {
    const rowCells = dataRows.filter((c) => c.row === rowNum);

    // Get the part number cell
    const partNoCell = rowCells.find((c) => c.col === partNoCol);
    if (!partNoCell || !partNoCell.text.trim()) {
      // Skip rows without a part number
      continue;
    }

    // Find the page item for each cell to get its box
    const getBox = (ref: string): Box => {
      const item = page.items.find((i) => i.cell === ref);
      return item ? item.box : { x: 0, y: 0, w: 0, h: 0 };
    };

    const makeCell = (col: number | null): PartsListCell | null => {
      if (col === null) return null;
      const cell = rowCells.find((c) => c.col === col);
      if (!cell || !cell.text.trim()) return null;
      const ref = cellAddress(sheet.name, cell.ref);
      return { cell: ref, text: cell.text, box: getBox(ref) };
    };

    const partNoRef = cellAddress(sheet.name, partNoCell.ref);
    const row: PartsListRow = {
      row: rowNum,
      partNo: { cell: partNoRef, text: partNoCell.text, box: getBox(partNoRef) },
      description: makeCell(descriptionCol),
      hts: makeCell(htsCol),
      origin: makeCell(originCol),
      mid: makeCell(midCol),
    };

    rows.push(row);
  }

  return {
    ok: true,
    value: { docId: "partsList", sheetName: sheet.name, page, rows },
  };
}

/**
 * Create a DocSource from a parts list row cell.
 */
export function partsListSource(row: PartsListRow, column: "partNo" | "hts" | "origin" | "mid"): DocSource {
  const cell = row[column];
  if (!cell) {
    throw new Error(`No cell for column ${column} in row ${row.row}`);
  }
  return {
    kind: "document",
    doc: "partsList",
    page: 1,
    quote: normalizeSpace(cell.text),
    box: cell.box,
    readingField: `partsList.rows.${row.row}.${column}`,
    cell: cell.cell,
  };
}

/**
 * Information about an invoice line found in the parts list.
 */
export type LineParts = {
  code: string | null;
  rows: PartsListRow[];
  hts:
    | { kind: "none"; sentence: string | null }
    | { kind: "list"; entry: string; source: DocSource; note: string }
    | { kind: "same"; source: DocSource; note: string }
    | { kind: "differs"; source: DocSource; reason: string };
  origin:
    | { kind: "none" }
    | { kind: "list"; code: string; source: DocSource; note: string }
    | { kind: "same"; source: DocSource; note: string }
    | { kind: "differs"; source: DocSource; reason: string };
  mid: { value: string; source: DocSource } | null;
};

/**
 * Find the parts list row(s) for an invoice line and extract HTS, origin, and MID.
 *
 * @param list The parts list
 * @param n The invoice line number (1-based)
 * @param code The accepted item number (normalized) or null
 * @param invoiceHts The accepted invoice HTS text (normalized) or null
 * @param invoiceOriginAccepted Whether the invoice origin has an accepted reading
 * @param invoiceOriginCode The country code of the invoice origin, or null
 */
export function linePartsInfo(
  list: PartsList,
  n: number,
  code: string | null,
  invoiceHts: string | null,
  invoiceOriginAccepted: boolean,
  invoiceOriginCode: string | null,
): LineParts {
  // Case 1: no code
  if (code === null) {
    return {
      code: null,
      rows: [],
      hts: { kind: "none", sentence: null },
      origin: { kind: "none" },
      mid: null,
    };
  }

  // Find matching rows (exact match, no case folding)
  const matchingRows = list.rows.filter((r) => r.partNo.text.trim() === code);

  // Case 3: no matching rows
  if (matchingRows.length === 0) {
    return {
      code,
      rows: [],
      hts: {
        kind: "none",
        sentence: `Part code "${code}" of invoice line ${n} is not in the customer parts list.`,
      },
      origin: { kind: "none" },
      mid: null,
    };
  }

  // Case 4: multiple matching rows
  if (matchingRows.length > 1) {
    const rowNumbers = matchingRows.map((r) => r.row).join(", ");
    return {
      code,
      rows: matchingRows,
      hts: {
        kind: "none",
        sentence: `Part code "${code}" of invoice line ${n} is on ${matchingRows.length} rows of the customer parts list (rows ${rowNumbers}), so the list was not used.`,
      },
      origin: { kind: "none" },
      mid: null,
    };
  }

  // Case 5: exactly one matching row
  const r = matchingRows[0];
  const partCode = code;

  // HTS logic
  let htsResult: LineParts["hts"];
  if (!r.hts) {
    htsResult = {
      kind: "none",
      sentence: `Customer parts list row ${r.row} (part code "${partCode}") has no usable HTS number ("").`,
    };
  } else {
    const listHtsNormalized = normalizeHts(r.hts.text.trim());
    if (!listHtsNormalized.ok) {
      htsResult = {
        kind: "none",
        sentence: `Customer parts list row ${r.row} (part code "${partCode}") has no usable HTS number ("${r.hts.text.trim()}").`,
      };
    } else if (invoiceHts === null) {
      htsResult = {
        kind: "list",
        entry: listHtsNormalized.value.entry,
        source: partsListSource(r, "hts"),
        note: `From the customer parts list row ${r.row} (part code "${partCode}").`,
      };
    } else {
      const invoiceHtsNormalized = normalizeHts(invoiceHts);
      if (invoiceHtsNormalized.ok && invoiceHtsNormalized.value.digits === listHtsNormalized.value.digits) {
        htsResult = {
          kind: "same",
          source: partsListSource(r, "hts"),
          note: `The customer parts list row ${r.row} (part code "${partCode}") gives the same number.`,
        };
      } else {
        htsResult = {
          kind: "differs",
          source: partsListSource(r, "hts"),
          reason: `Invoice line ${n} gives HTS ${invoiceHts}, and the customer parts list row ${r.row} (part code "${partCode}") gives ${listHtsNormalized.value.entry}. A person picks the number.`,
        };
      }
    }
  }

  // Origin logic
  let originResult: LineParts["origin"];
  if (!r.origin) {
    originResult = { kind: "none" };
  } else {
    const listOriginCode = countryCode(r.origin.text.trim());
    if (!listOriginCode.ok) {
      originResult = { kind: "none" };
    } else if (!invoiceOriginAccepted) {
      originResult = {
        kind: "list",
        code: listOriginCode.value,
        source: partsListSource(r, "origin"),
        note: `From the customer parts list row ${r.row} (part code "${partCode}").`,
      };
    } else if (invoiceOriginCode === null) {
      originResult = { kind: "none" };
    } else if (invoiceOriginCode === listOriginCode.value) {
      originResult = {
        kind: "same",
        source: partsListSource(r, "origin"),
        note: `The customer parts list row ${r.row} (part code "${partCode}") gives the same country.`,
      };
    } else {
      originResult = {
        kind: "differs",
        source: partsListSource(r, "origin"),
        reason: `Invoice line ${n} gives origin ${invoiceOriginCode}, and the customer parts list row ${r.row} (part code "${partCode}") gives ${listOriginCode.value}. A person picks the country of origin.`,
      };
    }
  }

  // MID logic
  let midResult: LineParts["mid"] = null;
  if (r.mid) {
    const t = r.mid.text.trim();
    if (/^[A-Z]{2}[A-Z0-9]{6,13}$/.test(t)) {
      midResult = { value: t, source: partsListSource(r, "mid") };
    }
  }

  return {
    code,
    rows: matchingRows,
    hts: htsResult,
    origin: originResult,
    mid: midResult,
  };
}
