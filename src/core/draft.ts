import { normalizeSpace, Box } from "./pdfText";
import { VerifiedReading } from "./reading";
import { HtsTable, lookupHts, normalizeHts } from "./hts";
import {
  parseMoneyToCents,
  parseCount,
  parseKgToTenths,
  parsePackages,
  parseUsDate,
  countryCode,
  formatCents,
} from "./parse";
import { roundEnteredValue, computeDuty, allocateGrossWeight, totalEnteredValue, computeMPF, config } from "../rules";

export const DRAFT_NOTICE = "DRAFT, NOT FOR FILING";

export type FieldStatus = "copied" | "computed" | "needsReview" | "personInput" | "personEdited";

export type DocSource = {
  kind: "document";
  doc: string;
  page: number;
  quote: string;
  box: Box;
  readingField: string;
};

export type HtsSource = {
  kind: "hts";
  revision: string;
  htsno: string;
};

export type Source = DocSource | HtsSource;

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
 * Helper: create a DocSource from an accepted reading.
 */
function docSource(reading: VerifiedReading): DocSource {
  if (reading.status !== "accepted") throw new Error("Cannot create DocSource from rejected reading");
  return {
    kind: "document",
    doc: reading.doc,
    page: reading.page,
    quote: normalizeSpace(reading.quote),
    box: reading.box,
    readingField: reading.field,
  };
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
}): Draft {
  const { bundle, reader, readings, hts } = input;
  const overrides = input.overrides || [];
  const overrideMap = new Map(overrides.map((o) => [o.fieldId, o.value]));

  const verified = readings;
  const accepted = acceptedReadings(verified);

  // Rejected readings
  const rejectedReadings = verified
    .filter((r) => r.status === "rejected")
    .map((r) => ({
      field: r.field,
      reason: r.reason,
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
        const packingQtys = packingByItemNo.get(line.itemNo) || [];
        const packingSum = packingQtys.reduce((a, b) => a + b, 0);
        const ok = packingQtys.length > 0 && packingSum === line.quantity;
        checks.push({
          id,
          rule: "P3",
          label: `Invoice qty ${line.itemNo}`,
          ok,
          detail: ok
            ? "invoice qty = packing sum"
            : `invoice qty = ${line.quantity}, packing sum = ${packingSum}`,
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
  for (let n = 1; n <= 8; n++) {
    const gField = `packingList.lines.${n}.grossKg`;
    const nField = `packingList.lines.${n}.netKg`;
    const cField = `packingList.lines.${n}.cartons`;

    const gReading = accepted.get(gField);
    const nReading = accepted.get(nField);
    const cReading = accepted.get(cField);

    if (gReading && gReading.value) {
      const gResult = parseKgToTenths(normalizeSpace(gReading.value));
      if (gResult.ok) packingGrossSum += gResult.value;
    }
    if (nReading && nReading.value) {
      const nResult = parseKgToTenths(normalizeSpace(nReading.value));
      if (nResult.ok) packingNetSum += nResult.value;
    }
    if (cReading && cReading.value) {
      const cResult = parseCount(normalizeSpace(cReading.value));
      if (cResult.ok) packingCartonSum += cResult.value;
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
        detail: `line sum = ${(packingGrossSum / 10).toFixed(1)}, total = ${(totalGrossResult.value / 10).toFixed(1)}`,
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
        detail: `line sum = ${(packingNetSum / 10).toFixed(1)}, total = ${(totalNetResult.value / 10).toFixed(1)}`,
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
        detail: `line sum = ${packingCartonSum}, total = ${totalCartonResult.value}`,
      });
    }
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

  // B6: needsReview
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
  if (vesselReading && vesselReading.value) {
    const vesselValue = normalizeSpace(vesselReading.value);
    headerFields.push(
      field_helper({
        id: "B8",
        block: "8",
        label: "Importing carrier (vessel)",
        value: vesselValue,
        status: "copied",
        sources: [docSource(vesselReading)],
      })
    );
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

  // B9: computed "11" with rule "7501 p.8", source from billOfLading.containerNo when present
  const containerReading = accepted.get("billOfLading.containerNo");
  const b9Sources = containerReading ? [docSource(containerReading)] : [];
  headerFields.push(
    field_helper({
      id: "B9",
      block: "9",
      label: "Mode of transport",
      value: "11",
      unit: null,
      status: "computed",
      rule: "7501 p.8",
      sources: b9Sources,
    })
  );

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
  if (blReading && blReading.value) {
    const blValue = normalizeSpace(blReading.value);
    if (isValidBlNumber(blValue)) {
      headerFields.push(
        field_helper({
          id: "B12",
          block: "12",
          label: "B/L number",
          value: blValue,
          status: "copied",
          sources: [docSource(blReading)],
        })
      );
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

  // B13: needsReview
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
  if (exportCountryReading && exportCountryReading.value) {
    const codeResult = countryCode(normalizeSpace(exportCountryReading.value));
    if (codeResult.ok) {
      headerFields.push(
        field_helper({
          id: "B14",
          block: "14",
          label: "Exporting country",
          value: codeResult.value,
          status: "copied",
          sources: [docSource(exportCountryReading)],
        })
      );
    } else {
      headerFields.push(
        field_helper({
          id: "B14",
          block: "14",
          label: "Exporting country",
          status: "needsReview",
          reason: `Country not recognized: "${exportCountryReading.value}"`,
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
  if (onBoardReading && onBoardReading.value) {
    const dateResult = parseUsDate(normalizeSpace(onBoardReading.value));
    if (dateResult.ok) {
      headerFields.push(
        field_helper({
          id: "B15",
          block: "15",
          label: "Export date",
          value: dateResult.value,
          status: "copied",
          sources: [docSource(onBoardReading)],
        })
      );
    } else {
      headerFields.push(
        field_helper({
          id: "B15",
          block: "15",
          label: "Export date",
          status: "needsReview",
          reason: `Invalid date format: "${onBoardReading.value}"`,
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

  // B19: needsReview
  headerFields.push(
    field_helper({
      id: "B19",
      block: "19",
      label: "Foreign port of lading",
      status: "needsReview",
      reason: "Schedule K code lookup not built. Port of loading from B/L required.",
    })
  );

  // B20: needsReview
  headerFields.push(
    field_helper({
      id: "B20",
      block: "20",
      label: "U.S. port of unlading",
      status: "needsReview",
      reason: "Schedule D code lookup not built. Port of discharge from B/L required.",
    })
  );

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

  const lineGroups = new Map<string, LineGroup>();

  // Group invoice lines by HTS and origin
  for (let n = 1; n <= 8; n++) {
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

    // Build group key
    const htsKey = htsRaw || `raw:${n}`;
    let groupKey: string;
    if (originCode) {
      groupKey = `${htsKey}|${originCode}`;
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
        htsRaw,
        origin: originCode,
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
  const packingByItemNo2 = new Map<
    string,
    Array<{
      carton: number;
      quantity: number;
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

    if (itemReading && itemReading.value && qtyReading && qtyReading.value && grossReading && grossReading.value) {
      const itemNo = normalizeSpace(itemReading.value);
      const qtyResult = parseCount(normalizeSpace(qtyReading.value));
      const grossResult = parseKgToTenths(normalizeSpace(grossReading.value));

      if (qtyResult.ok && grossResult.ok) {
        if (!packingByItemNo2.has(itemNo)) {
          packingByItemNo2.set(itemNo, []);
        }
        packingByItemNo2.get(itemNo)!.push({
          carton: n,
          quantity: qtyResult.value,
          grossKg: grossResult.value,
          grossKgReading: grossReading,
        });
      }
    }
  }

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

        field = field_helper({
          id,
          block: "10",
          line: lineNum,
          label: "Country of origin",
          value: group.origin,
          status: "copied",
          sources,
        });
      } else {
        // No accepted origin
        const reasons: string[] = [];
        for (const n of group.invoiceLines) {
          const r = accepted.get(`invoice.lines.${n}.origin`);
          if (r && r.value) {
            const originStr = normalizeSpace(r.value);
            const codeResult = countryCode(originStr);
            if (!codeResult.ok) {
              reasons.push(
                `Invoice line ${n}: the reader suggested "${originStr}" but its quote is not on the page, so it was rejected.`
              );
            }
          } else {
            const originReading = verified.find(
              (v) => v.field === `invoice.lines.${n}.origin` && v.status === "rejected"
            );
            if (originReading) {
              reasons.push(
                `Invoice line ${n}: the reader suggested "${normalizeSpace(originReading.value ?? "")}" but its quote is not on the page, so it was rejected.`
              );
            } else {
              reasons.push(`Line ${n}: no origin reading.`);
            }
          }
        }

        field = field_helper({
          id,
          block: "10",
          line: lineNum,
          label: "Country of origin",
          status: "needsReview",
          reason: reasons.length > 0 ? reasons.join(" ") : "Country of origin missing.",
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

      lineFields.push(
        field_helper({
          id,
          block: "32",
          line: lineNum,
          label: "Description of merchandise",
          value: desc,
          status: "copied",
          sources,
        })
      );
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

      let field: DraftField;
      if (htsLookup.found) {
        const htsSource: HtsSource = {
          kind: "hts",
          revision: hts.revision,
          htsno: htsLookup.row.htsno,
        };
        field = field_helper({
          id,
          block: "33A",
          line: lineNum,
          label: "HTS number",
          value: htsLookup.number.entry,
          status: "copied",
          rule: "P15",
          sources: [...htsReadingSources, htsSource],
        });
      } else {
        field = field_helper({
          id,
          block: "33A",
          line: lineNum,
          label: "HTS number",
          status: "needsReview",
          rule: "P15",
          reason: `${htsLookup.reason} The app does not choose a number.`,
          sources: htsReadingSources,
        });
      }

      lineFields.push(field);
    }

    // L<nnn>.34A: gross weight (kg) — allocated after all lines built

    // L<nnn>.35: net quantity
    {
      const id = `L${lineNum}.35`;

      // Get HTS unit
      let htsUnit: string | null = null;
      if (htsLookup.found) {
        htsUnit = htsLookup.unit;
      }

      // Check for P3 quantity mismatch
      let quantityMismatchReason: string | null = null;
      for (const n of group.invoiceLines) {
        const invQtyReading = accepted.get(`invoice.lines.${n}.quantity`);
        const itemReading = accepted.get(`invoice.lines.${n}.itemNo`);

        if (invQtyReading && invQtyReading.value && itemReading && itemReading.value) {
          const invQtyResult = parseCount(normalizeSpace(invQtyReading.value));
          const itemNo = normalizeSpace(itemReading.value);

          if (invQtyResult.ok) {
            const packingLines = packingByItemNo2.get(itemNo) || [];
            const packingQty = packingLines.reduce((sum, pl) => sum + pl.quantity, 0);

            if (packingQty !== invQtyResult.value) {
              quantityMismatchReason = `says ${invQtyResult.value} PCS, the packing list says ${packingQty} PCS. A person decides.`;
              break;
            }
          }
        }
      }

      if (quantityMismatchReason) {
        lineFields.push(
          field_helper({
            id,
            block: "35",
            line: lineNum,
            label: "Net quantity in HTS units",
            status: "needsReview",
            unit: htsUnit,
            reason: quantityMismatchReason,
          })
        );
      } else if (!htsLookup.found) {
        // HTS not found, can't get unit or compute
        lineFields.push(
          field_helper({
            id,
            block: "35",
            line: lineNum,
            label: "Net quantity in HTS units",
            status: "needsReview",
            inputs: [`L${lineNum}.33A`],
            reason: "Waiting on L" + lineNum + ".33A: the HTS number is not in the tariff schedule revision.",
          })
        );
      } else {
        // Parse quantities from invoice lines and convert to HTS unit
        let totalQuantity: number | null = null;
        const quantityReadingSources: DocSource[] = [];

        for (let i = 0; i < group.invoiceLines.length; i++) {
          const n = group.invoiceLines[i];
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
                // Dozens to individual pieces: divide by 12 (only show decimals if fractional)
                const quotient = qtyResult.value / 12;
                // Format with two decimals only if there's a fractional part
                if (qtyResult.value % 12 === 0) {
                  convertedQty = quotient;
                } else {
                  // Has fractional part; keep as whole number pieces, will convert at display
                  convertedQty = qtyResult.value;
                }
              } else if (invoiceUnit === "KG") {
                // Use as net kg with one decimal
                convertedQty = qtyResult.value;
              } else {
                // Unknown unit, can't convert
                convertedQty = null;
              }

              if (convertedQty !== null) {
                if (totalQuantity === null) totalQuantity = 0;
                totalQuantity += convertedQty;
              }

              quantityReadingSources.push(docSource(qtyReading));
            }
          }
        }

        if (totalQuantity !== null) {
          // Format quantity: for "Dz Pcs" unit, show as whole number or with 2 decimals
          let displayValue = String(totalQuantity);
          if (htsUnit && htsUnit.toUpperCase() === "DZ PCS") {
            // Convert from pieces to dozens
            const dozenCount = totalQuantity / 12;
            if (dozenCount === Math.floor(dozenCount)) {
              displayValue = String(Math.floor(dozenCount));
            } else {
              displayValue = dozenCount.toFixed(2);
            }
          }

          lineFields.push(
            field_helper({
              id,
              block: "35",
              line: lineNum,
              label: "Net quantity in HTS units",
              value: displayValue,
              unit: htsUnit,
              status: "computed",
              rule: "P12",
              sources: quantityReadingSources,
            })
          );
        } else {
          lineFields.push(
            field_helper({
              id,
              block: "35",
              line: lineNum,
              label: "Net quantity in HTS units",
              status: "needsReview",
              unit: htsUnit,
              reason: "Could not parse quantities from invoice lines.",
            })
          );
        }
      }
    }

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

      if (!isCurrencyOk) {
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
              sources: amountSources,
            })
          );
        }
      }
    }

    // L<nnn>.37A: HTS rate
    {
      const id = `L${lineNum}.37A`;

      if (!htsLookup.found) {
        lineFields.push(
          field_helper({
            id,
            block: "37A",
            line: lineNum,
            label: "HTS rate",
            status: "needsReview",
            inputs: [`L${lineNum}.33A`],
            reason: "Waiting on L" + lineNum + ".33A: the HTS number is not in the tariff schedule revision.",
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
              sources: [rateSource],
            })
          );
        }
      }
    }

    // L<nnn>.38: duty
    {
      const id = `L${lineNum}.38`;

      const enteredValueField = lineFields.find((f) => f.id === `L${lineNum}.36A`);
      const rateField = lineFields.find((f) => f.id === `L${lineNum}.37A`);

      if (!enteredValueField || enteredValueField.status === "needsReview" || !enteredValueField.value) {
        lineFields.push(
          field_helper({
            id,
            block: "38",
            line: lineNum,
            label: "Duty (USD)",
            status: "needsReview",
            inputs: [`L${lineNum}.36A`, `L${lineNum}.37A`],
            reason: `Waiting on L${lineNum}.36A.`,
          })
        );
      } else if (!rateField || rateField.status === "needsReview" || !rateField.value) {
        lineFields.push(
          field_helper({
            id,
            block: "38",
            line: lineNum,
            label: "Duty (USD)",
            status: "needsReview",
            inputs: [`L${lineNum}.36A`, `L${lineNum}.37A`],
            reason: `Waiting on L${lineNum}.37A.`,
          })
        );
      } else {
        // Both value and rate are available, compute duty
        const enteredDollars = parseInt(enteredValueField.value, 10);
        const dutyResult = computeDuty(rateField.value, enteredDollars * 100);

        if (!dutyResult.ok) {
          lineFields.push(
            field_helper({
              id,
              block: "38",
              line: lineNum,
              label: "Duty (USD)",
              status: "needsReview",
              inputs: [`L${lineNum}.36A`, `L${lineNum}.37A`],
              reason: dutyResult.reason,
            })
          );
        } else {
          const dutyFormatted = formatCents(dutyResult.value);
          lineFields.push(
            field_helper({
              id,
              block: "38",
              line: lineNum,
              label: "Duty (USD)",
              value: dutyFormatted,
              status: "computed",
              rule: "P7",
              inputs: [`L${lineNum}.36A`, `L${lineNum}.37A`],
            })
          );
        }
      }
    }

    // L<nnn>.ch99: Chapter 99 additional duty (if applicable)
    if (htsLookup.found && htsLookup.chapter99.length > 0) {
      const id = `L${lineNum}.ch99`;
      const footnoteText = htsLookup.chapter99.join("; ");

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
          reason: `See ${footnoteText}. A person enters the additional duty (0.00 if none).`,
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
    if (totalGrossReading && totalGrossReading.value) {
      const totalGrossResult = parseKgToTenths(normalizeSpace(totalGrossReading.value));

      if (totalGrossResult.ok) {
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

        // Check if basis sum matches total gross
        if (basisSum !== totalGrossResult.value) {
          // Mismatch
          for (const draftLine of draftLines) {
            const grossField = draftLine.fields.find((f) => f.id.endsWith(".34A"));
            if (grossField) {
              grossField.status = "needsReview";
              grossField.reason = `Gross weight basis sum (${(basisSum / 10).toFixed(1)} kg) differs from packing list total (${(totalGrossResult.value / 10).toFixed(1)} kg).`;
              grossField.sources = [docSource(totalGrossReading)];
            }
          }
        } else {
          // Allocate using largest remainder
          const totalGrossKg = Math.floor((totalGrossResult.value + 5) / 10); // tenths to whole kg, half up
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
                grossField.sources = grossKgSources[i].length > 0 ? grossKgSources[i] : [docSource(totalGrossReading)];
              }
            }
          } else {
            // Allocation failed (e.g., all basis zero)
            for (const draftLine of draftLines) {
              const grossField = draftLine.fields.find((f) => f.id.endsWith(".34A"));
              if (grossField) {
                grossField.status = "needsReview";
                grossField.reason = allocResult.reason;
                grossField.sources = [docSource(totalGrossReading)];
              }
            }
          }
        }
      }
    }
  }

  // Build B10: country of origin block
  const b10Field = (() => {
    // Collect all L<nnn>.10 field IDs in order
    const lineOriginIds: string[] = [];
    for (const draftLine of draftLines) {
      lineOriginIds.push(`L${draftLine.lineNumber}.10`);
    }

    if (allOrigins.length === 0) {
      return field_helper({
        id: "B10",
        block: "10",
        label: "Country of origin",
        status: "needsReview",
        inputs: lineOriginIds,
        reason: "No accepted origins from lines.",
      });
    }

    const uniqueOrigins = [...new Set(allOrigins)];
    if (uniqueOrigins.length > 1) {
      return field_helper({
        id: "B10",
        block: "10",
        label: "Country of origin",
        value: "MULTI",
        status: "computed",
        rule: "7501 p.8",
        inputs: lineOriginIds,
      });
    } else {
      return field_helper({
        id: "B10",
        block: "10",
        label: "Country of origin",
        value: uniqueOrigins[0],
        status: "computed",
        rule: "7501 p.8",
        inputs: lineOriginIds,
      });
    }
  })();

  // Insert B10 after B9
  const b9Index = headerFields.findIndex((f) => f.id === "B9");
  if (b9Index >= 0) {
    headerFields.splice(b9Index + 1, 0, b10Field);
  } else {
    headerFields.push(b10Field);
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
            inputs: lineValueIds,
          })
        );
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
      totalFields.push(
        field_helper({
          id,
          block: "41",
          label: "Duty (USD)",
          value: dutyFormatted,
          status: "computed",
          rule: "7501 p.20",
          inputs: dutyIds,
        })
      );
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
        totalFields.push(
          field_helper({
            id,
            block: "43",
            label: "Other (fees, USD)",
            value: totalFormatted,
            status: "computed",
            rule: "7501 p.20",
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
        totalFields.push(
          field_helper({
            id,
            block: "44",
            label: "Total (USD)",
            value: totalFormatted,
            status: "computed",
            rule: "P10",
            inputs: ["B41", "B42", "B43"],
          })
        );
      }
    }
  }

  // Collect all fields before applying overrides
  const allFieldsList = [
    ...headerFields,
    ...draftLines.flatMap((line) => line.fields),
    ...totalFields,
  ];

  // Apply person value overrides
  for (const override of overrides) {
    const field = allFieldsList.find((f) => f.id === override.fieldId);
    if (!field) continue;

    // Parse value based on field kind
    let parseResult: { ok: boolean; value?: string | number; reason?: string } | null = null;
    let oldValue = field.value;
    let oldReason = field.reason;

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

              // Re-derive dependent fields in this line: .35 (unit), .37A (rate), .38 (duty)
              if (field.line) {
                const lineNum = field.line;
                
                // Update .35 unit from new HTS
                const field35 = allFieldsList.find((f) => f.id === `L${lineNum}.35`);
                if (field35) {
                  field35.unit = lookup.unit;
                  // If .35 was computed before, keep it; otherwise leave it as is
                  if (field35.status === "computed" || field35.status === "personEdited") {
                    // Keep its value; just update unit
                  } else if (field35.status === "needsReview" && field35.reason && field35.reason.includes("HTS number is not")) {
                    // Was waiting on HTS; try to recompute if we have quantity data
                    // For now, mark as needs review to be recomputed in recomputeTotals
                    field35.status = "needsReview";
                    field35.reason = "Re-derived from new HTS number; awaiting quantity recalculation.";
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
    }
  }

  // Rebuild totals section after applying overrides (recalculate B39..B44)
  // Clear and rebuild
  const totalFieldsMap = new Map(totalFields.map((f) => [f.id, f]));

  // Re-compute totals and line fields if any dependent values were overridden
  const recomputeTotals = () => {
    // After HTS or quantity overrides on a line, recompute:
    // - .35 (unit from HTS)
    // - .37A (rate from HTS)  
    // - .38 (duty from value and rate)
    // - B39, B41, B43, B44
    
    // First, for each line, check if .33A was personEdited and recompute .35 if it was waiting on HTS
    for (const line of draftLines) {
      const lineNum = line.lineNumber;
      const field33A = line.fields.find((f) => f.id === `L${lineNum}.33A`);
      const field35 = line.fields.find((f) => f.id === `L${lineNum}.35`);
      const field36A = line.fields.find((f) => f.id === `L${lineNum}.36A`);
      const field37A = line.fields.find((f) => f.id === `L${lineNum}.37A`);
      const field38 = line.fields.find((f) => f.id === `L${lineNum}.38`);
      
      // If .33A was personEdited and .35 is now marked as needs review due to HTS, recompute it
      if (field33A && field33A.status === "personEdited" && field35 && field35.status === "needsReview") {
        // Look up the new HTS to get unit
        const newHtsLookup = lookupHts(hts, field33A.value || "");
        if (newHtsLookup.found) {
          // Try to compute quantity from invoice data
          // Find the line numbers that map to this 7501 line
          const invoiceLineNumbers = line.invoiceLines;
          
          let totalQuantity: number | null = null;
          const quantityReadingSources: DocSource[] = [];

          for (const n of invoiceLineNumbers) {
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
              }
            }
          }

          if (totalQuantity !== null) {
            let displayValue = String(totalQuantity);
            const htsUnit = newHtsLookup.unit;
            if (htsUnit && htsUnit.toUpperCase() === "DZ PCS") {
              const dozenCount = totalQuantity / 12;
              if (dozenCount === Math.floor(dozenCount)) {
                displayValue = String(Math.floor(dozenCount));
              } else {
                displayValue = dozenCount.toFixed(2);
              }
            }

            field35.value = displayValue;
            field35.status = "computed";
            field35.rule = "P12";
            field35.unit = htsUnit;
            field35.sources = quantityReadingSources;
            field35.reason = null;
            field35.inputs = [];
          } else {
            field35.value = null;
            field35.status = "needsReview";
            field35.unit = newHtsLookup.unit;
            field35.reason = "Could not parse quantities from invoice lines.";
          }
        }
      }
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
              }
            }
          }
        }
      }
    }
    
    // Now handle duty recomputation
    for (const line of draftLines) {
      const lineNum = line.lineNumber;
      const field36A = line.fields.find((f) => f.id === `L${lineNum}.36A`);
      const field37A = line.fields.find((f) => f.id === `L${lineNum}.37A`);
      const field38 = line.fields.find((f) => f.id === `L${lineNum}.38`);

      // If .36A or .37A changed, recompute .38
      if (field38 && field36A && field37A) {
        // Only recompute if .38 is not personEdited and both inputs are available
        if (field38.status !== "personEdited" && field36A.status !== "needsReview" && field36A.value && 
            field37A.status !== "needsReview" && field37A.value) {
          const enteredDollars = parseInt(field36A.value, 10);
          const dutyResult = computeDuty(field37A.value, enteredDollars * 100);
          if (dutyResult.ok) {
            field38.value = formatCents(dutyResult.value);
            field38.status = "computed";
            field38.rule = "P7";
            field38.reason = null;
            field38.inputs = [`L${lineNum}.36A`, `L${lineNum}.37A`];
          }
        }
      }
    }

    // B39
    const lineValueIds = draftLines
      .map((line) => {
        const field = line.fields.find((f) => f.id.endsWith(".36A"));
        return field ? field.id : null;
      })
      .filter((id): id is string => id !== null);

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

    const b39Field = totalFieldsMap.get("B39");
    if (b39Field) {
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

    const b41Field = totalFieldsMap.get("B41");
    if (b41Field) {
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
        }
      }
    }
  };

  recomputeTotals();

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
  return {
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
