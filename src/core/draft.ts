import { normalizeSpace, Box } from "./pdfText";
import { VerifiedReading } from "./reading";
import { HtsTable } from "./hts";
import {
  parseMoneyToCents,
  parseCount,
  parseKgToTenths,
  parsePackages,
  parseUsDate,
  countryCode,
} from "./parse";

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
 * Helper: create a DraftField with common defaults.
 */
function field(overrides: Partial<DraftField>): DraftField {
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
    field({
      id: "B1",
      block: "1",
      label: "Filer code / entry number",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B2: personInput
  headerFields.push(
    field({
      id: "B2",
      block: "2",
      label: "Entry type",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B3: personInput
  headerFields.push(
    field({
      id: "B3",
      block: "3",
      label: "Summary date",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B4: personInput
  headerFields.push(
    field({
      id: "B4",
      block: "4",
      label: "Surety number",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B5: personInput
  headerFields.push(
    field({
      id: "B5",
      block: "5",
      label: "Bond type",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B6: needsReview
  headerFields.push(
    field({
      id: "B6",
      block: "6",
      label: "Port code",
      status: "needsReview",
      reason: "Schedule D code lookup not built. Port of discharge from B/L required.",
    })
  );

  // B7: personInput
  headerFields.push(
    field({
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
      field({
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
      field({
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
    field({
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
    field({
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
        field({
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
        field({
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
      field({
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
    field({
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
        field({
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
        field({
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
      field({
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
        field({
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
        field({
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
      field({
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
    field({
      id: "B19",
      block: "19",
      label: "Foreign port of lading",
      status: "needsReview",
      reason: "Schedule K code lookup not built. Port of loading from B/L required.",
    })
  );

  // B20: needsReview
  headerFields.push(
    field({
      id: "B20",
      block: "20",
      label: "U.S. port of unlading",
      status: "needsReview",
      reason: "Schedule D code lookup not built. Port of discharge from B/L required.",
    })
  );

  // B25: personInput
  headerFields.push(
    field({
      id: "B25",
      block: "25",
      label: "Location of goods / G.O. number",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B26: personInput
  headerFields.push(
    field({
      id: "B26",
      block: "26",
      label: "Consignee number",
      status: "personInput",
      reason: "Tax and CBP identifiers are never read or stored.",
    })
  );

  // B27: personInput
  headerFields.push(
    field({
      id: "B27",
      block: "27",
      label: "Importer number",
      status: "personInput",
      reason: "Tax and CBP identifiers are never read or stored.",
    })
  );

  // B28: personInput
  headerFields.push(
    field({
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
      field({
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
      field({
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
      field({
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
      field({
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
    field({
      id: "B36C",
      block: "36C",
      label: "Relationship (related party Y/N)",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B40: personInput
  headerFields.push(
    field({
      id: "B40",
      block: "40",
      label: "Declaration (importer or agent)",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B45: personInput
  headerFields.push(
    field({
      id: "B45",
      block: "45",
      label: "Declarant name, title, signature, date",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B46: personInput
  headerFields.push(
    field({
      id: "B46",
      block: "46",
      label: "Broker / filer information",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  // B47: personInput
  headerFields.push(
    field({
      id: "B47",
      block: "47",
      label: "Broker / importer file number",
      status: "personInput",
      reason: "Required data entry by filer.",
    })
  );

  return {
    notice: DRAFT_NOTICE,
    bundle,
    reader,
    htsRevision: hts.revision,
    htsRevisionTitle: hts.revisionTitle,
    header: headerFields,
    lines: [],
    totals: [],
    checks,
    rejectedReadings,
    needsReview: [],
    personInput: [],
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
