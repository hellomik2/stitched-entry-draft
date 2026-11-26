import { normalizeSpace, Box } from "./pdfText";
import { VerifiedReading } from "./reading";
import { HtsTable, lookupHts, normalizeHts } from "./hts";
import {
  parseMoneyToCents,
  parseCount,
  parseKgToTenths,
  parsePackages,
  parseUsDate,
  parseDocumentDate,
  countryCode,
  formatCents,
} from "./parse";
import { roundEnteredValue, computeDuty, allocateGrossWeight, totalEnteredValue, computeMPF, config } from "../rules";
import { type PartsList, type LineParts, linePartsInfo } from "./partsList";
import { type CodeTableSource, lookupUsPort, lookupForeignPort, codeTableSourceD, codeTableSourceK } from "./codeTables";
import { suggestMid } from "./mid";

export const DRAFT_NOTICE = "DRAFT, NOT FOR FILING";

export const LOW_CONFIDENCE_REVIEW_REASON = "The AI reader was not sure of this value. Check it against the page, then confirm it.";

export const IMAGE_REVIEW_REASON = "Read from an image by the AI reader. Check it against the page, then confirm it.";

export const IMAGE_COMPUTED_REVIEW_REASON = "Computed from values the AI reader read from an image. Check them against the page, then confirm it.";

export const IMAGE_WAITING_SUFFIX = "values read from an image are not confirmed yet.";

export const UNPLACED_REVIEW_REASON =
  "Read from an image by the AI reader, from a line that is not in its transcript, so there is no box on the page. Find it on the page, check it, then confirm it.";

export const UNPLACED_COMPUTED_REVIEW_REASON =
  "Computed from values the AI reader read from an image. At least one is from a line that is not in its transcript, so it has no box on the page. Check them against the page, then confirm it.";

export const LINE_WITHOUT_BOX_REVIEW_REASON =
  "Read from an image by the AI reader, from a transcript line it gave no usable place for, so there is no box on the page. Find it on the page, check it, then confirm it.";

export const LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON =
  "Computed from values the AI reader read from an image. At least one is from a transcript line it gave no usable place for, so it has no box on the page. Check them against the page, then confirm it.";

/** The six reasons of a value that waits only for a person's check of image values (Requirements 18.1, 26.1, 50.3, 58.3). */
export function isImageReviewReason(reason: string | null | undefined): boolean {
  return (
    reason === IMAGE_REVIEW_REASON ||
    reason === IMAGE_COMPUTED_REVIEW_REASON ||
    reason === UNPLACED_REVIEW_REASON ||
    reason === UNPLACED_COMPUTED_REVIEW_REASON ||
    reason === LINE_WITHOUT_BOX_REVIEW_REASON ||
    reason === LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON
  );
}

export const CONFIRMED_NOTE = "Confirmed by a person against the page.";

export const NO_LINE_REASON = "No 7501 line was built because no invoice line was read. A person reads the invoice lines.";

export type FieldStatus = "copied" | "computed" | "needsReview" | "personInput" | "personEdited";

export type DocSource = {
  kind: "document";
  doc: string;
  page: number;
  quote: string;
  box: Box | null;
  readingField: string;
  origin?: "imageTranscript";
  notInTranscript?: true;
  lineWithoutBox?: true;
  cell?: string;
};

export type HtsSource = {
  kind: "hts";
  revision: string;
  htsno: string;
};

export type Source = DocSource | HtsSource | CodeTableSource;

export type DraftField = {
  id: string;
  block: string;
  line: string | null;
  label: string;
  value: string | null;
  unit: string | null;
  status: FieldStatus;
  rule: string | null;
  note: string | null;
  reason: string | null;
  sources: Source[];
  inputs: string[];
  candidates?: { value: string; label: string }[];
};

export type Check = {
  id: string;
  rule: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type DraftLine = {
  lineNumber: string;
  invoiceLines: number[];
  fields: DraftField[];
};

export type ReviewItem = {
  fieldId: string;
  label: string;
  status: "needsReview" | "personInput";
  reason: string;
};

export type Override = {
  fieldId: string;
  value: string;
};

export type Draft = {
  notice: typeof DRAFT_NOTICE;
  bundle: string;
  reader: string;
  htsRevision: string;
  htsRevisionTitle: string;
  header: DraftField[];
  lines: DraftLine[];
  totals: DraftField[];
  checks: Check[];
  rejectedReadings: { field: string; reason: string; message: string }[];
  needsReview: ReviewItem[];
  personInput: ReviewItem[];
};

/**
 * Helper: extract a normalized value from accepted readings by field name.
 * Returns null if not found or rejected.
 */
function getValue(readings: Map<string, VerifiedReading>, fieldName: string): string | null {
  const reading = readings.get(fieldName);
  if (!reading || reading.status !== "accepted") return null;
  return reading.value ? normalizeSpace(reading.value) : null;
}

/**
 * Helper: check if a reading is from an image page.
 */
function fromImagePage(reading: VerifiedReading | undefined): boolean {
  return !!reading && reading.status === "accepted" && reading.origin === "imageTranscript";
}

/**
 * Helper: create a DocSource from an accepted or uncertain reading.
 */
function docSource(reading: VerifiedReading): DocSource {
  if (reading.status !== "accepted" && reading.status !== "uncertain") {
    throw new Error("Cannot create DocSource from rejected reading");
  }
  const source: DocSource = {
    kind: "document",
    doc: reading.doc,
    page: reading.page,
    quote: normalizeSpace(reading.quote),
    box: reading.box,
    readingField: reading.field,
  };
  if (reading.origin === "imageTranscript") {
    source.origin = "imageTranscript";
  }
  if (reading.notInTranscript) {
    source.notInTranscript = true;
  }
  if (reading.lineWithoutBox) {
    source.lineWithoutBox = true;
  }
  if (reading.cell) {
    source.cell = reading.cell;
  }
  return source;
}

/**
 * Helper: combine two strings with ", " separator.
 */
function combine(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return `${a}, ${b}`;
}

/**
 * Helper: validate B/L number format (^[A-Z]{4}[A-Z0-9]{1,12}$).
 */
function isValidBlNumber(blno: string): boolean {
  return /^[A-Z]{4}[A-Z0-9]{1,12}$/.test(blno);
}

/**
 * Helper: gather all accepted readings into a Map by field name.
 */
function acceptedReadings(verified: VerifiedReading[]): Map<string, VerifiedReading> {
  const map = new Map<string, VerifiedReading>();
  for (const v of verified) {
    if (v.status === "accepted") {
      map.set(v.field, v);
    }
  }
  return map;
}

// Requirement 57.1: the tariff footnotes already read "See 9903.90.08.", so "See" and the period are put on once.
export function chapter99Reason(footnotes: string[]): string {
  const parts = footnotes.map((f) => `See ${f.trim().replace(/[\s.]+$/, "").replace(/^see\b\s*/i, "")}`);
  return `${parts.join("; ")}. A person enters the additional duty (0.00 if none).`;
}

/**
 * Build a draft for CBP Form 7501.
 * Part 1: checks, header (except B10), rejectedReadings.
 */
export function buildDraft(input: {
  bundle: string;
  reader: string;
  readings: VerifiedReading[];
  hts: HtsTable;
  overrides?: Override[];
  invoiceLineCount?: number | null;
  packingListLineCount?: number | null;
  partsList?: PartsList | null;
}): Draft {
  const { bundle, reader, readings, hts } = input;
  const overrides = input.overrides || [];
  const overrideMap = new Map(overrides.map((o) => [o.fieldId, o.value]));

  const verified: VerifiedReading[] = readings.map((r) => {
    if (r.status === "uncertain" && (r.notInTranscript === true || r.lineWithoutBox === true) && r.confidence !== "low") {
      const { message: _message, ...rest } = r;
      return { ...rest, status: "accepted" as const };
    }
    return r;
  });
  const accepted = acceptedReadings(verified);

  // Rejected readings
  const rejectedReadings = verified
    .filter((r) => r.status === "rejected" || r.status === "uncertain")
    .map((r) => ({
      field: r.field,
      reason: r.status === "rejected" ? r.reason : "low_confidence",
      message: r.message,
    }));

  // Build checks with proper ordering and parsing
  const checks: Check[] = [];

  // Parse all invoice lines using proper parsers.
  // quantity: parseCount, unitPrice: parseMoneyToCents, amount: parseMoneyToCents
  const invoiceLines = new Map<
    number,
    {
      quantity: number | null;
      unitPrice: number | null;
      amount: number | null;
      itemNo: string | null;
    }
  >();

  for (let n = 1; n <= 8; n++) {
    const qtyField = `invoice.lines.${n}.quantity`;
    const priceField = `invoice.lines.${n}.unitPrice`;
    const amountField = `invoice.lines.${n}.amount`;
    const itemField = `invoice.lines.${n}.itemNo`;

    const qtyReading = accepted.get(qtyField);
    const priceReading = accepted.get(priceField);
    const amountReading = accepted.get(amountField);
    const itemReading = accepted.get(itemField);

    let qty: number | null = null;
    let price: number | null = null;
    let amt: number | null = null;
    let itemNo: string | null = null;

    if (qtyReading && qtyReading.value) {
      const qtyResult = parseCount(normalizeSpace(qtyReading.value));
      if (qtyResult.ok) qty = qtyResult.value;
    }

    if (priceReading && priceReading.value) {
      const priceResult = parseMoneyToCents(normalizeSpace(priceReading.value));
      if (priceResult.ok) price = priceResult.value;
    }

    if (amountReading && amountReading.value) {
      const amtResult = parseMoneyToCents(normalizeSpace(amountReading.value));
      if (amtResult.ok) amt = amtResult.value;
    }

    if (itemReading && itemReading.value) {
      itemNo = normalizeSpace(itemReading.value);
    }

    invoiceLines.set(n, { quantity: qty, unitPrice: price, amount: amt, itemNo });
  }

  // Build packing list index by itemNo
  const packingByItemNo = new Map<string, number[]>();
  for (let n = 1; n <= 8; n++) {
    const qtyField = `packingList.lines.${n}.quantity`;
    const itemField = `packingList.lines.${n}.itemNo`;

    const itemReading = accepted.get(itemField);
    const qtyReading = accepted.get(qtyField);

    if (itemReading && itemReading.value && qtyReading && qtyReading.value) {
      const itemNo = normalizeSpace(itemReading.value);
      const qtyResult = parseCount(normalizeSpace(qtyReading.value));
      if (qtyResult.ok) {
        if (!packingByItemNo.has(itemNo)) {
          packingByItemNo.set(itemNo, []);
        }
        packingByItemNo.get(itemNo)!.push(qtyResult.value);
      }
    }
  }

  // Requirement 33.1 & 36.4b: Identify packing list lines that were not fully read or have uncertain quantities
  const packingNotFullyRead: { line: number; itemNo: string | null; uncertainQty?: boolean }[] = [];
  for (let n = 1; n <= 8; n++) {
    const hasAnyReading = verified.some((r) => r.field.startsWith(`packingList.lines.${n}.`));
    if (!hasAnyReading) continue;

    const itemNoReading = accepted.get(`packingList.lines.${n}.itemNo`);
    const qtyReading = verified.find((r) => r.field === `packingList.lines.${n}.quantity`);

    const itemNoValue = itemNoReading && itemNoReading.value ? normalizeSpace(itemNoReading.value) : null;
    const qtyOk = qtyReading && qtyReading.value && qtyReading.status === "accepted" ? parseCount(normalizeSpace(qtyReading.value)).ok : false;
    const qtyUncertain = qtyReading && qtyReading.status === "uncertain";

    if (!itemNoValue || !qtyOk || qtyUncertain) {
      packingNotFullyRead.push({ 
        line: n, 
        itemNo: itemNoValue,
        uncertainQty: qtyUncertain
      });
    }
  }

  // Requirement 33.2 & 36.4b: One quantity check
  const packingQuantityProblem = (
    n: number,
    itemNo: string | null,
    q: number
  ): { reason: string; detail: string } | null => {
    // Check for uncertain-only packing list lines (Requirement 36.4b)
    const uncertainOnlyLines = packingNotFullyRead.filter(
      (x) => x.itemNo === itemNo && x.uncertainQty && 
        // Also check that this line doesn't have a not-fully-read issue for other reasons
        packingNotFullyRead.filter((y) => y.line === x.line && !y.uncertainQty).length === 0
    );
    
    if (uncertainOnlyLines.length > 0) {
      const lineList = uncertainOnlyLines.map((x) => x.line).join(", ");
      const values = uncertainOnlyLines
        .map((x) => {
          const r = verified.find((r) => r.field === `packingList.lines.${x.line}.quantity` && r.status === "uncertain");
          return r ? normalizeSpace(r.value ?? "") : "?";
        })
        .join(", ");
      
      return {
        reason: `The AI reader read the quantity of packing list line ${lineList} as ${values} but was not sure, so invoice line ${n} (${q} PCS) was not compared with the packing list. A person compares them.`,
        detail: `packing list line ${lineList} quantity not sure`,
      };
    }

    // (a) itemNo is null
    if (itemNo === null) {
      return {
        reason: `The item number of invoice line ${n} was not read, so its quantity was not compared with the packing list. A person compares them.`,
        detail: "invoice item number not read",
      };
    }

    // (b) lines where packing list line was not fully read with this itemNo
    const notFullyReadWithItemNo = packingNotFullyRead.filter((x) => x.itemNo === itemNo && !x.uncertainQty);
    if (notFullyReadWithItemNo.length > 0) {
      const lineList = notFullyReadWithItemNo.map((x) => x.line).join(", ");
      return {
        reason: `Packing list line ${lineList} was not fully read (item number or quantity), so invoice line ${n} (${q} PCS) was not compared with the packing list. A person compares them.`,
        detail: `packing list line ${lineList} not fully read`,
      };
    }

    // (c) sum of packing with itemNo != q and there are not-fully-read lines with itemNo === null
    const sum = (packingByItemNo.get(itemNo) ?? []).reduce((a, b) => a + b, 0);
    if (sum !== q) {
      const notFullyReadNoItemNo = packingNotFullyRead.filter((x) => x.itemNo === null && !x.uncertainQty);
      if (notFullyReadNoItemNo.length > 0) {
        const lineList = notFullyReadNoItemNo.map((x) => x.line).join(", ");
        return {
          reason: `Packing list line ${lineList} was not fully read (item number or quantity), so invoice line ${n} (${q} PCS) was not compared with the packing list. A person compares them.`,
          detail: `packing list line ${lineList} not fully read`,
        };
      }
    }

    // (d) no packing list line for itemNo was read
    if (!packingByItemNo.has(itemNo)) {
      return {
        reason: `Invoice line ${n} (${itemNo}) says ${q} PCS; no packing list line for ${itemNo} was read. A person decides.`,
        detail: `no packing list line for ${itemNo} was read`,
      };
    }

    // (e) sum !== q
    const packingSum = (packingByItemNo.get(itemNo) ?? []).reduce((a, b) => a + b, 0);
    if (packingSum !== q) {
      return {
        reason: `says ${q} PCS, the packing list says ${packingSum} PCS. A person decides.`,
        detail: `invoice qty = ${q}, packing sum = ${packingSum}`,
      };
    }

    // No problem
    return null;
  };

  // P1 and P3.qty checks interleaved by invoice line
  for (let n = 1; n <= 8; n++) {
    const line = invoiceLines.get(n)!;

    // P1: quantity × unitPrice ≈ amount (within 1 cent)
    {
      const id = `P1.invoice.line.${n}`;

      if (line.quantity !== null && line.unitPrice !== null && line.amount !== null) {
        const computed = line.quantity * line.unitPrice;
        const diff = Math.abs(computed - line.amount);
        const ok = diff <= 1; // Within 1 cent
        checks.push({
          id,
          rule: "P1",
          label: `Invoice line ${n} arithmetic`,
          ok,
          detail: ok
            ? "quantity × unitPrice ≈ amount"
            : `quantity × unitPrice = ${(computed / 100).toFixed(2)}, amount = ${(line.amount / 100).toFixed(2)}, diff = ${(diff / 100).toFixed(2)}`,
        });
      }
    }

    // P3: invoice quantity matches packing sum for this itemNo
    {
      const id = `P3.qty.${line.itemNo || `LH-${String(n).padStart(3, "0")}`}`;

      if (line.itemNo && line.quantity !== null) {
        const problem = packingQuantityProblem(n, line.itemNo, line.quantity);
        checks.push({
          id,
          rule: "P3",
          label: `Invoice qty ${line.itemNo}`,
          ok: problem === null,
          detail: problem ? problem.detail : "invoice qty = packing sum",
        });
      }
    }
  }

  // P2 checks: subtotal and total
  const subtotalReading = accepted.get("invoice.subtotal");
  const totalReading = accepted.get("invoice.total");

  // P2.invoice.subtotal: sum of line amounts equals subtotal
  if (subtotalReading && subtotalReading.value) {
    const subtotalResult = parseMoneyToCents(normalizeSpace(subtotalReading.value));
    if (subtotalResult.ok) {
      let lineSum = 0;
      for (let n = 1; n <= 8; n++) {
        const line = invoiceLines.get(n)!;
        if (line.amount !== null) {
          lineSum += line.amount;
        }
      }
      const id = "P2.invoice.subtotal";
      const ok = Math.abs(lineSum - subtotalResult.value) <= 1; // Within 1 cent
      checks.push({
        id,
        rule: "P2",
        label: "Invoice subtotal",
        ok,
        detail: ok
          ? "sum of line amounts = subtotal"
          : `line sum = ${(lineSum / 100).toFixed(2)}, subtotal = ${(subtotalResult.value / 100).toFixed(2)}`,
      });
    }
  }

  // P2.invoice.total: subtotal equals total
  if (subtotalReading && subtotalReading.value && totalReading && totalReading.value) {
    const subtotalResult = parseMoneyToCents(normalizeSpace(subtotalReading.value));
    const totalResult = parseMoneyToCents(normalizeSpace(totalReading.value));
    if (subtotalResult.ok && totalResult.ok) {
      const id = "P2.invoice.total";
      const ok = Math.abs(subtotalResult.value - totalResult.value) <= 1; // Within 1 cent
      checks.push({
        id,
        rule: "P2",
        label: "Invoice total",
        ok,
        detail: ok
          ? "subtotal = total"
          : `subtotal = ${(subtotalResult.value / 100).toFixed(2)}, total = ${(totalResult.value / 100).toFixed(2)}`,
      });
    }
  }

  // P3 packing list totals
  let packingGrossSum = 0,
    packingNetSum = 0,
    packingCartonSum = 0;
  const grossNotUsed: number[] = [];
  const netNotUsed: number[] = [];
  const cartonsNotUsed: number[] = [];

  for (let n = 1; n <= 8; n++) {
    const gField = `packingList.lines.${n}.grossKg`;
    const nField = `packingList.lines.${n}.netKg`;
    const cField = `packingList.lines.${n}.cartons`;

    const gReading = accepted.get(gField);
    const nReading = accepted.get(nField);
    const cReading = accepted.get(cField);

    // Check if line has at least one reading
    const hasReading = verified.some(
      (r) =>
        r.field.startsWith(`packingList.lines.${n}.grossKg`) ||
        r.field.startsWith(`packingList.lines.${n}.netKg`) ||
        r.field.startsWith(`packingList.lines.${n}.cartons`)
    );

    if (gReading && gReading.value) {
      const gResult = parseKgToTenths(normalizeSpace(gReading.value));
      if (gResult.ok) packingGrossSum += gResult.value;
      else if (hasReading) grossNotUsed.push(n);
    } else if (hasReading) {
      grossNotUsed.push(n);
    }

    if (nReading && nReading.value) {
      const nResult = parseKgToTenths(normalizeSpace(nReading.value));
      if (nResult.ok) packingNetSum += nResult.value;
      else if (hasReading) netNotUsed.push(n);
    } else if (hasReading) {
      netNotUsed.push(n);
    }

    if (cReading && cReading.value) {
      const cResult = parseCount(normalizeSpace(cReading.value));
      if (cResult.ok) packingCartonSum += cResult.value;
      else if (hasReading) cartonsNotUsed.push(n);
    } else if (hasReading) {
      cartonsNotUsed.push(n);
    }
  }

  const totalGrossReading = accepted.get("packingList.totalGrossKg");
  const totalNetReading = accepted.get("packingList.totalNetKg");
  const totalCartonReading = accepted.get("packingList.totalCartons");

  if (totalGrossReading && totalGrossReading.value) {
    const totalGrossResult = parseKgToTenths(normalizeSpace(totalGrossReading.value));
    if (totalGrossResult.ok) {
      checks.push({
        id: "P3.packing.gross",
        rule: "P3",
        label: "Packing list gross weight",
        ok: Math.abs(packingGrossSum - totalGrossResult.value) <= 1, // Within 1 tenth
        detail:
          grossNotUsed.length > 0
            ? `packing list line ${grossNotUsed.join(", ")} gross weight not read or not sure`
            : `line sum = ${(packingGrossSum / 10).toFixed(1)}, total = ${(totalGrossResult.value / 10).toFixed(1)}`,
      });
    }
  }

  if (totalNetReading && totalNetReading.value) {
    const totalNetResult = parseKgToTenths(normalizeSpace(totalNetReading.value));
    if (totalNetResult.ok) {
      checks.push({
        id: "P3.packing.net",
        rule: "P3",
        label: "Packing list net weight",
        ok: Math.abs(packingNetSum - totalNetResult.value) <= 1, // Within 1 tenth
        detail:
          netNotUsed.length > 0
            ? `packing list line ${netNotUsed.join(", ")} net weight not read or not sure`
            : `line sum = ${(packingNetSum / 10).toFixed(1)}, total = ${(totalNetResult.value / 10).toFixed(1)}`,
      });
    }
  }

  if (totalCartonReading && totalCartonReading.value) {
    const totalCartonResult = parseCount(normalizeSpace(totalCartonReading.value));
    if (totalCartonResult.ok) {
      checks.push({
        id: "P3.packing.cartons",
        rule: "P3",
        label: "Packing list cartons",
        ok: packingCartonSum === totalCartonResult.value,
        detail:
          cartonsNotUsed.length > 0
            ? `packing list line ${cartonsNotUsed.join(", ")} cartons not read or not sure`
            : `line sum = ${packingCartonSum}, total = ${totalCartonResult.value}`,
      });
    }
  }

  // Requirement 51.5: the packing list line count of the reader against the lines the draft has readings for.
  const packingCount = input.packingListLineCount;
  if (typeof packingCount === "number") {
    const packingLinesRead = new Set(
      verified
        .map((r) => /^packingList\.lines\.(\d+)\./.exec(r.field)?.[1])
        .filter((n): n is string => n !== undefined && Number(n) >= 1 && Number(n) <= 8),
    ).size;
    const same = packingCount === packingLinesRead;
    checks.push({
      id: "P3.packing.lines",
      rule: "P3",
      label: "Packing list lines read",
      ok: same,
      detail:
        (same
          ? `the packing list shows ${packingCount} item lines and the draft has readings for ${packingLinesRead}`
          : `the packing list shows ${packingCount} item lines, but the draft has readings for ${packingLinesRead}`) +
        (packingCount > 8 ? "; this draft reads only the first 8" : ""),
    });
  }

  // X checks: B/L vs packing, packing vs invoice, etc.
  const blGrossReading = accepted.get("billOfLading.grossKg");
  const blPackagesReading = accepted.get("billOfLading.packages");

  if (blGrossReading && blGrossReading.value && totalGrossReading && totalGrossReading.value) {
    const blGrossResult = parseKgToTenths(normalizeSpace(blGrossReading.value));
    const totalGrossResult = parseKgToTenths(normalizeSpace(totalGrossReading.value));
    if (blGrossResult.ok && totalGrossResult.ok) {
      checks.push({
        id: "X.bl.gross",
        rule: "P3",
        label: "B/L gross = packing gross",
        ok: Math.abs(blGrossResult.value - totalGrossResult.value) <= 1,
        detail: `B/L gross = ${(blGrossResult.value / 10).toFixed(1)}, packing gross = ${(totalGrossResult.value / 10).toFixed(1)}`,
      });
    }
  }

  if (blPackagesReading && blPackagesReading.value && totalCartonReading && totalCartonReading.value) {
    const blPackagesResult = parsePackages(normalizeSpace(blPackagesReading.value));
    const totalCartonResult = parseCount(normalizeSpace(totalCartonReading.value));
    if (blPackagesResult.ok && totalCartonResult.ok) {
      checks.push({
        id: "X.bl.packages",
        rule: "P3",
        label: "B/L packages = packing cartons",
        ok: blPackagesResult.value === totalCartonResult.value,
        detail: `B/L packages = ${blPackagesResult.value}, packing cartons = ${totalCartonResult.value}`,
      });
    }
  }

  // X checks: packing vs invoice ref and B/L number
  const plInvoiceRefReading = accepted.get("packingList.invoiceRef");
  const invoiceNumberReading = accepted.get("invoice.number");

  if (plInvoiceRefReading && plInvoiceRefReading.value && invoiceNumberReading && invoiceNumberReading.value) {
    const plRef = normalizeSpace(plInvoiceRefReading.value);
    const invNo = normalizeSpace(invoiceNumberReading.value);
    checks.push({
      id: "X.pl.invoiceRef",
      rule: "X",
      label: "Packing list invoice reference",
      ok: plRef === invNo,
      detail: `packing invoice ref = "${plRef}", invoice number = "${invNo}"`,
    });
  }

  const plBlNumberReading = accepted.get("packingList.blNumber");
  const blNumberReading = accepted.get("billOfLading.number");

  if (plBlNumberReading && plBlNumberReading.value && blNumberReading && blNumberReading.value) {
    const plBl = normalizeSpace(plBlNumberReading.value);
    const blNo = normalizeSpace(blNumberReading.value);
    checks.push({
      id: "X.pl.blNumber",
      rule: "X",
      label: "Packing list B/L number",
      ok: plBl === blNo,
      detail: `packing B/L number = "${plBl}", B/L number = "${blNo}"`,
    });
  }

  const blConsigneeReading = accepted.get("billOfLading.consignee.name");
  const invoiceBuyerReading = accepted.get("invoice.buyer.name");

  if (blConsigneeReading && blConsigneeReading.value && invoiceBuyerReading && invoiceBuyerReading.value) {
    const blCons = normalizeSpace(blConsigneeReading.value);
    const invBuyer = normalizeSpace(invoiceBuyerReading.value);
    checks.push({
      id: "X.bl.consignee",
      rule: "X",
      label: "B/L consignee = invoice buyer",
      ok: blCons === invBuyer,
      detail: `B/L consignee = "${blCons}", invoice buyer = "${invBuyer}"`,
    });
  }

  // Header fields (excluding B10, which comes in the next request)
  const headerFields: DraftField[] = [];

  // B1: personInput
  headerFields.push(
    field_helper({
      id: "B1",
      block: "1",
      label: "Filer code / entry number",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B2: personInput
  headerFields.push(
    field_helper({
      id: "B2",
      block: "2",
      label: "Entry type",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B3: personInput
  headerFields.push(
    field_helper({
      id: "B3",
      block: "3",
      label: "Summary date",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B4: personInput
  headerFields.push(
    field_helper({
      id: "B4",
      block: "4",
      label: "Surety number",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B5: personInput
  headerFields.push(
    field_helper({
      id: "B5",
      block: "5",
      label: "Bond type",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B6: needsReview (Requirement 47.5), input B20
  // B20 is computed later; B6 is a placeholder here
  headerFields.push(
    field_helper({
      id: "B6",
      block: "6",
      label: "Port code",
      status: "needsReview",
      reason: "Schedule D code lookup not built. Port of discharge from B/L required.",
    })
  );

  // B7: personInput
  headerFields.push(
    field_helper({
      id: "B7",
      block: "7",
      label: "Entry date",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B8: copied from billOfLading.vessel
  const vesselReading = accepted.get("billOfLading.vessel");
  const vesselUncertainReading = verified.find((r) => r.field === "billOfLading.vessel" && r.status === "uncertain");
  const vesselReadingToUse = vesselReading || vesselUncertainReading;
  
  if (vesselReadingToUse && vesselReadingToUse.value) {
    const vesselValue = normalizeSpace(vesselReadingToUse.value);
    if (vesselUncertainReading) {
      headerFields.push(
        field_helper({
          id: "B8",
          block: "8",
          label: "Importing carrier (vessel)",
          value: vesselValue,
          status: "needsReview",
          reason: LOW_CONFIDENCE_REVIEW_REASON,
          sources: [docSource(vesselUncertainReading)],
        })
      );
    } else {
      headerFields.push(
        field_helper({
          id: "B8",
          block: "8",
          label: "Importing carrier (vessel)",
          value: vesselValue,
          status: "copied",
          sources: [docSource(vesselReadingToUse)],
        })
      );
    }
  } else {
    headerFields.push(
      field_helper({
        id: "B8",
        block: "8",
        label: "Importing carrier (vessel)",
        status: "needsReview",
        reason: "Vessel name not found in documents.",
      })
    );
  }

  // B9 (Requirement 47.7): mode of transport from container number or vessel
  const containerReading = accepted.get("billOfLading.containerNo");
  const containerAny = verified.find((r) => r.field === "billOfLading.containerNo");
  const containerMissing = !containerAny || (containerAny.status === "rejected" && containerAny.reason === "value_missing");
  
  if (containerReading) {
    // Case 7a: container number accepted -> "11"
    headerFields.push(
      field_helper({
        id: "B9",
        block: "9",
        label: "Mode of transport",
        value: "11",
        unit: null,
        status: "computed",
        rule: "7501 p.8",
        note: "Vessel, containerized: the B/L lists a container.",
        sources: [docSource(containerReading)],
      })
    );
  } else if (containerMissing && vesselReading) {
    // Case 7b: container number missing, vessel accepted -> "10" (Requirement 47.7b)
    headerFields.push(
      field_helper({
        id: "B9",
        block: "9",
        label: "Mode of transport",
        value: "10",
        unit: null,
        status: "computed",
        rule: "7501 p.8",
        note: "Vessel, not containerized: no container number was read on the bill of lading. The 7501 instructions use 10 for a vessel when it is not known whether the goods were containerized.",
        sources: [docSource(vesselReading)],
      })
    );
  } else if (!containerMissing) {
    // Case 7c: container rejected for another reason or uncertain -> needsReview (Requirement 44.3)
    headerFields.push(
      field_helper({
        id: "B9",
        block: "9",
        label: "Mode of transport",
        status: "needsReview",
        reason: "The container number on the bill of lading was not read, so the mode of transport is not known. A person checks the bill of lading.",
      })
    );
  } else {
    // Case 7d: no vessel and no container -> needsReview (Requirement 47.7d)
    headerFields.push(
      field_helper({
        id: "B9",
        block: "9",
        label: "Mode of transport",
        status: "needsReview",
        reason: "No vessel and no container number were read from the bill of lading, so the mode of transport is not known. A person checks the transport document.",
      })
    );
  }

  // B11: needsReview
  headerFields.push(
    field_helper({
      id: "B11",
      block: "11",
      label: "Import date",
      status: "needsReview",
      reason: "No arrival notice in bundle. Import date is vessel arrival date (7501 p.9).",
    })
  );

  // B12: copied from billOfLading.number if valid
  const blReading = accepted.get("billOfLading.number");
  const blUncertainReading = verified.find((r) => r.field === "billOfLading.number" && r.status === "uncertain");
  const blReadingToUse = blReading || blUncertainReading;
  
  if (blReadingToUse && blReadingToUse.value) {
    const blValue = normalizeSpace(blReadingToUse.value);
    if (isValidBlNumber(blValue)) {
      const carrierCode = blValue.substring(0, 4);
      if (blUncertainReading) {
        headerFields.push(
          field_helper({
            id: "B12",
            block: "12",
            label: "B/L number",
            value: blValue,
            status: "needsReview",
            reason: LOW_CONFIDENCE_REVIEW_REASON,
            note: `Carrier code ${carrierCode}`,
            sources: [docSource(blUncertainReading)],
          })
        );
      } else {
        headerFields.push(
          field_helper({
            id: "B12",
            block: "12",
            label: "B/L number",
            value: blValue,
            status: "copied",
            note: `Carrier code ${carrierCode}`,
            sources: [docSource(blReadingToUse)],
          })
        );
      }
    } else {
      headerFields.push(
        field_helper({
          id: "B12",
          block: "12",
          label: "B/L number",
          status: "needsReview",
          reason: `B/L number format invalid: "${blValue}"`,
        })
      );
    }
  } else {
    headerFields.push(
      field_helper({
        id: "B12",
        block: "12",
        label: "B/L number",
        status: "needsReview",
        reason: "B/L number not found in documents.",
      })
    );
  }

  // B13: Manufacturer ID (Requirement 48.9) - placeholder, will be updated below when 7501 lines exist
  headerFields.push(
    field_helper({
      id: "B13",
      block: "13",
      label: "Manufacturer ID (MID)",
      status: "needsReview",
      reason: "Invoice names a trading company; manufacturer per line not in bundle.",
    })
  );

  // B14: copied from countryCode(invoice.countryOfExport)
  const exportCountryReading = accepted.get("invoice.countryOfExport");
  const exportCountryUncertainReading = verified.find((r) => r.field === "invoice.countryOfExport" && r.status === "uncertain");
  const exportCountryReadingToUse = exportCountryReading || exportCountryUncertainReading;
  
  if (exportCountryReadingToUse && exportCountryReadingToUse.value) {
    const codeResult = countryCode(normalizeSpace(exportCountryReadingToUse.value));
    if (codeResult.ok) {
      const countryText = normalizeSpace(exportCountryReadingToUse.value);
      if (exportCountryUncertainReading) {
        headerFields.push(
          field_helper({
            id: "B14",
            block: "14",
            label: "Exporting country",
            value: codeResult.value,
            status: "needsReview",
            reason: LOW_CONFIDENCE_REVIEW_REASON,
            note: countryText,
            sources: [docSource(exportCountryUncertainReading)],
          })
        );
      } else {
        headerFields.push(
          field_helper({
            id: "B14",
            block: "14",
            label: "Exporting country",
            value: codeResult.value,
            status: "copied",
            note: countryText,
            sources: [docSource(exportCountryReadingToUse)],
          })
        );
      }
    } else {
      headerFields.push(
        field_helper({
          id: "B14",
          block: "14",
          label: "Exporting country",
          status: "needsReview",
          reason: `Country not recognized: "${exportCountryReadingToUse.value}"`,
        })
      );
    }
  } else {
    headerFields.push(
      field_helper({
        id: "B14",
        block: "14",
        label: "Exporting country",
        status: "needsReview",
        reason: "Exporting country not found in documents.",
      })
    );
  }

  // B15: copied from billOfLading.onBoardDate
  const onBoardReading = accepted.get("billOfLading.onBoardDate");
  const onBoardUncertainReading = verified.find((r) => r.field === "billOfLading.onBoardDate" && r.status === "uncertain");
  const onBoardReadingToUse = onBoardReading || onBoardUncertainReading;
  
  if (onBoardReadingToUse && onBoardReadingToUse.value) {
    const dateResult = parseDocumentDate(normalizeSpace(onBoardReadingToUse.value));
    if (dateResult.ok) {
      if (onBoardUncertainReading) {
        headerFields.push(
          field_helper({
            id: "B15",
            block: "15",
            label: "Export date",
            value: dateResult.value,
            status: "needsReview",
            reason: LOW_CONFIDENCE_REVIEW_REASON,
            note: "Shipped on board date",
            sources: [docSource(onBoardUncertainReading)],
          })
        );
      } else {
        headerFields.push(
          field_helper({
            id: "B15",
            block: "15",
            label: "Export date",
            value: dateResult.value,
            status: "copied",
            note: "Shipped on board date",
            sources: [docSource(onBoardReadingToUse)],
          })
        );
      }
    } else {
      headerFields.push(
        field_helper({
          id: "B15",
          block: "15",
          label: "Export date",
          status: "needsReview",
          reason: `Invalid date format: "${onBoardReadingToUse.value}"`,
        })
      );
    }
  } else {
    headerFields.push(
      field_helper({
        id: "B15",
        block: "15",
        label: "Export date",
        status: "needsReview",
        reason: "Export date (on-board date) not found in documents.",
      })
    );
  }

  // B19 (Requirement 47.6): foreign port of lading from Schedule K
  const K_DATE = "Schedule K (CBP Appendix F list of 2024-08-27 with the changes to 04/2026 from the table of 2026-08-20; later Army Corps updates not included)";
  const loadingReading = accepted.get("billOfLading.portOfLoading");
  
  if (loadingReading && loadingReading.value) {
    const loadingText = normalizeSpace(loadingReading.value);
    const k = lookupForeignPort(loadingText);
    
    if (k.kind === "one") {
      // Case 6a: one code
      const code = k.rows[0].code;
      const name = k.rows[0].name;
      const country = k.rows[0].country;
      const sources = [docSource(loadingReading), ...k.rows.map(codeTableSourceK)];
      
      let b19Field: any = {
        id: "B19",
        block: "19",
        label: "Foreign port of lading",
        value: code,
        status: "computed",
        rule: "7501 p.11, Schedule K",
        note: `${code} is "${name}" (${country}) in ${K_DATE}.`,
        sources,
      };
      
      headerFields.push(field_helper(b19Field));
    } else if (k.kind === "several") {
      // Case 6b: several codes
      const distinctCodes = new Map<string, typeof k.rows[0]>();
      for (const row of k.rows) {
        if (!distinctCodes.has(row.code)) {
          distinctCodes.set(row.code, row);
        }
      }
      
      const candidateRows = Array.from(distinctCodes.values());
      const candidates = candidateRows.map((r) => ({ value: r.code, label: `${r.code} ${r.name} (${r.country})` }));
      const sources = [docSource(loadingReading), ...k.rows.map(codeTableSourceK)];
      const reasonLines = candidateRows.map((r) => `${r.code} ${r.name} (${r.country})`).join("; ");
      
      headerFields.push(
        field_helper({
          id: "B19",
          block: "19",
          label: "Foreign port of lading",
          status: "needsReview",
          reason: `The bill of lading names "${loadingText}". ${K_DATE} has more than one code for it: ${reasonLines}. A person picks the code.`,
          sources,
          candidates,
        })
      );
    } else {
      // Case 6c: no code
      const sources: Source[] = [docSource(loadingReading)];
      let candidates: { value: string; label: string }[] | undefined;
      let reason = `The port of loading "${loadingText}" on the bill of lading is not in ${K_DATE}. A person looks up the code.`;
      
      if (k.allOther.length > 0) {
        candidates = k.allOther.map((r) => ({ value: r.code, label: `${r.code} ${r.name} (${r.country})` }));
        sources.push(...k.allOther.map(codeTableSourceK));
        const codes = k.allOther.map((r) => r.code).join(", ");
        reason += ` The 7501 instructions use the country's "All Other" code (${codes}) when the bill of lading names no port; a person decides whether it applies here.`;
      }
      
      headerFields.push(
        field_helper({
          id: "B19",
          block: "19",
          label: "Foreign port of lading",
          status: "needsReview",
          reason,
          sources,
          candidates,
        })
      );
    }
  } else {
    // Case 6d: not read
    headerFields.push(
      field_helper({
        id: "B19",
        block: "19",
        label: "Foreign port of lading",
        status: "needsReview",
        reason: "The port of loading was not read from the bill of lading. A person looks up the Schedule K code.",
      })
    );
  }

  // B20 (Requirement 47.4): U.S. port of unlading from Schedule D
  const dischargeReading = accepted.get("billOfLading.portOfDischarge");
  
  if (dischargeReading && dischargeReading.value) {
    const dischargeText = normalizeSpace(dischargeReading.value);
    const u = lookupUsPort(dischargeText);
    
    if (u.kind === "one") {
      // Case 4a: one row
      const code = u.row.code;
      const name = u.row.name;
      const sources = [docSource(dischargeReading), codeTableSourceD(u.row)];
      
      let b20Field: any = {
        id: "B20",
        block: "20",
        label: "U.S. port of unlading",
        value: code,
        status: "computed",
        rule: "7501 p.12, Schedule D",
        note: `${code} is "${name}" in Schedule D (CBP Appendix E, 2026-02-03).`,
        sources,
      };
      
      headerFields.push(field_helper(b20Field));
    } else if (u.kind === "several") {
      // Case 4b: several rows
      const candidates = u.rows.map((r) => ({ value: r.code, label: `${r.code} ${r.name}` }));
      const sources = [docSource(dischargeReading), ...u.rows.map(codeTableSourceD)];
      const reasonLines = u.rows.map((r) => `${r.code} ${r.name}`).join("; ");
      
      headerFields.push(
        field_helper({
          id: "B20",
          block: "20",
          label: "U.S. port of unlading",
          status: "needsReview",
          reason: `The bill of lading names "${dischargeText}". Schedule D has more than one code for it: ${reasonLines}. A person picks the code.`,
          sources,
          candidates,
        })
      );
    } else {
      // Case 4c: no row
      headerFields.push(
        field_helper({
          id: "B20",
          block: "20",
          label: "U.S. port of unlading",
          status: "needsReview",
          reason: `The port of discharge "${dischargeText}" on the bill of lading is not a port in Schedule D (CBP Appendix E, 2026-02-03). A person looks up the code.`,
          sources: [docSource(dischargeReading)],
        })
      );
    }
  } else {
    // Case 4d: not read
    headerFields.push(
      field_helper({
        id: "B20",
        block: "20",
        label: "U.S. port of unlading",
        status: "needsReview",
        reason: "The port of discharge was not read from the bill of lading. A person looks up the Schedule D code.",
      })
    );
  }

  // B6: filled from B20 (Requirement 47.5)
  const b20Field = headerFields.find((f) => f.id === "B20")!;
  const b6Idx = headerFields.findIndex((f) => f.id === "B6");
  if (b6Idx !== -1) {
    const b20Sources = b20Field.sources;
    const b20Candidates = b20Field.candidates;
    
    if (b20Field.status === "computed" && b20Field.value) {
      // B20 has one code
      let candidate: { value: string; label: string } | undefined;
      const codeTableSource = b20Sources.find((s) => s.kind === "codeTable") as any;
      if (b20Candidates && b20Candidates.length > 0) {
        candidate = { value: b20Field.value, label: b20Candidates[0].label };
      } else if (codeTableSource) {
        candidate = { value: b20Field.value, label: `${b20Field.value} ${codeTableSource.name}` };
      }
      
      headerFields[b6Idx] = field_helper({
        id: "B6",
        block: "6",
        label: "Port code",
        value: b20Field.value,
        status: "needsReview",
        reason: "Block 6 is the port where the entry is filed. It is the port of unlading (Block 20) unless the goods moved in bond to another port, so the Block 20 code is suggested. A person confirms it or enters the port of entry.",
        sources: b20Sources,
        inputs: ["B20"],
        candidates: candidate ? [candidate] : undefined,
      });
    } else if (b20Field.status === "needsReview" && b20Candidates && b20Candidates.length > 0) {
      // B20 has several codes
      headerFields[b6Idx] = field_helper({
        id: "B6",
        block: "6",
        label: "Port code",
        status: "needsReview",
        reason: "Block 6 is the port where the entry is filed. Schedule D has more than one code for the port of discharge, so a person picks it.",
        sources: b20Sources,
        inputs: ["B20"],
        candidates: b20Candidates,
      });
    } else {
      // B20 gave no code
      headerFields[b6Idx] = field_helper({
        id: "B6",
        block: "6",
        label: "Port code",
        status: "needsReview",
        reason: "Block 6 is the port where the entry is filed. The port of discharge gave no Schedule D code, so a person enters it.",
        sources: b20Sources,
        inputs: ["B20"],
      });
    }
  }

  // B25: personInput
  headerFields.push(
    field_helper({
      id: "B25",
      block: "25",
      label: "Location of goods / G.O. number",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B26: personInput
  headerFields.push(
    field_helper({
      id: "B26",
      block: "26",
      label: "Consignee number",
      status: "personInput",
      reason: "Tax and CBP identifiers are never read or stored.",
    })
  );

  // B27: personInput
  headerFields.push(
    field_helper({
      id: "B27",
      block: "27",
      label: "Importer number",
      status: "personInput",
      reason: "Tax and CBP identifiers are never read or stored.",
    })
  );

  // B28: personInput
  headerFields.push(
    field_helper({
      id: "B28",
      block: "28",
      label: "Reference number",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B29: copied from shipTo
  const shipToNameReading = accepted.get("invoice.shipTo.name");
  const shipToAddressReading = accepted.get("invoice.shipTo.address");
  if (shipToNameReading && shipToNameReading.value && shipToAddressReading && shipToAddressReading.value) {
    const shipToValue = combine(normalizeSpace(shipToNameReading.value), normalizeSpace(shipToAddressReading.value));
    headerFields.push(
      field_helper({
        id: "B29",
        block: "29",
        label: "Ultimate consignee",
        value: shipToValue,
        status: "copied",
        sources: [docSource(shipToNameReading), docSource(shipToAddressReading)],
      })
    );
  } else {
    headerFields.push(
      field_helper({
        id: "B29",
        block: "29",
        label: "Ultimate consignee",
        status: "needsReview",
        reason: "Ship-to name or address not found in documents.",
      })
    );
  }

  // B30: copied from buyer
  const buyerNameReading = accepted.get("invoice.buyer.name");
  const buyerAddressReading = accepted.get("invoice.buyer.address");
  if (buyerNameReading && buyerNameReading.value && buyerAddressReading && buyerAddressReading.value) {
    const buyerValue = combine(normalizeSpace(buyerNameReading.value), normalizeSpace(buyerAddressReading.value));
    headerFields.push(
      field_helper({
        id: "B30",
        block: "30",
        label: "Importer of record",
        value: buyerValue,
        status: "copied",
        sources: [docSource(buyerNameReading), docSource(buyerAddressReading)],
      })
    );
  } else {
    headerFields.push(
      field_helper({
        id: "B30",
        block: "30",
        label: "Importer of record",
        status: "needsReview",
        reason: "Buyer name or address not found in documents.",
      })
    );
  }

  // B36C: personInput
  headerFields.push(
    field_helper({
      id: "B36C",
      block: "36C",
      label: "Relationship (related party Y/N)",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B40: personInput
  headerFields.push(
    field_helper({
      id: "B40",
      block: "40",
      label: "Declaration (importer or agent)",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B45: personInput
  headerFields.push(
    field_helper({
      id: "B45",
      block: "45",
      label: "Declarant name, title, signature, date",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B46: personInput
  headerFields.push(
    field_helper({
      id: "B46",
      block: "46",
      label: "Broker / filer information",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B47: personInput
  headerFields.push(
    field_helper({
      id: "B47",
      block: "47",
      label: "Broker / importer file number",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // Build 7501 lines by grouping invoice lines
  // Key = "${hts_digits or "raw:" + printed}|${origin or "unknown-origin-" + n}"
  // Each group becomes one 7501 line

  interface LineGroup {
    key: string;
    htsRaw: string | null; // printed HTS from invoice
    origin: string | null; // origin code or null
    invoiceLines: number[]; // invoice line numbers in group (1-indexed)
    descriptions: string[]; // descriptions in group
    amountsCents: (number | null)[]; // amounts in cents (some may be null if P1 failed)
  }

  const partsList = input.partsList ?? null;
  const partsByLine = new Map<number, LineParts>();

  const lineGroups = new Map<string, LineGroup>();

  // Group invoice lines by HTS and origin
  for (let n = 1; n <= 8; n++) {
    // An invoice line with no reading at all is not on the documents, so it gets no 7501 line.
    // A line whose readings were all rejected still gets one, so a person sees it.
    if (!verified.some((r) => r.field.startsWith(`invoice.lines.${n}.`))) continue;

    const htsReading = accepted.get(`invoice.lines.${n}.hts`);
    const originReading = accepted.get(`invoice.lines.${n}.origin`);
    const descReading = accepted.get(`invoice.lines.${n}.description`);
    const amountReading = accepted.get(`invoice.lines.${n}.amount`);

    const htsRaw = htsReading && htsReading.value ? normalizeSpace(htsReading.value) : null;
    const origin = originReading && originReading.value ? normalizeSpace(originReading.value) : null;
    const desc = descReading && descReading.value ? normalizeSpace(descReading.value) : null;

    // Parse amount
    let amountCents: number | null = null;
    if (amountReading && amountReading.value) {
      const amtResult = parseMoneyToCents(normalizeSpace(amountReading.value));
      if (amtResult.ok) amountCents = amtResult.value;
    }

    // Try to parse origin to country code
    let originCode: string | null = null;
    if (origin) {
      const originResult = countryCode(origin);
      if (originResult.ok) {
        originCode = originResult.value;
      }
    }

    // A customer parts list may give this line's HTS number and origin (Requirement 46)
    let usedHts = htsRaw;
    let usedOrigin = originCode;
    let htsDiffers = false;
    let originDiffers = false;
    if (partsList) {
      const itemValue = accepted.get(`invoice.lines.${n}.itemNo`)?.value ?? null;
      const code = itemValue ? normalizeSpace(itemValue) : null;
      const parts = linePartsInfo(partsList, n, code, htsRaw, !!originReading, originCode);
      partsByLine.set(n, parts);
      if (parts.hts.kind === "list") usedHts = parts.hts.entry;
      if (parts.hts.kind === "differs") {
        usedHts = null;
        htsDiffers = true;
      }
      if (parts.origin.kind === "list") usedOrigin = parts.origin.code;
      if (parts.origin.kind === "differs") {
        usedOrigin = null;
        originDiffers = true;
      }
    }

    // Build group key
    const htsKey = htsDiffers ? `differs:${n}` : usedHts || `raw:${n}`;
    let groupKey: string;
    if (originDiffers) {
      groupKey = `${htsKey}|origin-differs-${n}`;
    } else if (usedOrigin) {
      groupKey = `${htsKey}|${usedOrigin}`;
    } else if (origin) {
      // Origin rejected; give each rejected origin its own group
      groupKey = `${htsKey}|unknown-origin-${n}`;
    } else {
      // No origin at all
      groupKey = `${htsKey}|unknown-origin-${n}`;
    }

    if (!lineGroups.has(groupKey)) {
      lineGroups.set(groupKey, {
        key: groupKey,
        htsRaw: usedHts,
        origin: usedOrigin,
        invoiceLines: [],
        descriptions: [],
        amountsCents: [],
      });
    }

    const group = lineGroups.get(groupKey)!;
    group.invoiceLines.push(n);
    if (desc) group.descriptions.push(desc);
    group.amountsCents.push(amountCents);
  }

  const draftLines: DraftLine[] = [];
  let lineNumber = 1;
  const allOrigins: string[] = []; // For B10

  // Parse packing list by item for allocation: build map of itemNo -> [{carton, quantity, grossKg, reading}]
  // Also collect gross kg tenths and readings for each item
  // Requirement 33.4: quantity is optional (used only for reference, not for allocation)
  const packingByItemNo2 = new Map<
    string,
    Array<{
      carton: number;
      quantity: number | null;
      grossKg: number;
      grossKgReading: VerifiedReading;
    }>
  >();
  for (let n = 1; n <= 8; n++) {
    const itemField = `packingList.lines.${n}.itemNo`;
    const qtyField = `packingList.lines.${n}.quantity`;
    const grossField = `packingList.lines.${n}.grossKg`;

    const itemReading = accepted.get(itemField);
    const qtyReading = accepted.get(qtyField);
    const grossReading = accepted.get(grossField);

    if (itemReading && itemReading.value && grossReading && grossReading.value) {
      const itemNo = normalizeSpace(itemReading.value);
      const qtyResult = qtyReading && qtyReading.value ? parseCount(normalizeSpace(qtyReading.value)) : null;
      const grossResult = parseKgToTenths(normalizeSpace(grossReading.value));

      if (grossResult.ok) {
        const quantity = qtyResult && qtyResult.ok ? qtyResult.value : null;
        if (!packingByItemNo2.has(itemNo)) {
          packingByItemNo2.set(itemNo, []);
        }
        packingByItemNo2.get(itemNo)!.push({
          carton: n,
          quantity,
          grossKg: grossResult.value,
          grossKgReading: grossReading,
        });
      }
    }
  }

  // Helper function: generate reason when no invoice line of a 7501 line has an accepted HTS (Requirement 38.2)
  const htsNotRead = (invoiceLines: number[]): string => {
    const parts: string[] = [];
    for (const n of invoiceLines) {
      const r = verified.find((v) => v.field === `invoice.lines.${n}.hts`);
      if (!r) {
        parts.push(`The HTS number of invoice line ${n} was not read.`);
      } else if (r.status === "rejected") {
        const v = normalizeSpace(r.value ?? "");
        const message = r.message || "not found";
        parts.push(`Invoice line ${n}: the reader suggested "${v}" but it was rejected: ${message}`);
      } else if (r.status === "uncertain") {
        const v = normalizeSpace(r.value ?? "");
        parts.push(`Invoice line ${n}: the AI reader read "${v}" but was not sure.`);
      }
      // Push parts list sentence if present
      const partsHts = partsByLine.get(n)?.hts;
      if (partsHts?.kind === "none" && partsHts.sentence) {
        parts.push(partsHts.sentence);
      }
    }
    return parts.join(" ") + " A person reads it on the invoice. The app does not choose a number.";
  };

  // Helper function: derive net quantity for a 7501 line by the first rule (Requirement 31.1)
  const deriveNetQuantity = (
    lineNum: string,
    invoiceLines: number[],
    htsLookup: ReturnType<typeof lookupHts>
  ): DraftField => {
    const id = `L${lineNum}.35`;

    // Get HTS unit
    let htsUnit: string | null = null;
    if (htsLookup.found) {
      htsUnit = htsLookup.unit;
    }

    // Check for P3 quantity mismatch (Requirement 33.2)
    let quantityMismatchReason: string | null = null;
    for (const n of invoiceLines) {
      const invQtyReading = accepted.get(`invoice.lines.${n}.quantity`);
      const itemReading = accepted.get(`invoice.lines.${n}.itemNo`);

      if (invQtyReading && invQtyReading.value) {
        const invQtyResult = parseCount(normalizeSpace(invQtyReading.value));
        const itemNo = itemReading && itemReading.value ? normalizeSpace(itemReading.value) : null;

        if (invQtyResult.ok) {
          const problem = packingQuantityProblem(n, itemNo, invQtyResult.value);
          if (problem) {
            quantityMismatchReason = problem.reason;
            break;
          }
        }
      }
    }

    if (quantityMismatchReason) {
      return field_helper({
        id,
        block: "35",
        line: lineNum,
        label: "Net quantity in HTS units",
        status: "needsReview",
        unit: htsUnit,
        reason: quantityMismatchReason,
      });
    } else if (!htsLookup.found) {
      // HTS not found, can't get unit or compute
      // Check if any invoice line has an accepted HTS (Requirement 38.2)
      const hasAcceptedHts = invoiceLines.some((n) => accepted.get(`invoice.lines.${n}.hts`) || partsByLine.get(n)?.hts.kind === "list");
      
      // Check if any line has differs (conflict)
      const hasDiffers = invoiceLines.some((n) => partsByLine.get(n)?.hts.kind === "differs");
      
      let reason: string;
      if (hasDiffers) {
        reason = `Waiting on L${lineNum}.33A: the invoice and the customer parts list give different HTS numbers.`;
      } else if (hasAcceptedHts) {
        reason = "Waiting on L" + lineNum + ".33A: the HTS number is not in the tariff schedule revision.";
      } else {
        reason = "Waiting on L" + lineNum + ".33A: the HTS number was not read.";
      }
      
      return field_helper({
        id,
        block: "35",
        line: lineNum,
        label: "Net quantity in HTS units",
        status: "needsReview",
        inputs: [`L${lineNum}.33A`],
        reason,
      });
    } else {
      // Parse quantities from invoice lines and convert to HTS unit
      // Requirement 33.3: Check for not-read quantities or units
      const notReadLines: number[] = [];
      for (const n of invoiceLines) {
        const qtyReading = accepted.get(`invoice.lines.${n}.quantity`);
        const unitReading = accepted.get(`invoice.lines.${n}.unit`);

        const qtyOk = qtyReading && qtyReading.value ? parseCount(normalizeSpace(qtyReading.value)).ok : false;
        const unitOk = unitReading && unitReading.value ? true : false;
        const unitValue = unitReading && unitReading.value ? normalizeSpace(unitReading.value).toUpperCase() : "";

        // Check if unit is acceptable
        const acceptedUnits = ["PCS", "PC", "EA", "PIECES", "NO.", "DZ PCS", "DOZ.", "DZ.", "KG"];
        const unitAccepted = unitOk && acceptedUnits.includes(unitValue);

        if (!qtyOk || !unitAccepted) {
          notReadLines.push(n);
        }
      }

      if (notReadLines.length > 0) {
        return field_helper({
          id,
          block: "35",
          line: lineNum,
          label: "Net quantity in HTS units",
          status: "needsReview",
          unit: htsUnit,
          reason: `The quantity or unit of invoice line ${notReadLines.join(", ")} was not read or is not a unit the draft counts, so the net quantity is not added up. A person enters it.`,
        });
      }

      let totalQuantity: number | null = null;
      const quantityReadingSources: DocSource[] = [];

      for (let i = 0; i < invoiceLines.length; i++) {
        const n = invoiceLines[i];
        const qtyReading = accepted.get(`invoice.lines.${n}.quantity`);
        const unitReading = accepted.get(`invoice.lines.${n}.unit`);

        if (qtyReading && qtyReading.value && unitReading && unitReading.value) {
          const qtyResult = parseCount(normalizeSpace(qtyReading.value));
          const invoiceUnit = normalizeSpace(unitReading.value).toUpperCase();

          if (qtyResult.ok) {
            let convertedQty: number | null = null;

            if (invoiceUnit === "PCS" || invoiceUnit === "PC" || invoiceUnit === "EA" || invoiceUnit === "PIECES") {
              convertedQty = qtyResult.value;
            } else if (invoiceUnit === "NO.") {
              convertedQty = qtyResult.value;
            } else if (invoiceUnit === "DZ PCS" || invoiceUnit === "DOZ." || invoiceUnit === "DZ.") {
              const quotient = qtyResult.value / 12;
              if (qtyResult.value % 12 === 0) {
                convertedQty = quotient;
              } else {
                convertedQty = qtyResult.value;
              }
            } else if (invoiceUnit === "KG") {
              convertedQty = qtyResult.value;
            } else {
              convertedQty = null;
            }

            if (convertedQty !== null) {
              if (totalQuantity === null) totalQuantity = 0;
              totalQuantity += convertedQty;
            }

            quantityReadingSources.push(docSource(qtyReading));
            // Add image transcript sources for unit reading (Requirement 32.3)
            if (fromImagePage(unitReading)) {
              quantityReadingSources.push(docSource(unitReading));
            }
          }
        }
      }

      if (totalQuantity !== null) {
        let displayValue = String(totalQuantity);
        if (htsUnit && htsUnit.toUpperCase() === "DZ PCS") {
          const dozenCount = totalQuantity / 12;
          if (dozenCount === Math.floor(dozenCount)) {
            displayValue = String(Math.floor(dozenCount));
          } else {
            displayValue = dozenCount.toFixed(2);
          }
        }

        // Build arithmetic note for computed quantity
        let arithmeticNote = "";
        if (invoiceLines.length === 1) {
          arithmeticNote = `${displayValue} ${htsUnit || ""}`.trim();
        } else {
          const parts: string[] = [];
          for (let i = 0; i < invoiceLines.length; i++) {
            const n = invoiceLines[i];
            const qtyReading = accepted.get(`invoice.lines.${n}.quantity`);
            if (qtyReading && qtyReading.value) {
              const qtyResult = parseCount(normalizeSpace(qtyReading.value));
              if (qtyResult.ok) {
                parts.push(String(qtyResult.value));
              }
            }
          }
          arithmeticNote = `${parts.join(" + ")} ${htsUnit || ""}`.trim();
        }

        return field_helper({
          id,
          block: "35",
          line: lineNum,
          label: "Net quantity in HTS units",
          value: displayValue,
          unit: htsUnit,
          status: "computed",
          rule: "P12",
          note: arithmeticNote,
          sources: quantityReadingSources,
        });
      } else {
        return field_helper({
          id,
          block: "35",
          line: lineNum,
          label: "Net quantity in HTS units",
          status: "needsReview",
          unit: htsUnit,
          reason: "Could not parse quantities from invoice lines.",
        });
      }
    }
  };

  // Helper function: compute duty for a 7501 line (Requirement 32.2)
  const deriveDuty = (
    lineNum: string,
    enteredValueField: DraftField | undefined,
    rateField: DraftField | undefined
  ): DraftField => {
    const id = `L${lineNum}.38`;

    // Check if inputs are waiting (missing, no value, or needsReview with reason other than image reasons)
    const enteredValueWaits =
      !enteredValueField ||
      !enteredValueField.value ||
      (enteredValueField.status === "needsReview" &&
        enteredValueField.reason &&
        !isImageReviewReason(enteredValueField.reason));

    const rateWaits =
      !rateField ||
      !rateField.value ||
      (rateField.status === "needsReview" &&
        rateField.reason &&
        !isImageReviewReason(rateField.reason));

    if (enteredValueWaits) {
      return field_helper({
        id,
        block: "38",
        line: lineNum,
        label: "Duty (USD)",
        status: "needsReview",
        inputs: [`L${lineNum}.36A`, `L${lineNum}.37A`],
        reason: `Waiting on L${lineNum}.36A.`,
      });
    } else if (rateWaits) {
      return field_helper({
        id,
        block: "38",
        line: lineNum,
        label: "Duty (USD)",
        status: "needsReview",
        inputs: [`L${lineNum}.36A`, `L${lineNum}.37A`],
        reason: `Waiting on L${lineNum}.37A.`,
      });
    } else {
      // Both value and rate are available, compute duty
      const enteredDollars = parseInt(enteredValueField!.value!, 10);
      const dutyResult = computeDuty(rateField!.value!, enteredDollars * 100);

      if (!dutyResult.ok) {
        return field_helper({
          id,
          block: "38",
          line: lineNum,
          label: "Duty (USD)",
          status: "needsReview",
          inputs: [`L${lineNum}.36A`, `L${lineNum}.37A`],
          reason: dutyResult.reason,
        });
      } else {
        const dutyFormatted = formatCents(dutyResult.value);
        const rateValue = rateField!.value! || "0%";
        const enteredValueStr = enteredValueField!.value! || "0";
        const note = `${rateValue} x ${enteredValueStr} = ${dutyFormatted}`;
        return field_helper({
          id,
          block: "38",
          line: lineNum,
          label: "Duty (USD)",
          value: dutyFormatted,
          status: "computed",
          rule: "P7",
          note,
          inputs: [`L${lineNum}.36A`, `L${lineNum}.37A`],
        });
      }
    }
  };

  // Process each group
  for (const group of lineGroups.values()) {
    const lineNum = String(lineNumber).padStart(3, "0");
    const lineFields: DraftField[] = [];

    // L<nnn>.10: country of origin
    {
      const id = `L${lineNum}.10`;
      let field: DraftField;

      if (group.origin) {
        // All have accepted origin
        const sources = group.invoiceLines
          .map((n) => {
            const r = accepted.get(`invoice.lines.${n}.origin`);
            return r ? docSource(r) : null;
          })
          .filter((s): s is DocSource => s !== null);

        // Add sources from parts list if any lines have "list" or "same" origin
        const listOriginSources = group.invoiceLines
          .flatMap((n) => {
            const parts = partsByLine.get(n);
            if (parts?.origin.kind === "list" || parts?.origin.kind === "same") {
              return [parts.origin.source];
            }
            return [];
          });
        sources.push(...listOriginSources);

        const note = listOriginSources.length > 0
          ? group.invoiceLines
              .filter((n) => {
                const parts = partsByLine.get(n);
                return parts?.origin.kind === "list" || parts?.origin.kind === "same";
              })
              .map((n) => {
                const parts = partsByLine.get(n)!;
                return parts.origin.kind === "list" || parts.origin.kind === "same" ? parts.origin.note : "";
              })
              .filter(Boolean)
              .join(" ")
          : null;

        field = field_helper({
          id,
          block: "10",
          line: lineNum,
          label: "Country of origin",
          value: group.origin,
          status: "copied",
          sources,
          note,
        });
      } else {
        // No accepted origin
        const reasons: string[] = [];
        const listOriginSources: DocSource[] = [];
        for (const n of group.invoiceLines) {
          const parts = partsByLine.get(n);
          if (parts?.origin.kind === "differs") {
            reasons.push(parts.origin.reason);
            // Both sides: the invoice origin reading, then the list cell
            const invoiceOrigin = accepted.get(`invoice.lines.${n}.origin`);
            if (invoiceOrigin) listOriginSources.push(docSource(invoiceOrigin));
            listOriginSources.push(parts.origin.source);
          } else {
            const r = accepted.get(`invoice.lines.${n}.origin`);
            if (r && r.value) {
              const originStr = normalizeSpace(r.value);
              const codeResult = countryCode(originStr);
              if (!codeResult.ok) {
                reasons.push(
                  `Invoice line ${n}: the AI reader read "${originStr}", which is not a country name or code the app knows. A person checks it on the invoice.`
                );
              }
            } else {
              const originReading = verified.find(
                (r): r is Extract<VerifiedReading, { status: "rejected" | "uncertain" }> =>
                  r.field === `invoice.lines.${n}.origin` && (r.status === "rejected" || r.status === "uncertain")
              );
              if (originReading) {
                const v = normalizeSpace(originReading.value ?? "");
                if (originReading.status === "uncertain") {
                  reasons.push(`Invoice line ${n}: the AI reader read "${v}" but was not sure. A person checks it on the invoice.`);
                } else {
                  // rejected
                  if (originReading.reason === "quote_not_found") {
                    reasons.push(`Invoice line ${n}: the reader suggested "${v}" but its quote is not on the page, so it was rejected.`);
                  } else {
                    reasons.push(`Invoice line ${n}: the reader suggested "${v}" but it was rejected: ${originReading.message}`);
                  }
                }
              } else {
                reasons.push(`Line ${n}: no origin reading.`);
              }
            }
          }
        }

        const sources = listOriginSources;

        field = field_helper({
          id,
          block: "10",
          line: lineNum,
          label: "Country of origin",
          status: "needsReview",
          reason: reasons.length > 0 ? reasons.join(" ") : "Country of origin missing.",
          sources,
        });
      }

      lineFields.push(field);
      if (group.origin) {
        allOrigins.push(group.origin);
      }
    }

    // L<nnn>.32: description
    {
      const id = `L${lineNum}.32`;
      const desc = group.descriptions.join("; ");

      const sources = group.invoiceLines
        .map((n) => {
          const r = accepted.get(`invoice.lines.${n}.description`);
          return r ? docSource(r) : null;
        })
        .filter((s): s is DocSource => s !== null);

      // Find invoice lines whose description reading was not accepted
      const missing = group.invoiceLines.filter((n) => !accepted.get(`invoice.lines.${n}.description`));

      let field: DraftField;
      if (missing.length === 0) {
        // All descriptions accepted
        field = field_helper({
          id,
          block: "32",
          line: lineNum,
          label: "Description of merchandise",
          value: desc,
          status: "copied",
          sources,
        });
      } else {
        // Some descriptions were not accepted
        field = field_helper({
          id,
          block: "32",
          line: lineNum,
          label: "Description of merchandise",
          status: "needsReview",
          reason: `The description of invoice line ${missing.join(", ")} was not accepted from the reading, so it is left empty. A person reads it on the invoice.`,
          sources,
        });
      }

      lineFields.push(field);
    }

    // Lookup HTS once for use in multiple fields (.33A, .35, .37A, .ch99)
    const htsLookup = lookupHts(hts, group.htsRaw || "");

    // L<nnn>.33A: HTS number
    {
      const id = `L${lineNum}.33A`;

      const htsReadingSources = group.invoiceLines
        .map((n) => {
          const r = accepted.get(`invoice.lines.${n}.hts`);
          return r ? docSource(r) : null;
        })
        .filter((s): s is DocSource => s !== null);

      // Collect parts list sources
      const listHtsSources = group.invoiceLines
        .flatMap((n) => {
          const parts = partsByLine.get(n);
          if (parts && (parts.hts.kind === "list" || parts.hts.kind === "same" || parts.hts.kind === "differs")) {
            return [parts.hts.source];
          }
          return [];
        });

      let field: DraftField;
      if (htsLookup.found) {
        const htsSource: HtsSource = {
          kind: "hts",
          revision: hts.revision,
          htsno: htsLookup.row.htsno,
        };
        const rowDesc = htsLookup.row.description || "";
        
        // Build note with parts list information
        const listNotes = group.invoiceLines
          .flatMap((n) => {
            const parts = partsByLine.get(n);
            if (parts && (parts.hts.kind === "list" || parts.hts.kind === "same")) {
              return [parts.hts.note];
            }
            return [];
          });
        
        const note = listNotes.length > 0
          ? `${listNotes.join(" ")} Found in ${hts.revisionTitle}: ${rowDesc}`
          : `Found in ${hts.revisionTitle}: ${rowDesc}`;
        
        field = field_helper({
          id,
          block: "33A",
          line: lineNum,
          label: "HTS number",
          value: htsLookup.number.entry,
          status: "copied",
          rule: "P15",
          note,
          sources: [...htsReadingSources, ...listHtsSources, htsSource],
        });
      } else {
        // Check if any invoice line of this 7501 line has an accepted HTS (Requirement 38.2)
        const hasAcceptedHts = group.invoiceLines.some((n) => accepted.get(`invoice.lines.${n}.hts`) || partsByLine.get(n)?.hts.kind === "list");
        
        // Check if any line has differs (conflict)
        const differsList = group.invoiceLines
          .filter((n) => partsByLine.get(n)?.hts.kind === "differs")
          .map((n) => partsByLine.get(n)!.hts as Extract<LineParts["hts"], { kind: "differs" }>);
        
        let reason: string;
        if (differsList.length > 0) {
          reason = differsList.map(d => d.reason).join(" ");
        } else if (!hasAcceptedHts) {
          reason = htsNotRead(group.invoiceLines);
        } else {
          reason = `${htsLookup.reason} The app does not choose a number.`;
        }
        field = field_helper({
          id,
          block: "33A",
          line: lineNum,
          label: "HTS number",
          status: "needsReview",
          rule: "P15",
          reason,
          sources: [...htsReadingSources, ...listHtsSources],
        });
      }

      lineFields.push(field);
    }

    // L<nnn>.34A: gross weight (kg) — allocated after all lines built

    // L<nnn>.35: net quantity
    lineFields.push(deriveNetQuantity(lineNum, group.invoiceLines, htsLookup));

    // L<nnn>.36A: entered value (whole dollars)
    {
      const id = `L${lineNum}.36A`;

      // Check P1: any P1 mismatch in group?
      let p1MismatchReason: string | null = null;
      for (const n of group.invoiceLines) {
        const p1Check = checks.find((c) => c.id === `P1.invoice.line.${n}`);
        if (p1Check && !p1Check.ok) {
          p1MismatchReason = p1Check.detail;
          break;
        }
      }

      // Check currency
      const currencyReading = accepted.get("invoice.currency");
      let isCurrencyOk = true;
      if (currencyReading && currencyReading.value) {
        const curr = normalizeSpace(currencyReading.value).toUpperCase();
        if (curr !== "USD") {
          isCurrencyOk = false;
        }
      }

      if (!currencyReading || !currencyReading.value || normalizeSpace(currencyReading.value) === "") {
        lineFields.push(
          field_helper({
            id,
            block: "36A",
            line: lineNum,
            label: "Entered value (USD)",
            status: "needsReview",
            reason: "No invoice currency was read. A person checks that the amounts are in USD and enters the entered value.",
          })
        );
      } else if (!isCurrencyOk) {
        lineFields.push(
          field_helper({
            id,
            block: "36A",
            line: lineNum,
            label: "Entered value (USD)",
            status: "needsReview",
            reason: "Currency is not USD.",
          })
        );
      } else if (p1MismatchReason) {
        lineFields.push(
          field_helper({
            id,
            block: "36A",
            line: lineNum,
            label: "Entered value (USD)",
            status: "needsReview",
            reason: `P1 mismatch: ${p1MismatchReason} A person decides.`,
            sources: group.invoiceLines
              .map((n) => {
                const r = accepted.get(`invoice.lines.${n}.amount`);
                return r ? docSource(r) : null;
              })
              .filter((s): s is DocSource => s !== null),
          })
        );
      } else {
        // Sum amounts in cents, round to whole dollars
        // Check for missing amounts first (Requirement 27.2)
        const missing = group.invoiceLines.filter((n, i) => group.amountsCents[i] === null);

        if (missing.length > 0) {
          const amountSources: DocSource[] = [];
          for (let i = 0; i < group.invoiceLines.length; i++) {
            const n = group.invoiceLines[i];
            const r = accepted.get(`invoice.lines.${n}.amount`);
            if (r) amountSources.push(docSource(r));
          }

          lineFields.push(
            field_helper({
              id,
              block: "36A",
              line: lineNum,
              label: "Entered value (USD)",
              status: "needsReview",
              reason: `No accepted amount for invoice line ${missing.join(", ")}. A person enters the entered value.`,
              sources: amountSources,
            })
          );
        } else {
          let totalCents = 0;
          const amountSources: DocSource[] = [];

          for (let i = 0; i < group.invoiceLines.length; i++) {
            const n = group.invoiceLines[i];
            const amountCents = group.amountsCents[i];

            if (amountCents !== null) {
              totalCents += amountCents;
            }

            const r = accepted.get(`invoice.lines.${n}.amount`);
            if (r) amountSources.push(docSource(r));
          }

          const roundedValue = roundEnteredValue(totalCents);
          if (!roundedValue.ok) {
            lineFields.push(
              field_helper({
                id,
                block: "36A",
                line: lineNum,
                label: "Entered value (USD)",
                status: "needsReview",
                reason: roundedValue.reason,
                sources: amountSources,
              })
            );
          } else {
            lineFields.push(
              field_helper({
                id,
                block: "36A",
                line: lineNum,
                label: "Entered value (USD)",
                value: String(roundedValue.value),
                status: "computed",
                rule: "P4",
                note: "Nothing was deducted. A person confirms the entered value.",
                sources: fromImagePage(currencyReading) 
                  ? [...amountSources, docSource(currencyReading)]
                  : amountSources,
              })
            );
          }
        }
      }
    }

    // L<nnn>.37A: HTS rate
    {
      const id = `L${lineNum}.37A`;

      if (!htsLookup.found) {
        // Check if any invoice line has an accepted HTS (Requirement 38.2)
        const hasAcceptedHts = group.invoiceLines.some((n) => accepted.get(`invoice.lines.${n}.hts`) || partsByLine.get(n)?.hts.kind === "list");
        
        // Check if any line has differs (conflict)
        const hasDiffers = group.invoiceLines.some((n) => partsByLine.get(n)?.hts.kind === "differs");
        
        let reason: string;
        if (hasDiffers) {
          reason = `Waiting on L${lineNum}.33A: the invoice and the customer parts list give different HTS numbers.`;
        } else if (hasAcceptedHts) {
          reason = "Waiting on L" + lineNum + ".33A: the HTS number is not in the tariff schedule revision.";
        } else {
          reason = "Waiting on L" + lineNum + ".33A: the HTS number was not read.";
        }
        
        lineFields.push(
          field_helper({
            id,
            block: "37A",
            line: lineNum,
            label: "HTS rate",
            status: "needsReview",
            inputs: [`L${lineNum}.33A`],
            reason,
          })
        );
      } else if (!group.origin) {
        // Origin unknown
        const generalRate = htsLookup.rateText || "unknown";
        lineFields.push(
          field_helper({
            id,
            block: "37A",
            line: lineNum,
            label: "HTS rate",
            status: "needsReview",
            inputs: [`L${lineNum}.10`],
            reason: `Origin unknown. General rate would be: ${generalRate}`,
          })
        );
      } else if (config.column2Countries.includes(group.origin)) {
        // Column 2 country (embargo)
        lineFields.push(
          field_helper({
            id,
            block: "37A",
            line: lineNum,
            label: "HTS rate",
            status: "needsReview",
            reason: `Origin ${group.origin} is a Column 2 country. Rate lookup not built.`,
          })
        );
      } else {
        // Check if rate is computable (Free or percentage)
        const dutyTest = computeDuty(htsLookup.rateText, 0);
        if (!dutyTest.ok) {
          lineFields.push(
            field_helper({
              id,
              block: "37A",
              line: lineNum,
              label: "HTS rate",
              status: "needsReview",
              reason: `Rate "${htsLookup.rateText}" is not Free or a simple percentage. A person decides.`,
            })
          );
        } else {
          const rateSource: HtsSource = {
            kind: "hts",
            revision: hts.revision,
            htsno: htsLookup.rateFrom,
          };
          const rule = htsLookup.rateFrom !== htsLookup.row.htsno ? "P16" : null;

          lineFields.push(
            field_helper({
              id,
              block: "37A",
              line: lineNum,
              label: "HTS rate",
              value: htsLookup.rateText,
              status: "copied",
              rule,
              note: `General rate of ${htsLookup.rateFrom}.`,
              sources: [rateSource],
            })
          );
        }
      }
    }

    // L<nnn>.38: duty
    {
      const enteredValueField = lineFields.find((f) => f.id === `L${lineNum}.36A`);
      const rateField = lineFields.find((f) => f.id === `L${lineNum}.37A`);
      lineFields.push(deriveDuty(lineNum, enteredValueField, rateField));
    }

    // L<nnn>.ch99: Chapter 99 additional duty (if applicable)
    if (htsLookup.found && htsLookup.chapter99.length > 0) {
      const id = `L${lineNum}.ch99`;

      const htsSource: HtsSource = {
        kind: "hts",
        revision: hts.revision,
        htsno: htsLookup.row.htsno,
      };

      lineFields.push(
        field_helper({
          id,
          block: "38",
          line: lineNum,
          label: "Chapter 99 additional duty (USD)",
          unit: null,
          status: "needsReview",
          reason: chapter99Reason(htsLookup.chapter99),
          sources: [htsSource],
        })
      );
    }

    // Add placeholder for L<nnn>.34A (will be populated after all lines)
    const grossWeightField = field_helper({
      id: `L${lineNum}.34A`,
      block: "34A",
      line: lineNum,
      label: "Gross weight (kg)",
      unit: "kg",
      status: "computed",
      rule: "P11",
    });
    lineFields.unshift(grossWeightField); // Insert after origin but we'll fix later

    // Reorder: .10, .32, .33A, .34A, .35, .36A, .37A, .38, .ch99
    const reordered: DraftField[] = [];
    const fieldsByBlock: Record<string, DraftField> = {};
    for (const f of lineFields) {
      fieldsByBlock[`${f.block}|${f.id}`] = f;
    }

    const blockOrder = ["10", "32", "33A", "34A", "35", "36A", "37A", "38"];
    for (const block of blockOrder) {
      const key = Object.keys(fieldsByBlock).find((k) => k.startsWith(`${block}|`));
      if (key) {
        reordered.push(fieldsByBlock[key]);
        delete fieldsByBlock[key];
      }
    }
    // Add any .ch99 at the end
    for (const key in fieldsByBlock) {
      if (key.includes(".ch99")) {
        reordered.push(fieldsByBlock[key]);
        delete fieldsByBlock[key];
      }
    }

    draftLines.push({
      lineNumber: lineNum,
      invoiceLines: group.invoiceLines,
      fields: reordered,
    });

    lineNumber++;
  }

  // Now populate L<nnn>.34A with allocated gross weights
  {
    const totalGrossReading = accepted.get("packingList.totalGrossKg");
    
    // For rule 36.4a, check if there's an uncertain reading too
    const totalGrossAny = verified.find((r) => r.field === "packingList.totalGrossKg" && (r.status === "accepted" || r.status === "uncertain"));
    
    // Rule 38.4(a): total gross weight was not read (rejected or not a weight)
    // Also rule 36.4(a): "uncertain" reading  
    if (!totalGrossReading || !totalGrossReading.value || normalizeSpace(totalGrossReading.value) === "") {
      // No accepted reading at all
      const isUncertain = totalGrossAny?.status === "uncertain";
      for (const draftLine of draftLines) {
        const grossField = draftLine.fields.find((f) => f.id.endsWith(".34A"));
        if (grossField) {
          grossField.status = "needsReview";
          grossField.value = null;
          if (isUncertain) {
            // Requirement 36.4(a): "uncertain" reading - build reason with optional BoL reference
            const readValue = normalizeSpace(totalGrossAny.value ?? "");
            let reason = `The AI reader read the packing list total gross weight as ${readValue} kg but was not sure, so it is not used. A person checks it and enters the gross weight.`;
            
            // Check for BoL reading (Requirement 36.4a part 2)
            const bilReading = verified.find((r) => r.field === "billOfLading.grossKg" && (r.status === "accepted" || r.status === "uncertain"));
            if (bilReading && bilReading.value) {
              const bilValue = normalizeSpace(bilReading.value ?? "");
              const bilParsed = parseKgToTenths(normalizeSpace(bilValue));
              const pkgParsed = parseKgToTenths(normalizeSpace(readValue));
              if (bilParsed.ok && pkgParsed.ok && Math.abs(bilParsed.value - pkgParsed.value) > 1) {
                reason = `The AI reader read the packing list total gross weight as ${readValue} kg but was not sure, so it is not used. The bill of lading says ${bilValue} kg. A person checks it and enters the gross weight.`;
              }
            }
            grossField.reason = reason;
            grossField.sources = [docSource(totalGrossAny)];
          } else {
            grossField.reason = "No total gross weight was read from the packing list. A person enters the gross weight.";
            grossField.sources = totalGrossAny ? [docSource(totalGrossAny)] : [];
          }
        }
      }
    } else if (!parseKgToTenths(normalizeSpace(totalGrossReading.value)).ok) {
      // Reading exists but cannot be parsed
      const tg = totalGrossReading!;
      for (const draftLine of draftLines) {
        const grossField = draftLine.fields.find((f) => f.id.endsWith(".34A"));
        if (grossField) {
          grossField.status = "needsReview";
          grossField.value = null;
          grossField.reason = "No total gross weight was read from the packing list. A person enters the gross weight.";
          grossField.sources = [docSource(tg)];
        }
      }
    } else {
      // Reading is valid, proceed with allocation
      const totalGrossResult = parseKgToTenths(normalizeSpace(totalGrossReading.value));
      if (!totalGrossResult.ok) throw new Error("unreachable: total gross weight checked above");
      const totalTenths = totalGrossResult.ok ? totalGrossResult.value : 0;
      
      // Build basis for each 7501 line: sum of packing list gross kg for its items
      // Also collect the individual packing list readings for sources
      const basis: number[] = [];
      const grossKgSources: DocSource[][] = [];

      for (const draftLine of draftLines) {
        let lineBasis = 0;
        const lineSources: DocSource[] = [];

        for (const invoiceN of draftLine.invoiceLines) {
          const itemReading = accepted.get(`invoice.lines.${invoiceN}.itemNo`);
          if (itemReading && itemReading.value) {
            const itemNo = normalizeSpace(itemReading.value);
            const packingLines = packingByItemNo2.get(itemNo) || [];
            for (const pLine of packingLines) {
              lineBasis += pLine.grossKg;
              lineSources.push(docSource(pLine.grossKgReading));
            }
          }
        }
        basis.push(lineBasis);
        grossKgSources.push(lineSources);
      }

      const basisSum = basis.reduce((a, b) => a + b, 0);

      // Rule 38.4: Check gross weight allocation rules in order
      // (b) total accepted, billOfLading.grossKg accepted/uncertain, weights differ by > 0.1 kg
      const bilReading = verified.find((r) => r.field === "billOfLading.grossKg" && (r.status === "accepted" || r.status === "uncertain"));
      const bilParsed = bilReading && bilReading.value ? parseKgToTenths(normalizeSpace(bilReading.value)) : null;
      const bilDiffers = !!bilParsed && bilParsed.ok && Math.abs(bilParsed.value - totalTenths) > 1;

      // (c) a packing list line has at least one reading but no accepted item number or no accepted gross weight
      const unreadyPackingLines: number[] = [];
      for (let n = 1; n <= 8; n++) {
        const hasAnyReading = verified.some((r) => r.field.startsWith(`packingList.lines.${n}.`));
        if (!hasAnyReading) continue;
        
        const itemNoReading = accepted.get(`packingList.lines.${n}.itemNo`);
        const grossKgReading = accepted.get(`packingList.lines.${n}.grossKg`);
        
        const hasItemNo = itemNoReading && itemNoReading.value;
        const hasGrossKg = grossKgReading && grossKgReading.value && parseKgToTenths(normalizeSpace(grossKgReading.value)).ok;
        
        if (!hasItemNo || !hasGrossKg) {
          unreadyPackingLines.push(n);
        }
      }

      if (bilDiffers) {
        // Rule 38.4(b): weights differ
        const tg = totalGrossReading!;
        for (const draftLine of draftLines) {
          const grossField = draftLine.fields.find((f) => f.id.endsWith(".34A"));
          if (grossField) {
            grossField.status = "needsReview";
            grossField.value = null;
            grossField.reason = `The packing list total gross weight (${(totalTenths / 10).toFixed(1)} kg) differs from the bill of lading (${(bilParsed!.value / 10).toFixed(1)} kg). A person decides.`;
            grossField.sources = [docSource(tg)];
          }
        }
      } else if (unreadyPackingLines.length > 0) {
        // Rule 38.4(c): packing list line not ready
        const tg = totalGrossReading!;
        const lineList = unreadyPackingLines.join(", ");
        for (const draftLine of draftLines) {
          const grossField = draftLine.fields.find((f) => f.id.endsWith(".34A"));
          if (grossField) {
            grossField.status = "needsReview";
            grossField.value = null;
            grossField.reason = `The gross weight of packing list line ${lineList} was not read or the AI reader was not sure of it, so the total cannot be split over the 7501 lines. A person enters the gross weight.`;
            grossField.sources = [docSource(tg)];
          }
        }
      } else if (basisSum !== totalTenths) {
        // Rule 38.4(d): the line sums differ from the total
        const tg = totalGrossReading!;
        for (const draftLine of draftLines) {
          const grossField = draftLine.fields.find((f) => f.id.endsWith(".34A"));
          if (grossField) {
            grossField.status = "needsReview";
            grossField.reason = `Gross weight basis sum (${(basisSum / 10).toFixed(1)} kg) differs from packing list total (${(totalTenths / 10).toFixed(1)} kg).`;
            grossField.sources = [docSource(tg)];
          }
        }
      } else {
        // Allocate using largest remainder
        const tg = totalGrossReading!;
        const totalGrossKg = Math.floor((totalTenths + 5) / 10); // tenths to whole kg, half up
        const allocResult = allocateGrossWeight(totalGrossKg, basis, 0);

        if (allocResult.ok) {
          for (let i = 0; i < draftLines.length; i++) {
            const allocated = allocResult.value[i];
            const grossField = draftLines[i].fields.find((f) => f.id.endsWith(".34A"));
            if (grossField) {
              grossField.value = String(allocated.kilograms);
              if (allocated.estimated) {
                grossField.note = "Estimated";
              }
              // Use the individual packing list readings for this line's sources
              let lineSources = grossKgSources[i].length > 0 ? grossKgSources[i] : [docSource(tg)];
              // Add totalGrossKg source if it's from image (Requirement 32.3)
              if (fromImagePage(tg) && !lineSources.some(s => s.readingField === "packingList.totalGrossKg")) {
                lineSources = [...lineSources, docSource(tg)];
              }
              grossField.sources = lineSources;
            }
          }
        } else {
          // Allocation failed (e.g., all basis zero)
          for (const draftLine of draftLines) {
            const grossField = draftLine.fields.find((f) => f.id.endsWith(".34A"));
            if (grossField) {
              grossField.status = "needsReview";
              grossField.reason = allocResult.reason;
              grossField.sources = [docSource(tg)];
            }
          }
        }
      }
    }
  }

  // Build B10: country of origin block (Requirement 38.1)
  // Helper function to build B10 field
  const buildB10 = (): DraftField => {
    // Collect all L<nnn>.10 field IDs in order
    const lineOriginIds: string[] = [];
    const lineOriginValues: (string | null)[] = [];
    for (const draftLine of draftLines) {
      const originField = draftLine.fields.find((f) => f.id.endsWith(".10"));
      lineOriginIds.push(`L${draftLine.lineNumber}.10`);
      lineOriginValues.push(originField?.value || null);
    }

    // Count lines with no value
    const missingOriginIds = lineOriginIds.filter((_, i) => lineOriginValues[i] === null);
    
    // Count unique codes from lines that have values
    const codes = new Set(lineOriginValues.filter((v): v is string => v !== null));
    
    // Requirement 38.1: if any line has no value and fewer than 2 different codes exist
    if (missingOriginIds.length > 0 && codes.size < 2) {
      return field_helper({
        id: "B10",
        block: "10",
        label: "Country of origin",
        status: "needsReview",
        value: null,
        inputs: lineOriginIds,
        reason: `Waiting on ${missingOriginIds.join(", ")}.`,
      });
    }

    // Otherwise, use the existing logic
    if (codes.size === 0) {
      return field_helper({
        id: "B10",
        block: "10",
        label: "Country of origin",
        status: "needsReview",
        inputs: lineOriginIds,
        reason: "No accepted origins from lines.",
      });
    }

    if (codes.size > 1) {
      const originList = [...codes].join(", ");
      return field_helper({
        id: "B10",
        block: "10",
        label: "Country of origin",
        value: "MULTI",
        status: "computed",
        rule: "7501 p.8",
        note: `Lines come from ${originList}; each line shows its own origin.`,
        inputs: lineOriginIds,
      });
    } else {
      return field_helper({
        id: "B10",
        block: "10",
        label: "Country of origin",
        value: [...codes][0],
        status: "computed",
        rule: "7501 p.8",
        inputs: lineOriginIds,
      });
    }
  };

  const b10Field = buildB10();

  // Insert B10 after B9
  const b9Index = headerFields.findIndex((f) => f.id === "B9");
  if (b9Index >= 0) {
    headerFields.splice(b9Index + 1, 0, b10Field);
  } else {
    headerFields.push(b10Field);
  }

  // B13: Implement MID suggestion (Requirement 48.9) - before the parts list may override it
  // The rule runs after the 7501 lines exist, with their B10 (country of origin) values
  const nameReading = accepted.get("invoice.seller.name");
  const addressReading = accepted.get("invoice.seller.address");
  
  {
    // We check B13 regardless of whether name or address is accepted (Requirement 48.9a with no sources)
    const name = normalizeSpace(nameReading?.value ?? "");
    const address = normalizeSpace(addressReading?.value ?? "");
    
    if (!name || !address) {
      // 48.9a: name or address not accepted
      const b13Index = headerFields.findIndex((f) => f.id === "B13");
      if (b13Index >= 0) {
        const sources: Source[] = [];
        if (nameReading) sources.push(docSource(nameReading));
        if (addressReading) sources.push(docSource(addressReading));
        
        headerFields[b13Index] = field_helper({
          id: "B13",
          block: "13",
          label: "Manufacturer ID (MID)",
          status: "needsReview",
          rule: "7501 Appendix 2",
          reason: "The invoice issuer's name or address was not read, so no MID is suggested. A person enters the manufacturer's MID.",
          sources,
          inputs: ["B10"],
        });
      }
    } else {
      // Build MID suggestion
      const b13Index = headerFields.findIndex((f) => f.id === "B13");
      if (b13Index >= 0) {
        // 48.9b: Check if all lines have an origin (B10)
        const allLineOrigins: string[] = [];
        let anyLineHasNoOrigin = false;
        
        for (const line of draftLines) {
          const b10Field = line.fields.find((f) => f.block === "10");
          if (b10Field && b10Field.value) {
            allLineOrigins.push(b10Field.value);
          } else {
            anyLineHasNoOrigin = true;
          }
        }
        
        if (anyLineHasNoOrigin || draftLines.length === 0) {
          // 48.9b: a line without an origin
          const sources: Source[] = [];
          if (nameReading) sources.push(docSource(nameReading));
          if (addressReading) sources.push(docSource(addressReading));
          
          headerFields[b13Index] = field_helper({
            id: "B13",
            block: "13",
            label: "Manufacturer ID (MID)",
            status: "needsReview",
            rule: "7501 Appendix 2",
            reason: "The country of origin of a line is not known, so the first two letters of the MID are not known. A person enters the MID.",
            sources,
            inputs: ["B10"],
          });
        } else {
          // All lines have origins - group by origin
          const originGroups = new Map<string, string[]>();
          draftLines.forEach((line, idx) => {
            const b10 = line.fields.find((f) => f.block === "10");
            if (b10 && b10.value) {
              const origin = b10.value;
              if (!originGroups.has(origin)) {
                originGroups.set(origin, []);
              }
              originGroups.get(origin)!.push(line.lineNumber);
            }
          });
          
          const distinctOrigins = Array.from(originGroups.keys());
          
          if (distinctOrigins.length === 1) {
            // 48.9c: One origin - suggest MID
            const origin = distinctOrigins[0];
            const result = suggestMid({ name, address, origin });
            
            const sources: Source[] = [];
            if (nameReading) sources.push(docSource(nameReading));
            if (addressReading) sources.push(docSource(addressReading));
            
            if (!result.ok) {
              // MID cannot be computed
              headerFields[b13Index] = field_helper({
                id: "B13",
                block: "13",
                label: "Manufacturer ID (MID)",
                status: "needsReview",
                rule: "7501 Appendix 2",
                reason: result.reason,
                sources,
                inputs: ["B10"],
              });
            } else {
              // MID computed successfully
              const mid = result.value;
              const parts = result.parts;
              const genericPrefix = result.genericPrefix;
              const withoutGeneric = result.withoutGeneric;
              const notes = result.notes;
              
              const candidates: { value: string; label: string }[] = [{ value: mid, label: mid }];
              if (withoutGeneric) {
                candidates.push({ value: withoutGeneric, label: `${withoutGeneric} without "${genericPrefix}"` });
              }
              
              let noteText = `${parts.country} + ${parts.name} + ${parts.number} + ${parts.city} from "${name}" and "${address}".`;
              
              // Add city-state note if present
              const cityStateNote = notes.find((n) => n.includes("comes from the country name"));
              if (cityStateNote) {
                noteText += " " + cityStateNote;
              }
              
              let reasonText = "Suggested from the invoice issuer's name and address by the MID rule of the 7501 instructions (Appendix 2). The MID names the manufacturer: a person checks that the invoice issuer made the goods or sold them directly, and confirms.";
              
              // Add generic prefix note if present
              if (genericPrefix) {
                reasonText += ` The name starts with "${genericPrefix}", a word for a kind of company. Appendix 2 leaves out some such words; a person decides whether to leave it out.`;
              }
              
              // Add country of origin note if different from address
              const originDiffNote = notes.find((n) => n.includes("The goods come from"));
              if (originDiffNote) {
                reasonText += " " + originDiffNote;
              }
              
              // Add textile note if any line is textile
              const hasTextile = draftLines.some((line) => {
                const hts33a = line.fields.find((f) => f.block === "33A");
                if (hts33a && hts33a.value && /^(5\d|6[0-3])/.test(hts33a.value)) {
                  return true;
                }
                return false;
              });
              
              if (hasTextile) {
                reasonText += " Textile goods (chapters 50 to 63): the MID must be the actual manufacturer's (19 CFR 102.23), not a trading company's.";
              }
              
              headerFields[b13Index] = field_helper({
                id: "B13",
                block: "13",
                label: "Manufacturer ID (MID)",
                value: mid,
                status: "needsReview",
                rule: "7501 Appendix 2",
                note: noteText,
                reason: reasonText,
                sources,
                inputs: ["B10"],
                candidates,
              });
            }
          } else {
            // 48.9d: Multiple origins
            const sources: Source[] = [];
            if (nameReading) sources.push(docSource(nameReading));
            if (addressReading) sources.push(docSource(addressReading));
            
            const midsPerOrigin = distinctOrigins.map((origin) => {
              const result = suggestMid({ name, address, origin });
              return { origin, mid: result.ok ? result.value : "", lines: originGroups.get(origin)! };
            });
            
            const reasonLines = midsPerOrigin
              .filter((m) => m.mid)
              .map((m) => `${m.mid} for line ${m.lines.join(", ")}`)
              .join("; ");
            
            headerFields[b13Index] = field_helper({
              id: "B13",
              block: "13",
              label: "Manufacturer ID (MID)",
              status: "needsReview",
              rule: "7501 Appendix 2",
              reason: `The lines come from more than one country, so the MID differs by line: ${reasonLines}. A person enters MULTI and the MID of each line.`,
              sources,
              inputs: ["B10"],
            });
          }
        }
      }
    }
  }

  // B13: Update if parts list has MIDs
  if (partsList) {
    const lines = draftLines.flatMap(l => l.invoiceLines).sort((a, b) => a - b);
    const mids = lines.map(n => partsByLine.get(n)?.mid ?? null);
    const midSources = mids
      .flatMap((mid, i) => mid ? [mid.source] : [])
      .filter((s, i, arr) => arr.findIndex(x => x.readingField === s.readingField) === i); // Deduplicate by readingField
    
    const allHaveMid = mids.every(m => m !== null);
    const allSameMid = allHaveMid && new Set(mids.map(m => m!.value)).size === 1;
    
    if (allSameMid) {
      // All lines have the same MID - fill B13
      const b13Index = headerFields.findIndex(f => f.id === "B13");
      if (b13Index >= 0) {
        headerFields[b13Index] = field_helper({
          id: "B13",
          block: "13",
          label: "Manufacturer ID (MID)",
          value: mids[0]!.value,
          status: "copied",
          note: "From the customer parts list (one MID for every line).",
          sources: midSources,
        });
      }
    } else if (mids.some(m => m !== null)) {
      // Some lines have MIDs - keep needsReview and add MID info to reason
      const b13Index = headerFields.findIndex(f => f.id === "B13");
      if (b13Index >= 0) {
        const baseReason = "Invoice names a trading company; manufacturer per line not in bundle.";
        const midList = lines
          .map((n, i) => {
            const m = mids[i];
            return m ? `invoice line ${n} ${m.value}` : `invoice line ${n} none`;
          })
          .join("; ");
        const reason = `${baseReason} The customer parts list gives: ${midList}. A person checks the manufacturer of each line.`;
        headerFields[b13Index] = field_helper({
          id: "B13",
          block: "13",
          label: "Manufacturer ID (MID)",
          status: "needsReview",
          reason,
          sources: midSources,
        });
      }
    }
  }

  // Build totals section
  const totalFields: DraftField[] = [];

  // Helper: extract value from a field in header or lines (searches before totals are computed)
  const getFieldValue = (fieldId: string): string | null => {
    // Search header first
    for (const f of headerFields) {
      if (f.id === fieldId) {
        return f.value;
      }
    }
    // Then search all line fields
    for (const line of draftLines) {
      for (const f of line.fields) {
        if (f.id === fieldId) {
          return f.value;
        }
      }
    }
    // Finally search totalFields (which may already have computed values from earlier totals)
    for (const f of totalFields) {
      if (f.id === fieldId) {
        return f.value;
      }
    }
    return null;
  };

  // B39: Total entered value
  {
    const id = "B39";
    const lineValueIds = draftLines
      .map((line) => {
        const field = line.fields.find((f) => f.id.endsWith(".36A"));
        return field ? field.id : null;
      })
      .filter((id): id is string => id !== null);

    // Check if no lines were built (Requirement 32.1)
    if (draftLines.length === 0) {
      totalFields.push(
        field_helper({
          id,
          block: "39",
          label: "Total entered value (USD)",
          status: "needsReview",
          value: null,
          rule: null,
          note: null,
          reason: NO_LINE_REASON,
        })
      );
    } else {
      // Check if all line entered values are available
      const missingIds: string[] = [];
      let totalCentsExact = 0;

      for (const valueId of lineValueIds) {
        const value = getFieldValue(valueId);
        if (!value) {
          missingIds.push(valueId);
        } else {
          const dollars = parseInt(value, 10);
          if (!isNaN(dollars)) {
            totalCentsExact += dollars * 100;
          } else {
            missingIds.push(valueId);
          }
        }
      }

      if (missingIds.length > 0) {
        totalFields.push(
          field_helper({
            id,
            block: "39",
            label: "Total entered value (USD)",
            status: "needsReview",
            inputs: lineValueIds,
            reason: `Waiting on ${missingIds.join(", ")}.`,
            rule: null,
          })
        );
      } else {
        // Compute total using config mode
        const totalResult = totalEnteredValue([totalCentsExact], config.totalEnteredValueMode);
        if (!totalResult.ok) {
          totalFields.push(
            field_helper({
              id,
              block: "39",
              label: "Total entered value (USD)",
              status: "needsReview",
              inputs: lineValueIds,
              reason: totalResult.reason,
              rule: null,
            })
          );
        } else {
          const totalDollars = totalResult.value;
          totalFields.push(
            field_helper({
              id,
              block: "39",
              label: "Total entered value (USD)",
              value: String(totalDollars),
              status: "computed",
              rule: "P5",
              note: lineValueIds.length > 0 ? `${lineValueIds.map(id => getFieldValue(id) || "0").join(" + ")} = ${totalDollars}` : String(totalDollars),
              inputs: lineValueIds,
            })
          );
        }
      }
    }
  }

  // FEE.MPF: Merchandise Processing Fee
  {
    const id = "FEE.MPF";
    const b39Id = "B39";
    const b39Value = getFieldValue(b39Id);

    if (!b39Value) {
      totalFields.push(
        field_helper({
          id,
          block: "43",
          label: "Merchandise processing fee (USD)",
          status: "needsReview",
          inputs: [b39Id],
          reason: `Waiting on ${b39Id}.`,
          rule: null,
        })
      );
    } else {
      const b39Dollars = parseInt(b39Value, 10);
      const b39Cents = b39Dollars * 100;
      const mpfResult = computeMPF(b39Cents);

      if (!mpfResult.ok) {
        totalFields.push(
          field_helper({
            id,
            block: "43",
            label: "Merchandise processing fee (USD)",
            status: "needsReview",
            inputs: [b39Id],
            reason: mpfResult.reason,
            rule: null,
          })
        );
      } else {
        const mpfFormatted = formatCents(mpfResult.value);
        const baseAmount = (b39Cents * config.mpfRate) / 1000000; // 0.3464% of B39
        const baseFormatted = formatCents(Math.round(baseAmount));

        let note = `0.3464% of ${b39Value} = ${baseFormatted}`;
        if (mpfResult.value === config.mpfMinimumCents) {
          note += ` (minimum applied: $${formatCents(config.mpfMinimumCents)})`;
        } else if (mpfResult.value === config.mpfMaximumCents) {
          note += ` (maximum applied: $${formatCents(config.mpfMaximumCents)})`;
        }

        totalFields.push(
          field_helper({
            id,
            block: "43",
            label: "Merchandise processing fee (USD)",
            value: mpfFormatted,
            status: "computed",
            rule: "P8",
            note,
            inputs: [b39Id],
          })
        );
      }
    }
  }

  // FEE.HMF: Harbor Maintenance Fee (personInput)
  {
    const id = "FEE.HMF";
    totalFields.push(
      field_helper({
        id,
        block: "43",
        label: "Harbor maintenance fee (USD)",
        status: "personInput",
        reason: "The harbor maintenance fee rate is not confirmed in our sources.",
      })
    );
  }

  // B41: Duty (sum of all L<nnn>.38 and L<nnn>.ch99)
  {
    const id = "B41";
    // Order: all L<nnn>.38 first, then all L<nnn>.ch99
    const dutyIds: string[] = [];
    // First add all .38 fields
    for (const line of draftLines) {
      const dutyField = line.fields.find((f) => f.id.endsWith(".38"));
      if (dutyField) dutyIds.push(dutyField.id);
    }
    // Then add all .ch99 fields
    for (const line of draftLines) {
      const ch99Field = line.fields.find((f) => f.id.endsWith(".ch99"));
      if (ch99Field) dutyIds.push(ch99Field.id);
    }

    // Check if no lines were built (Requirement 32.1)
    if (draftLines.length === 0) {
      totalFields.push(
        field_helper({
          id,
          block: "41",
          label: "Duty (USD)",
          status: "needsReview",
          value: null,
          rule: null,
          note: null,
          reason: NO_LINE_REASON,
        })
      );
    } else {
      const missingIds: string[] = [];
      let totalDutyCents = 0;

      for (const dutyId of dutyIds) {
        const value = getFieldValue(dutyId);
        if (!value) {
          missingIds.push(dutyId);
        } else {
          const dutyResult = parseMoneyToCents(value);
          if (dutyResult.ok) {
            totalDutyCents += dutyResult.value;
          } else {
            missingIds.push(dutyId);
          }
        }
      }

      if (missingIds.length > 0) {
        totalFields.push(
          field_helper({
            id,
            block: "41",
            label: "Duty (USD)",
            status: "needsReview",
            inputs: dutyIds,
            reason: `Waiting on ${missingIds.join(", ")}.`,
            rule: null,
          })
        );
      } else {
        const dutyFormatted = formatCents(totalDutyCents);
        const dutyValues = dutyIds.map(id => getFieldValue(id) || "0.00");
        const note = `${dutyValues.join(" + ")} = ${dutyFormatted}`;
        totalFields.push(
          field_helper({
            id,
            block: "41",
            label: "Duty (USD)",
            value: dutyFormatted,
            status: "computed",
            rule: "7501 p.20",
            note,
            inputs: dutyIds,
          })
        );
      }
    }
  }

  // B42: Tax (computed 0.00)
  {
    const id = "B42";
    totalFields.push(
      field_helper({
        id,
        block: "42",
        label: "Tax (USD)",
        value: "0.00",
        status: "computed",
        rule: "7501 p.20",
        note: "No line in this bundle has an I.R. tax rate.",
      })
    );
  }

  // B43: Other (FEE.MPF + FEE.HMF)
  {
    const id = "B43";
    const mpfValue = getFieldValue("FEE.MPF");
    const hmfValue = getFieldValue("FEE.HMF");

    if (!mpfValue || !hmfValue) {
      const missingIds: string[] = [];
      if (!mpfValue) missingIds.push("FEE.MPF");
      if (!hmfValue) missingIds.push("FEE.HMF");

      totalFields.push(
        field_helper({
          id,
          block: "43",
          label: "Other (fees, USD)",
          status: "needsReview",
          inputs: ["FEE.MPF", "FEE.HMF"],
          reason: `Waiting on ${missingIds.join(", ")}.`,
          rule: null,
        })
      );
    } else {
      const mpfResult = parseMoneyToCents(mpfValue);
      const hmfResult = parseMoneyToCents(hmfValue);

      if (!mpfResult.ok || !hmfResult.ok) {
        totalFields.push(
          field_helper({
            id,
            block: "43",
            label: "Other (fees, USD)",
            status: "needsReview",
            inputs: ["FEE.MPF", "FEE.HMF"],
            reason: "Could not parse fee values.",
            rule: null,
          })
        );
      } else {
        const totalCents = mpfResult.value + hmfResult.value;
        const totalFormatted = formatCents(totalCents);
        const mpfValue = getFieldValue("FEE.MPF") || "0.00";
        const hmfValue = getFieldValue("FEE.HMF") || "0.00";
        const note = `${mpfValue} + ${hmfValue} = ${totalFormatted}`;
        totalFields.push(
          field_helper({
            id,
            block: "43",
            label: "Other (fees, USD)",
            value: totalFormatted,
            status: "computed",
            rule: "7501 p.20",
            note,
            inputs: ["FEE.MPF", "FEE.HMF"],
          })
        );
      }
    }
  }

  // B44: Total (B41 + B42 + B43)
  {
    const id = "B44";
    const b41Value = getFieldValue("B41");
    const b42Value = getFieldValue("B42");
    const b43Value = getFieldValue("B43");

    if (!b41Value || !b42Value || !b43Value) {
      const missingIds: string[] = [];
      if (!b41Value) missingIds.push("B41");
      if (!b42Value) missingIds.push("B42");
      if (!b43Value) missingIds.push("B43");

      totalFields.push(
        field_helper({
          id,
          block: "44",
          label: "Total (USD)",
          status: "needsReview",
          inputs: ["B41", "B42", "B43"],
          reason: `Waiting on ${missingIds.join(", ")}.`,
          rule: null,
        })
      );
    } else {
      const b41Result = parseMoneyToCents(b41Value);
      const b42Result = parseMoneyToCents(b42Value);
      const b43Result = parseMoneyToCents(b43Value);

      if (!b41Result.ok || !b42Result.ok || !b43Result.ok) {
        totalFields.push(
          field_helper({
            id,
            block: "44",
            label: "Total (USD)",
            status: "needsReview",
            inputs: ["B41", "B42", "B43"],
            reason: "Could not parse total inputs.",
            rule: null,
          })
        );
      } else {
        const totalCents = b41Result.value + b42Result.value + b43Result.value;
        const totalFormatted = formatCents(totalCents);
        const b41Value = getFieldValue("B41") || "0.00";
        const b42Value = getFieldValue("B42") || "0.00";
        const b43Value = getFieldValue("B43") || "0.00";
        const note = `${b41Value} + ${b42Value} + ${b43Value} = ${totalFormatted}`;
        totalFields.push(
          field_helper({
            id,
            block: "44",
            label: "Total (USD)",
            value: totalFormatted,
            status: "computed",
            rule: "P10",
            note,
            inputs: ["B41", "B42", "B43"],
          })
        );
      }
    }
  }

  // Invoice lines against the invoice (Requirement 19): a line the reader left out must not disappear silently.
  {
    const reasons: string[] = [];
    const p2 = checks.filter((c) => c.rule === "P2");
    if (!p2.some((c) => c.id === "P2.invoice.subtotal")) {
      reasons.push("No invoice subtotal was read, so the invoice line amounts were not added up against it. Compare the 7501 lines with the invoice.");
    }
    const failed = p2.filter((c) => !c.ok);
    if (failed.length > 0) {
      reasons.push(`The invoice line amounts do not match the invoice totals (${failed.map((c) => c.detail).join("; ")}). A line may be missing; compare the 7501 lines with the invoice.`);
    }
    const count = input.invoiceLineCount;
    if (typeof count === "number") {
      const linesRead = new Set(
        verified.map((r) => /^invoice\.lines\.(\d+)\./.exec(r.field)?.[1]).filter((n): n is string => n !== undefined),
      ).size;
      if (count !== linesRead) reasons.push(`The invoice shows ${count} item lines, but the draft has readings for ${linesRead}.`);
      if (count > 8) reasons.push(`The invoice shows ${count} item lines; this draft reads only the first 8.`);
    }
    if (reasons.length > 0) {
      const sources = ["invoice.subtotal", "invoice.total"]
        .map((name) => accepted.get(name))
        .filter((r): r is VerifiedReading => r !== undefined)
        .map((r) => docSource(r));
      totalFields.push(
        field_helper({
          id: "CHK.INVOICE",
          block: "P2",
          label: "Invoice lines against the invoice",
          status: "needsReview",
          reason: reasons.join(" "),
          sources,
          inputs: p2.map((c) => c.id),
        }),
      );
    }
  }

  // Collect all fields before applying overrides
  const allFieldsList = [
    ...headerFields,
    ...draftLines.flatMap((line) => line.fields),
    ...totalFields,
  ];

  // A value read from an image page is not final until a person confirms it (Requirement 18.1).
  // Computed values with an image source wait too (Requirement 26.1).
  const hasUnplacedSource = (f: DraftField) => f.sources.some((s) => s.kind === "document" && s.notInTranscript === true);
  const hasLineWithoutBoxSource = (f: DraftField) => f.sources.some((s) => s.kind === "document" && s.lineWithoutBox === true);
  
  for (const f of allFieldsList) {
    if (f.status === "copied" && f.sources.some((s) => s.kind === "document" && s.origin === "imageTranscript")) {
      f.status = "needsReview";
      if (hasUnplacedSource(f)) {
        f.reason = UNPLACED_REVIEW_REASON;
      } else if (hasLineWithoutBoxSource(f)) {
        f.reason = LINE_WITHOUT_BOX_REVIEW_REASON;
      } else {
        f.reason = IMAGE_REVIEW_REASON;
      }
    } else if (f.status === "computed" && f.sources.some((s) => s.kind === "document" && s.origin === "imageTranscript")) {
      f.status = "needsReview";
      if (hasUnplacedSource(f)) {
        f.reason = UNPLACED_COMPUTED_REVIEW_REASON;
      } else if (hasLineWithoutBoxSource(f)) {
        f.reason = LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON;
      } else {
        f.reason = IMAGE_COMPUTED_REVIEW_REASON;
      }
    }
  }

  // Apply person value overrides
  for (const override of overrides) {
    const field = allFieldsList.find((f) => f.id === override.fieldId);
    if (!field) continue;

    // Parse value based on field kind
    let parseResult: { ok: boolean; value?: string | number; reason?: string } | null = null;
    let oldValue = field.value;
    let oldReason = field.reason;

    // Confirming an image value: the person applies the value that is shown (Requirement 18.3).
    if ((oldReason === IMAGE_REVIEW_REASON || oldReason === UNPLACED_REVIEW_REASON || oldReason === LINE_WITHOUT_BOX_REVIEW_REASON) && oldValue !== null && override.value === oldValue) {
      // Back to "copied": the value is the document's, now checked by a person. Nothing computed from it changes.
      field.status = "copied";
      field.reason = null;
      field.note = CONFIRMED_NOTE;
      continue;
    }

    // Confirming a computed value from an image (Requirement 26.2).
    if ((oldReason === IMAGE_COMPUTED_REVIEW_REASON || oldReason === UNPLACED_COMPUTED_REVIEW_REASON || oldReason === LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON) && oldValue !== null && override.value === oldValue) {
      // Back to "computed": the value is confirmed, but still computed.
      field.status = "computed";
      field.reason = null;
      field.note = CONFIRMED_NOTE;
      continue;
    }

    // Confirming a low-confidence value: the person applies the value that is shown (Requirement 36.3).
    if (oldReason === LOW_CONFIDENCE_REVIEW_REASON && oldValue !== null && override.value === oldValue) {
      // Back to "copied": the value is the document's, now checked by a person.
      field.status = "copied";
      field.reason = null;
      field.note = CONFIRMED_NOTE;
      continue;
    }

    try {
      switch (field.block) {
        // dollars (36A, B39): parseMoneyToCents and require whole dollars
        case "36A":
        case "39": {
          const parsed = parseMoneyToCents(override.value);
          if (parsed.ok) {
            const cents = parsed.value;
            if (cents % 100 === 0) {
              parseResult = { ok: true, value: String(cents / 100) };
            } else {
              parseResult = {
                ok: false,
                reason: `Person value "${override.value}" must be whole dollars.`,
              };
            }
          } else {
            parseResult = { ok: false, reason: `Person value "${override.value}" was not accepted: ${parsed.reason}` };
          }
          break;
        }

        // money (38, ch99, FEE.*, B41..B44): parseMoneyToCents -> formatCents
        case "38":
        case "43":
        case "41":
        case "42":
        case "44": {
          const parsed = parseMoneyToCents(override.value);
          if (parsed.ok) {
            parseResult = { ok: true, value: formatCents(parsed.value) };
          } else {
            parseResult = { ok: false, reason: `Person value "${override.value}" was not accepted: ${parsed.reason}` };
          }
          break;
        }

        // hts (33A): normalizeHts -> entry form; lookup; use new number
        case "33A": {
          const normalized = normalizeHts(override.value);
          if (normalized.ok) {
            const lookup = lookupHts(hts, normalized.value.entry);
            if (lookup.found) {
              parseResult = { ok: true, value: lookup.number.entry };
              // Update hts sources
              field.sources = [
                {
                  kind: "hts",
                  revision: hts.revision,
                  htsno: lookup.row.htsno,
                },
              ];

              // Re-derive dependent fields in this line (Requirements 31.2, 31.3)
              if (field.line) {
                const lineNum = field.line;
                const draftLine = draftLines.find((l) => l.lineNumber === lineNum);
                
                // Update .35 unit from new HTS
                const field35 = allFieldsList.find((f) => f.id === `L${lineNum}.35`);
                if (field35 && draftLine) {
                  // Check if .35 was personEdited (Requirement 31.3)
                  if (field35.status === "personEdited") {
                    // Unit changed: set to needsReview with specific reason
                    if (field35.unit !== lookup.unit) {
                      const oldUnit = field35.unit || "unknown";
                      const oldValue = field35.value || "unknown";
                      const newUnit = lookup.unit || "unknown";
                      const unitPeriod = newUnit.endsWith(".") ? "" : ".";
                      field35.status = "needsReview";
                      field35.value = null;
                      field35.note = null;
                      field35.unit = lookup.unit;
                      field35.reason = `L${lineNum}.33A changed the unit from ${oldUnit} to ${newUnit}; the quantity a person entered (${oldValue} ${oldUnit}) is in the old unit. A person enters the quantity in ${newUnit}${unitPeriod}`;
                    }
                    // Unit is the same: leave .35 as is
                  } else {
                    // Otherwise, re-derive using the helper (Requirement 31.1)
                    const fresh = deriveNetQuantity(lineNum, draftLine.invoiceLines, lookup);
                    Object.assign(field35, { ...fresh, id: field35.id });
                  }
                }

                // Update .37A rate from new HTS
                const field37A = allFieldsList.find((f) => f.id === `L${lineNum}.37A`);
                if (field37A) {
                  if (lookup.rateText) {
                    field37A.value = lookup.rateText;
                    field37A.status = "copied";
                    field37A.sources = [
                      {
                        kind: "hts",
                        revision: hts.revision,
                        htsno: lookup.rateFrom,
                      },
                    ];
                    field37A.rule = lookup.rateFrom !== lookup.row.htsno ? "P16" : null;
                    field37A.reason = null;
                    field37A.inputs = [];
                    field37A.note = `General rate of ${lookup.rateFrom}.`;
                  }
                }

                // Mark .38 as needing re-computation (its inputs now use the new rate)
                const field38 = allFieldsList.find((f) => f.id === `L${lineNum}.38`);
                if (field38 && field38.status !== "personEdited") {
                  // Don't override if user already entered this value
                  field38.status = "needsReview";
                  field38.value = null;
                  field38.reason = "Re-computed from new HTS number.";
                  field38.note = null;
                }
              }
            } else {
              parseResult = { ok: false, reason: `HTS ${normalized.value.entry} not found in ${hts.revisionTitle}.` };
            }
          } else {
            parseResult = { ok: false, reason: `Person value "${override.value}" was not accepted: ${normalized.reason}` };
          }
          break;
        }

        // country (10, B10, B14): countryCode
        case "10":
        case "14": {
          const parsed = countryCode(override.value);
          if (parsed.ok) {
            parseResult = { ok: true, value: parsed.value };
          } else {
            parseResult = { ok: false, reason: `Person value "${override.value}" was not accepted: ${parsed.reason}` };
          }
          break;
        }

        // quantity (34A, 35): ^\d+(\.\d{1,2})?$ kept as typed; .35 keeps HTS unit
        case "34A":
        case "35": {
          if (/^\d+(\.\d{1,2})?$/.test(override.value)) {
            parseResult = { ok: true, value: override.value };
          } else {
            parseResult = {
              ok: false,
              reason: `Person value "${override.value}" was not accepted: quantity must match pattern \\d+(\\.\\d{1,2})?`,
            };
          }
          break;
        }

        // date (B11, B15): parseUsDate
        case "11":
        case "15": {
          const parsed = parseUsDate(override.value);
          if (parsed.ok) {
            parseResult = { ok: true, value: parsed.value };
          } else {
            parseResult = { ok: false, reason: `Person value "${override.value}" was not accepted: ${parsed.reason}` };
          }
          break;
        }

        // everything else: non-empty text
        default: {
          if (override.value && override.value.trim()) {
            parseResult = { ok: true, value: override.value };
          } else {
            parseResult = {
              ok: false,
              reason: `Person value must be non-empty.`,
            };
          }
        }
      }
    } catch (err) {
      parseResult = { ok: false, reason: `Error parsing person value: ${err}` };
    }

    // Apply result
    if (parseResult && parseResult.ok) {
      field.status = "personEdited";
      field.reason = null;
      field.value = parseResult.value as string;
      field.note = `Entered by a person. Before: ${oldReason || (oldValue ? `"${oldValue}"` : "empty")}`;

      // Mark field as no longer computed; if it had inputs, they're now moot
      // But keep the rule for fields that have inherent rule contexts (like .33A with P15)
      if (!field.id.includes(".33A")) {
        field.rule = null;
      }

      // If this field feeds into computed totals, mark those as needsReview
      // (Will be done after collecting needsReview/personInput lists)
    } else if (parseResult) {
      field.status = "needsReview";
      field.value = null;
      field.reason = parseResult.reason || "Invalid person value.";
      field.note = null;
      
      // Requirement 38.3: When an HTS person value for L<nnn>.33A is refused,
      // mark that line's 35 and 37A as needsReview with the right reason
      if (field.block === "33A" && field.line) {
        const lineNum = field.line;
        const field35 = allFieldsList.find((f) => f.id === `L${lineNum}.35` && f.status !== "personEdited");
        const field37A = allFieldsList.find((f) => f.id === `L${lineNum}.37A` && f.status !== "personEdited");
        if (field35) {
          field35.status = "needsReview";
          field35.value = null;
          field35.reason = `Waiting on L${lineNum}.33A: the HTS number a person entered was not accepted.`;
          field35.note = null;
        }
        if (field37A) {
          field37A.status = "needsReview";
          field37A.value = null;
          field37A.reason = `Waiting on L${lineNum}.33A: the HTS number a person entered was not accepted.`;
          field37A.note = null;
        }
      }
    }
  }

  // Rebuild totals section after applying overrides (recalculate B39..B44)
  // Clear and rebuild
  const totalFieldsMap = new Map(totalFields.map((f) => [f.id, f]));

  // Re-compute totals and line fields if any dependent values were overridden
  const recomputeTotals = () => {
    // After HTS or quantity overrides on a line, recompute:
    // - .35 (unit from HTS) — now done in case "33A" override handling
    // - .37A (rate from HTS)  
    // - .38 (duty from value and rate)
    // - B10 (country of origin) [Requirement 38.1]
    // - B39, B41, B43, B44

    // Rebuild B10 unless it's personEdited (Requirement 38.1)
    const b10Field = headerFields.find((f) => f.id === "B10");
    if (b10Field && b10Field.status !== "personEdited") {
      const freshB10 = buildB10();
      Object.assign(b10Field, freshB10);
    }

    // Recompute L<nnn>.37A for lines where .10 or .33A was personEdited
    for (const line of draftLines) {
      const lineNum = line.lineNumber;
      const field10 = line.fields.find((f) => f.id === `L${lineNum}.10`);
      const field33A = line.fields.find((f) => f.id === `L${lineNum}.33A`);
      const field37A = line.fields.find((f) => f.id === `L${lineNum}.37A`);

      if (field37A && field37A.status === "needsReview" && field37A.inputs?.includes(`L${lineNum}.10`)) {
        // .37A is waiting on .10 and .10 is now available
        if (field33A && field33A.status !== "needsReview" && field33A.value && field10 && field10.value) {
          // Look up HTS to get rate
          const rateHtsLookup = lookupHts(hts, field33A.value || "");
          if (rateHtsLookup.found) {
            // Check if origin is in column 2 countries
            if (config.column2Countries.includes(field10.value)) {
              field37A.status = "needsReview";
              field37A.value = null;
              field37A.inputs = [];
              field37A.reason = `Origin ${field10.value} is a Column 2 country. Rate lookup not built.`;
            } else {
              // Check if rate is computable
              const dutyTest = computeDuty(rateHtsLookup.rateText, 0);
              if (!dutyTest.ok) {
                field37A.status = "needsReview";
                field37A.value = null;
                field37A.inputs = [];
                field37A.reason = `Rate "${rateHtsLookup.rateText}" is not Free or a simple percentage. A person decides.`;
              } else {
                const rateSource: HtsSource = {
                  kind: "hts",
                  revision: hts.revision,
                  htsno: rateHtsLookup.rateFrom,
                };
                const rule = rateHtsLookup.rateFrom !== rateHtsLookup.row.htsno ? "P16" : null;
                field37A.value = rateHtsLookup.rateText;
                field37A.status = "copied";
                field37A.rule = rule;
                field37A.sources = [rateSource];
                field37A.inputs = [];
                field37A.reason = null;
                field37A.note = `General rate of ${rateHtsLookup.rateFrom}.`;
              }
            }
          }
        }
      }
    }
    
    // Now handle duty recomputation for lines where inputs changed (Requirement 32.2)
    for (const line of draftLines) {
      const lineNum = line.lineNumber;
      const field36A = line.fields.find((f) => f.id === `L${lineNum}.36A`);
      const field37A = line.fields.find((f) => f.id === `L${lineNum}.37A`);
      const field38 = line.fields.find((f) => f.id === `L${lineNum}.38`);

      // If .38 is not personEdited, recompute it using the helper
      if (field38 && field38.status !== "personEdited") {
        const fresh = deriveDuty(lineNum, field36A, field37A);
        Object.assign(field38, { ...fresh, id: field38.id });
      }
    }

    // B39
    const lineValueIds = draftLines
      .map((line) => {
        const field = line.fields.find((f) => f.id.endsWith(".36A"));
        return field ? field.id : null;
      })
      .filter((id): id is string => id !== null);

    const b39Field = totalFieldsMap.get("B39");
    if (b39Field) {
      // Check if no lines were built (Requirement 32.1)
      if (draftLines.length === 0) {
        b39Field.status = "needsReview";
        b39Field.value = null;
        b39Field.rule = null;
        b39Field.note = null;
        b39Field.reason = NO_LINE_REASON;
      } else {
        const missingB39: string[] = [];
        let totalCentsExact = 0;

        for (const valueId of lineValueIds) {
          const field = allFieldsList.find((f) => f.id === valueId);
          if (!field || !field.value) {
            missingB39.push(valueId);
          } else {
            const dollars = parseInt(field.value, 10);
            if (!isNaN(dollars)) {
              totalCentsExact += dollars * 100;
            } else {
              missingB39.push(valueId);
            }
          }
        }

        if (missingB39.length > 0) {
          b39Field.status = "needsReview";
          b39Field.value = null;
          b39Field.reason = `Waiting on ${missingB39.join(", ")}.`;
          b39Field.rule = null;
        } else {
          const totalResult = totalEnteredValue([totalCentsExact], config.totalEnteredValueMode);
          if (!totalResult.ok) {
            b39Field.status = "needsReview";
            b39Field.value = null;
            b39Field.reason = totalResult.reason;
            b39Field.rule = null;
          } else {
            b39Field.status = "computed";
            b39Field.value = String(totalResult.value);
            b39Field.reason = null;
            b39Field.rule = "P5";
            const lineValues = lineValueIds.map(id => allFieldsList.find((f) => f.id === id)?.value || "0").join(" + ");
            b39Field.note = `${lineValues} = ${totalResult.value}`;
          }
        }
      }
    }

    // FEE.MPF (depends on B39)
    const mpfField = allFieldsList.find((f) => f.id === "FEE.MPF");
    if (mpfField && b39Field) {
      if (!b39Field.value || b39Field.status === "needsReview") {
        mpfField.status = "needsReview";
        mpfField.value = null;
        mpfField.reason = `Waiting on B39.`;
        mpfField.rule = null;
      } else {
        const b39Dollars = parseInt(b39Field.value, 10);
        const b39Cents = b39Dollars * 100;
        const mpfResult = computeMPF(b39Cents);
        if (!mpfResult.ok) {
          mpfField.status = "needsReview";
          mpfField.value = null;
          mpfField.reason = mpfResult.reason;
          mpfField.rule = null;
        } else {
          mpfField.status = "computed";
          mpfField.value = formatCents(mpfResult.value);
          mpfField.rule = "P8";
          const baseAmount = (b39Cents * config.mpfRate) / 1000000;
          const baseFormatted = formatCents(Math.round(baseAmount));
          let note = `0.3464% of ${b39Field.value} = ${baseFormatted}`;
          if (mpfResult.value === config.mpfMinimumCents) {
            note += ` (minimum applied: $${formatCents(config.mpfMinimumCents)})`;
          } else if (mpfResult.value === config.mpfMaximumCents) {
            note += ` (maximum applied: $${formatCents(config.mpfMaximumCents)})`;
          }
          mpfField.note = note;
          mpfField.reason = null;
        }
      }
    }

    // B41
    const dutyIds: string[] = [];
    for (const line of draftLines) {
      const dutyField = line.fields.find((f) => f.id.endsWith(".38"));
      if (dutyField) dutyIds.push(dutyField.id);
    }
    for (const line of draftLines) {
      const ch99Field = line.fields.find((f) => f.id.endsWith(".ch99"));
      if (ch99Field) dutyIds.push(ch99Field.id);
    }

    const b41Field = totalFieldsMap.get("B41");
    if (b41Field) {
      // Check if no lines were built (Requirement 32.1)
      if (draftLines.length === 0) {
        b41Field.status = "needsReview";
        b41Field.value = null;
        b41Field.rule = null;
        b41Field.note = null;
        b41Field.reason = NO_LINE_REASON;
      } else {
        const missingB41: string[] = [];
        let totalDutyCents = 0;

        for (const dutyId of dutyIds) {
          const field = allFieldsList.find((f) => f.id === dutyId);
          if (!field || !field.value) {
            missingB41.push(dutyId);
          } else {
            const dutyResult = parseMoneyToCents(field.value);
            if (dutyResult.ok) {
              totalDutyCents += dutyResult.value;
            } else {
              missingB41.push(dutyId);
            }
          }
        }

        if (missingB41.length > 0) {
          b41Field.status = "needsReview";
          b41Field.value = null;
          b41Field.reason = `Waiting on ${missingB41.join(", ")}.`;
          b41Field.rule = null;
        } else {
          b41Field.status = "computed";
          b41Field.value = formatCents(totalDutyCents);
          b41Field.reason = null;
          b41Field.rule = "7501 p.20";
          const dutyValues = dutyIds.map(id => allFieldsList.find((f) => f.id === id)?.value || "0.00").join(" + ");
          b41Field.note = `${dutyValues} = ${b41Field.value}`;
        }
      }
    }

    // B43 (depends on FEE.MPF and FEE.HMF)
    const hmfField = allFieldsList.find((f) => f.id === "FEE.HMF");
    const b43Field = totalFieldsMap.get("B43");
    if (b43Field && mpfField && hmfField) {
      if (!mpfField.value || mpfField.status === "needsReview" || !hmfField.value) {
        b43Field.status = "needsReview";
        b43Field.value = null;
        b43Field.reason = "Waiting on FEE.MPF or FEE.HMF.";
        b43Field.rule = null;
      } else {
        const mpfResult = parseMoneyToCents(mpfField.value);
        const hmfResult = parseMoneyToCents(hmfField.value);
        if (!mpfResult.ok || !hmfResult.ok) {
          b43Field.status = "needsReview";
          b43Field.value = null;
          b43Field.reason = "Could not parse fee values.";
          b43Field.rule = null;
        } else {
          b43Field.status = "computed";
          b43Field.value = formatCents(mpfResult.value + hmfResult.value);
          b43Field.reason = null;
          b43Field.rule = "7501 p.20";
          const mpfValue = mpfField.value || "0.00";
          const hmfValue = hmfField.value || "0.00";
          b43Field.note = `${mpfValue} + ${hmfValue} = ${b43Field.value}`;
        }
      }
    }

    // B44 (depends on B41, B42, B43)
    const b42Field = totalFieldsMap.get("B42");
    const b44Field = totalFieldsMap.get("B44");
    if (b44Field && b41Field && b42Field && b43Field) {
      if (!b41Field.value || b41Field.status === "needsReview" || !b42Field.value || !b43Field.value || b43Field.status === "needsReview") {
        b44Field.status = "needsReview";
        b44Field.value = null;
        b44Field.reason = "Waiting on B41, B42, or B43.";
        b44Field.rule = null;
      } else {
        const b41Result = parseMoneyToCents(b41Field.value);
        const b42Result = parseMoneyToCents(b42Field.value);
        const b43Result = parseMoneyToCents(b43Field.value);
        if (!b41Result.ok || !b42Result.ok || !b43Result.ok) {
          b44Field.status = "needsReview";
          b44Field.value = null;
          b44Field.reason = "Could not parse total inputs.";
          b44Field.rule = null;
        } else {
          b44Field.status = "computed";
          b44Field.value = formatCents(b41Result.value + b42Result.value + b43Result.value);
          b44Field.reason = null;
          b44Field.rule = "P10";
          const b41Value = b41Field.value || "0.00";
          const b42Value = b42Field.value || "0.00";
          const b43Value = b43Field.value || "0.00";
          b44Field.note = `${b41Value} + ${b42Value} + ${b43Value} = ${b44Field.value}`;
        }
      }
    }
  };

  recomputeTotals();

  // A value computed again after a person's edit still waits (Requirement 30.1): recomputeTotals can make a field
  // "computed" again from image readings (for example a line's 35 after its 33A is edited). Run the image rule of
  // 18.1 and 26.1 again on every field that a person has not confirmed.
  for (const f of allFieldsList) {
    if (f.note === CONFIRMED_NOTE) continue;
    if (!f.sources.some((s) => s.kind === "document" && s.origin === "imageTranscript")) continue;
    if (f.status === "copied") {
      f.status = "needsReview";
      if (hasUnplacedSource(f)) {
        f.reason = UNPLACED_REVIEW_REASON;
      } else if (hasLineWithoutBoxSource(f)) {
        f.reason = LINE_WITHOUT_BOX_REVIEW_REASON;
      } else {
        f.reason = IMAGE_REVIEW_REASON;
      }
    } else if (f.status === "computed") {
      f.status = "needsReview";
      if (hasUnplacedSource(f)) {
        f.reason = UNPLACED_COMPUTED_REVIEW_REASON;
      } else if (hasLineWithoutBoxSource(f)) {
        f.reason = LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON;
      } else {
        f.reason = IMAGE_COMPUTED_REVIEW_REASON;
      }
    }
  }

  // Waiting pass (Requirement 26.3): mark computed/copied fields that depend on image-waiting fields as needsReview
  const isImageWaiting = (f: DraftField): boolean => {
    return f.status === "needsReview" && isImageReviewReason(f.reason);
  };

  const depsOf = (f: DraftField): string[] => {
    const deps = [...f.inputs];
    if (f.block === "37A" && f.line !== null) {
      deps.push(`L${f.line}.33A`);
      deps.push(`L${f.line}.10`);
    }
    return deps;
  };

  const waitsOnMemo = new Map<string, Set<string>>();
  const visiting = new Set<string>();

  const waitsOn = (id: string): Set<string> => {
    if (waitsOnMemo.has(id)) {
      return waitsOnMemo.get(id)!;
    }

    if (visiting.has(id)) {
      // Cycle detected, return empty set
      return new Set();
    }

    visiting.add(id);
    const result = new Set<string>();

    const field = allFieldsList.find((f) => f.id === id);
    if (field) {
      for (const depId of depsOf(field)) {
        const depField = allFieldsList.find((f) => f.id === depId);
        if (depField) {
          if (isImageWaiting(depField)) {
            result.add(depId);
          }
          // Only follow transitive dependencies if the dep is not personEdited
          if (depField.status !== "personEdited") {
            for (const transId of waitsOn(depId)) {
              result.add(transId);
            }
          }
        }
      }
    }

    visiting.delete(id);
    waitsOnMemo.set(id, result);
    return result;
  };

  // Pre-compute waitsOn for all fields
  for (const f of allFieldsList) {
    waitsOn(f.id);
  }

  // Mark fields that wait on image-waiting fields
  for (const field of allFieldsList) {
    if ((field.status === "computed" || field.status === "copied") && !isImageWaiting(field)) {
      const deps = waitsOn(field.id);
      if (deps.size > 0) {
        // Sort deps by position in allFieldsList
        const sortedDeps = Array.from(deps).sort((a, b) => {
          const indexA = allFieldsList.findIndex((f) => f.id === a);
          const indexB = allFieldsList.findIndex((f) => f.id === b);
          return indexA - indexB;
        });
        field.status = "needsReview";
        field.reason = `Waiting on ${sortedDeps.join(", ")}: ${IMAGE_WAITING_SUFFIX}`;
        // Value, sources, rule, note, inputs stay
      }
    }
  }

  // Collect needsReview and personInput lists
  const needsReviewList: ReviewItem[] = [];
  const personInputList: ReviewItem[] = [];

  for (const field of allFieldsList) {
    if (field.status === "needsReview" && field.reason) {
      needsReviewList.push({
        fieldId: field.id,
        label: field.label,
        status: "needsReview",
        reason: field.reason,
      });
    } else if (field.status === "personInput") {
      personInputList.push({
        fieldId: field.id,
        label: field.label,
        status: "personInput",
        reason: field.reason || "Required data entry by filer.",
      });
    }
  }

  return {
    notice: DRAFT_NOTICE,
    bundle,
    reader,
    htsRevision: hts.revision,
    htsRevisionTitle: hts.revisionTitle,
    header: headerFields,
    lines: draftLines,
    totals: totalFields,
    checks,
    rejectedReadings,
    needsReview: needsReviewList,
    personInput: personInputList,
  };
}

/**
 * Helper: create a DraftField with common defaults, renamed to avoid conflict.
 */
function field_helper(overrides: Partial<DraftField>): DraftField {
  const result: DraftField = {
    id: "",
    block: "",
    line: null,
    label: "",
    value: null,
    unit: null,
    status: "personInput",
    rule: null,
    note: null,
    reason: null,
    sources: [],
    inputs: [],
    ...overrides,
  };
  // Only include candidates if it was explicitly provided
  if (overrides.candidates === undefined) {
    delete (result as any).candidates;
  }
  return result;
}

/**
 * Return all fields in a draft: header, then line fields, then totals.
 */
export function allFields(d: Draft): DraftField[] {
  const result: DraftField[] = [...d.header];
  for (const line of d.lines) {
    result.push(...line.fields);
  }
  result.push(...d.totals);
  return result;
}
