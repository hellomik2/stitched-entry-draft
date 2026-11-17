import { intakeConfig } from "./intakeConfig";

const INVOICE_HEADER_FIELDS = [
  { name: "invoice.number", description: "Invoice number exactly as printed on the invoice" },
  { name: "invoice.date", description: "Invoice date in MM/DD/YYYY format" },
  { name: "invoice.terms", description: "Terms of sale (e.g., FOB, CIF) exactly as printed" },
  { name: "invoice.currency", description: "Currency code (e.g., USD, EUR) from the invoice" },
  { name: "invoice.countryOfExport", description: "Country of export exactly as printed or standard name" },
  { name: "invoice.seller.name", description: "Seller/exporter name exactly as printed on invoice" },
  { name: "invoice.seller.address", description: "Seller/exporter address exactly as printed on invoice" },
  { name: "invoice.buyer.name", description: "Buyer/importer name exactly as printed on invoice" },
  { name: "invoice.buyer.address", description: "Buyer/importer address exactly as printed on invoice" },
  { name: "invoice.shipTo.name", description: "Ship-to party name exactly as printed on invoice" },
  { name: "invoice.shipTo.address", description: "Ship-to address exactly as printed on invoice" },
] as const;

const INVOICE_LINE_BASE_FIELDS = [
  "itemNo",
  "description",
  "hts",
  "origin",
  "quantity",
  "unit",
  "unitPrice",
  "amount",
] as const;

const INVOICE_LINE_FIELDS = Array.from({ length: intakeConfig.maxInvoiceLines }, (_, i) => {
  const lineNum = i + 1;
  return INVOICE_LINE_BASE_FIELDS.map((field) => ({
    name: `invoice.lines.${lineNum}.${field}`,
    description:
      field === "hts"
        ? `HTS number exactly as printed on invoice line ${lineNum}; never chosen or corrected`
        : field === "origin"
          ? `Country of origin code exactly as printed on invoice line ${lineNum}`
          : `${field} from invoice line ${lineNum}`,
  }));
});

const INVOICE_TOTALS = [
  { name: "invoice.subtotal", description: "Invoice subtotal amount exactly as printed" },
  { name: "invoice.total", description: "Invoice total amount exactly as printed" },
] as const;

const PACKING_LIST_HEADER_FIELDS = [
  { name: "packingList.number", description: "Packing list number exactly as printed" },
  { name: "packingList.invoiceRef", description: "Invoice reference on the packing list" },
  { name: "packingList.blNumber", description: "Bill of lading number reference on the packing list" },
] as const;

const PACKING_LIST_LINE_BASE_FIELDS = ["itemNo", "cartons", "quantity", "netKg", "grossKg"] as const;

const PACKING_LIST_LINE_FIELDS = Array.from({ length: 8 }, (_, i) => {
  const lineNum = i + 1;
  return PACKING_LIST_LINE_BASE_FIELDS.map((field) => ({
    name: `packingList.lines.${lineNum}.${field}`,
    description: `${field} for packing list line ${lineNum}`,
  }));
});

const PACKING_LIST_TOTALS = [
  { name: "packingList.totalCartons", description: "Total number of cartons on the packing list" },
  { name: "packingList.totalQuantity", description: "Total quantity of all items on the packing list" },
  { name: "packingList.totalNetKg", description: "Total net weight in kilograms on the packing list" },
  { name: "packingList.totalGrossKg", description: "Total gross weight in kilograms on the packing list" },
] as const;

const BILL_OF_LADING_FIELDS = [
  { name: "billOfLading.number", description: "Bill of lading number exactly as printed" },
  { name: "billOfLading.carrier", description: "Carrier/shipping line name exactly as printed" },
  { name: "billOfLading.consignee.name", description: "Consignee name exactly as printed on B/L" },
  { name: "billOfLading.vessel", description: "Vessel name exactly as printed on B/L" },
  { name: "billOfLading.voyage", description: "Voyage number exactly as printed on B/L" },
  { name: "billOfLading.portOfLoading", description: "Port of loading exactly as printed on B/L" },
  { name: "billOfLading.portOfDischarge", description: "Port of discharge exactly as printed on B/L" },
  { name: "billOfLading.onBoardDate", description: "On-board date in MM/DD/YYYY format" },
  { name: "billOfLading.containerNo", description: "Container number exactly as printed on B/L" },
  { name: "billOfLading.packages", description: "Packages description exactly as printed on B/L" },
  { name: "billOfLading.grossKg", description: "Gross weight in kilograms from B/L" },
] as const;

export const FIELD_CATALOG = [
  ...INVOICE_HEADER_FIELDS,
  ...INVOICE_LINE_FIELDS.flat(),
  ...INVOICE_TOTALS,
  ...PACKING_LIST_HEADER_FIELDS,
  ...PACKING_LIST_LINE_FIELDS.flat(),
  ...PACKING_LIST_TOTALS,
  ...BILL_OF_LADING_FIELDS,
] as const;

export function isCatalogField(name: string): boolean {
  return FIELD_CATALOG.some((field) => field.name === name);
}
