import { Draft, DraftField, Source, DocSource, HtsSource } from "./draft";

export const CSV_COLUMNS = [
  "field_id",
  "block",
  "line",
  "label",
  "value",
  "unit",
  "status",
  "rule",
  "note",
  "reason",
  "sources",
  "inputs",
] as const;

/**
 * Format a source for CSV output.
 * DocSource: `${doc} p.${page} [${x},${y},${w},${h}] "${quote}"`
 * With origin === "imageTranscript", append ` (read from an image by the AI reader)` after the closing quote.
 * With cell, append ` (cell <cell>)` after the closing quote.
 * HtsSource: `HTS ${revision} ${htsno}`
 * CodeTableSource: `${table} ${edition} ${code} "${name}"` with `, ${country}` inside the quotes when present.
 */
export function formatSource(s: Source): string {
  if (s.kind === "codeTable") {
    const cts = s as any;
    const nameWithCountry = cts.country ? `${cts.name}, ${cts.country}` : cts.name;
    return `${cts.table} ${cts.edition} ${cts.code} "${nameWithCountry}"`;
  } else if (s.kind === "document") {
    const docS = s as DocSource;
    const x = docS.box.x.toFixed(1);
    const y = docS.box.y.toFixed(1);
    const w = docS.box.w.toFixed(1);
    const h = docS.box.h.toFixed(1);
    const quote = docS.quote.replace(/"/g, '""'); // Escape quotes in the quote itself
    let base = `${docS.doc} p.${docS.page} [${x},${y},${w},${h}] "${quote}"`;
    if (docS.origin === "imageTranscript") {
      base += " (read from an image by the AI reader)";
    }
    if (docS.cell) {
      base += ` (cell ${docS.cell})`;
    }
    return base;
  } else {
    const htsS = s as HtsSource;
    return `HTS ${htsS.revision} ${htsS.htsno}`;
  }
}

/**
 * Escape a cell value for RFC 4180 CSV.
 * If the cell contains comma, quote, CR, or LF, wrap in double quotes and escape inner quotes.
 * Requirement 28.2: a cell that starts with a formula character gets a leading quote, so a spreadsheet shows the text instead of running it.
 * Requirement 44.1: a plain number keeps its sign without the quote.
 */
function escapeCsvCell(value: string): string {
  // Requirement 44.1: a plain number (optional sign, digits or thousands groups, optional decimals) keeps its sign without the quote.
  const PLAIN_NUMBER = /^[+-]?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/;
  const v = /^[=+\-@\t\r]/.test(value) && !PLAIN_NUMBER.test(value) ? "'" + value : value;
  if (v.includes(",") || v.includes('"') || v.includes("\r") || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/**
 * Convert a draft to RFC 4180 CSV format.
 * Row 1: column headers.
 * Rows 2-5: META rows (notice, bundle, reader, htsRevision).
 * Rows 6+: one per field in allFields order.
 * Rows end with "\r\n", including the last one.
 */
export function draftToCsv(d: Draft): string {
  const rows: string[][] = [];

  // Row 1: headers
  rows.push([...CSV_COLUMNS]);

  // META rows
  rows.push(["META.notice", "", "", "Notice", d.notice, "", "info", "", "", "", "", ""]);
  rows.push(["META.bundle", "", "", "Bundle", d.bundle, "", "info", "", "", "", "", ""]);
  rows.push(["META.reader", "", "", "Reader", d.reader, "", "info", "", "", "", "", ""]);
  rows.push([
    "META.htsRevision",
    "",
    "",
    "HTS revision checked",
    d.htsRevision,
    "",
    "info",
    "",
    "",
    "",
    "",
    "",
  ]);

  // Collect all fields in order: header, then lines, then totals
  const allFields: DraftField[] = [];

  for (const field of d.header) {
    allFields.push(field);
  }

  for (const line of d.lines) {
    for (const field of line.fields) {
      allFields.push(field);
    }
  }

  for (const field of d.totals) {
    allFields.push(field);
  }

  // Data rows: one per field
  for (const field of allFields) {
    const value = field.value ?? "";
    const unit = field.unit ?? "";
    const rule = field.rule ?? "";
    const note = field.note ?? "";
    const reason = field.reason ?? "";
    const sources = field.sources.map(formatSource).join(" | ");
    const inputs = field.inputs.join(" ");

    rows.push([
      field.id,
      field.block,
      field.line ?? "",
      field.label,
      value,
      unit,
      field.status,
      rule,
      note,
      reason,
      sources,
      inputs,
    ]);
  }

  // Escape and format as RFC 4180
  const lines = rows.map((row) => row.map(escapeCsvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

/**
 * Small RFC 4180 CSV parser for tests and verification scripts.
 * Accepts both CRLF and LF line endings.
 * Returns array of rows, each row is array of cell strings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  const chars = text.split("");
  let row: string[] = [];

  while (i < chars.length) {
    const ch = chars[i];
    const nextCh = i + 1 < chars.length ? chars[i + 1] : "";

    if (inQuotes) {
      if (ch === '"' && nextCh === '"') {
        // Escaped quote: ""
        current += '"';
        i += 2;
      } else if (ch === '"') {
        // End of quoted cell
        inQuotes = false;
        i++;
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        // Start of quoted cell
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        // End of cell
        row.push(current);
        current = "";
        i++;
      } else if (ch === "\r" && nextCh === "\n") {
        // CRLF line ending
        row.push(current);
        if (row.length > 0) {
          rows.push(row);
        }
        row = [];
        current = "";
        i += 2;
      } else if (ch === "\n") {
        // LF line ending
        row.push(current);
        if (row.length > 0) {
          rows.push(row);
        }
        row = [];
        current = "";
        i++;
      } else if (ch === "\r") {
        // CR alone (treat as line ending for robustness)
        row.push(current);
        if (row.length > 0) {
          rows.push(row);
        }
        row = [];
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }

  // Handle any remaining content
  if (current.length > 0 || inQuotes || row.length > 0) {
    row.push(current);
  }
  if (row.length > 0) {
    rows.push(row);
  }

  return rows;
}
