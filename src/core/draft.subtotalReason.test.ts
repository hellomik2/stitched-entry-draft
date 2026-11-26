import { describe, it, expect, beforeAll } from "vitest";
import { verifyReadings, type VerifiedReading } from "./reading";
import { buildDraft, allFields, type Draft, type DraftField, type Override } from "./draft";
import { draftToCsv, parseCsv } from "./csv";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Feature: document-intake, Requirement 65 (task 84.1): a subtotal that was read but not added up
// says so. The CHK.INVOICE field reasons change when the subtotal reading is accepted but no P2 check ran.

let hts: HtsTable;
let sample: VerifiedReading[];
let demo: Override[];

beforeAll(async () => {
  const b = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
  hts = b.hts;
  sample = verifyReadings(b.answer, b.documents);
  demo = JSON.parse(readFileSync(join(process.cwd(), "samples", "lantern-hollow", "overrides-demo.json"), "utf8")).overrides;
});

let item = 0;
const R = (field: string, value: string, more: Record<string, unknown> = {}): VerifiedReading =>
  ({
    field,
    value,
    quote: value,
    doc: "invoice",
    page: 1,
    confidence: "high",
    status: "accepted",
    box: { x: 10, y: 10 + item, w: 10, h: 8 },
    itemIds: [`invoice:p1:i${++item}`],
    ...more,
  }) as VerifiedReading;

const build = (readings: VerifiedReading[], overrides: Override[] = []): Draft =>
  buildDraft({ bundle: "test", reader: "test", readings, hts, overrides, invoiceLineCount: null, packingListLineCount: null } as Parameters<typeof buildDraft>[0]);

const f = (d: Draft, id: string): DraftField | undefined => allFields(d).find((x) => x.id === id);

describe("Requirement 65: CHK.INVOICE Reason When Subtotal Was Read but Not Added Up (Example Tests)", () => {
  describe("Example 65.1: Subtotal in decimal comma form (not read by P2)", () => {
    it("when subtotal is accepted as decimal comma, CHK.INVOICE first reason mentions it", () => {
      // The recorded read of bundle B: the subtotal "EUR 9.299,00" is accepted but P2 does not read decimal comma
      const readings: VerifiedReading[] = [
        R("invoice.currency", "EUR"),
        R("invoice.lines.1.itemNo", "DG-01"),
        R("invoice.lines.1.description", "Item 1"),
        R("invoice.lines.1.hts", "9505.90.6000"),
        R("invoice.lines.1.origin", "DE"),
        R("invoice.lines.1.quantity", "120"),
        R("invoice.lines.1.unit", "DZ"),
        R("invoice.lines.1.unitPrice", "18,00"),
        R("invoice.lines.1.amount", "2.160,00"),
        // subtotal with decimal comma: not parsed by P2
        R("invoice.subtotal", "EUR 9.299,00"),
        R("invoice.total", "EUR 9.299,00"),
      ];

      const d = build(readings);
      const chk = f(d, "CHK.INVOICE");

      expect(chk).toBeDefined();
      expect(chk!.status).toBe("needsReview");
      expect(chk!.value).toBeNull();
      expect(chk!.reason).toBe('The invoice subtotal "EUR 9.299,00" is printed with a decimal comma, so the invoice line amounts were not added up against it. Compare the 7501 lines with the invoice.');
    });
  });

  describe("Example 65.2: Subtotal in another unparseable form (not read by P2)", () => {
    it("when subtotal is accepted but not in a parseable number form, CHK.INVOICE first reason mentions it", () => {
      // A subtotal in a form that P2 does not read (e.g., with a currency symbol that makes it not parse)
      const readings: VerifiedReading[] = [
        R("invoice.currency", "USD"),
        R("invoice.lines.1.itemNo", "ITEM-001"),
        R("invoice.lines.1.description", "Product"),
        R("invoice.lines.1.hts", "6204.62.2050"),
        R("invoice.lines.1.origin", "VN"),
        R("invoice.lines.1.quantity", "100"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "10.00"),
        R("invoice.lines.1.amount", "1000.00"),
        // subtotal in a form P2 does not read (e.g., with extra text)
        R("invoice.subtotal", "Subtotal: $1000.00 USD"),
        R("invoice.total", "Total: $1000.00 USD"),
      ];

      const d = build(readings);
      const chk = f(d, "CHK.INVOICE");

      expect(chk).toBeDefined();
      expect(chk!.status).toBe("needsReview");
      expect(chk!.value).toBeNull();
      expect(chk!.reason).toBe('The invoice subtotal "Subtotal: $1000.00 USD" is not a number the app reads, so the invoice line amounts were not added up against it. Compare the 7501 lines with the invoice.');
    });
  });

  describe("Example 65.2b: Subtotal with decimal comma but no currency code", () => {
    it("when subtotal is decimal comma with no currency code, CHK.INVOICE first reason mentions the decimal comma form", () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "EUR"),
        R("invoice.lines.1.itemNo", "DG-01"),
        R("invoice.lines.1.description", "Item 1"),
        R("invoice.lines.1.hts", "9505.90.6000"),
        R("invoice.lines.1.origin", "DE"),
        R("invoice.lines.1.quantity", "120"),
        R("invoice.lines.1.unit", "DZ"),
        R("invoice.lines.1.unitPrice", "18,00"),
        R("invoice.lines.1.amount", "2.160,00"),
        // subtotal with decimal comma but no currency code
        R("invoice.subtotal", "9.299,00"),
        R("invoice.total", "9.299,00"),
      ];

      const d = build(readings);
      const chk = f(d, "CHK.INVOICE");

      expect(chk).toBeDefined();
      expect(chk!.status).toBe("needsReview");
      expect(chk!.value).toBeNull();
      expect(chk!.reason).toBe('The invoice subtotal "9.299,00" is printed with a decimal comma, so the invoice line amounts were not added up against it. Compare the 7501 lines with the invoice.');
    });
  });

  describe("Example 65.2c: A US-style amount with a currency code is not a decimal comma", () => {
    it('when the subtotal is "EUR 1,234.56", CHK.INVOICE says it is not a number the app reads', () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "EUR"),
        R("invoice.lines.1.itemNo", "DG-01"),
        R("invoice.lines.1.description", "Item 1"),
        R("invoice.lines.1.hts", "9505.90.6000"),
        R("invoice.lines.1.origin", "DE"),
        R("invoice.lines.1.quantity", "1"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "1,234.56"),
        R("invoice.lines.1.amount", "1,234.56"),
        R("invoice.subtotal", "EUR 1,234.56"),
        R("invoice.total", "EUR 1,234.56"),
      ];
      const chk = f(build(readings), "CHK.INVOICE");
      expect(chk!.status).toBe("needsReview");
      expect(chk!.value).toBeNull();
      expect(chk!.reason).toBe('The invoice subtotal "EUR 1,234.56" is not a number the app reads, so the invoice line amounts were not added up against it. Compare the 7501 lines with the invoice.');
    });
  });

  describe("Example 65.3: Subtotal reading that is not accepted", () => {
    it("when no subtotal reading is accepted, the reason does not mention a subtotal value", () => {
      // No subtotal reading, or subtotal reading rejected
      const readings: VerifiedReading[] = [
        R("invoice.currency", "USD"),
        R("invoice.lines.1.itemNo", "ITEM-001"),
        R("invoice.lines.1.description", "Product"),
        R("invoice.lines.1.hts", "6204.62.2050"),
        R("invoice.lines.1.origin", "VN"),
        R("invoice.lines.1.quantity", "100"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "10.00"),
        R("invoice.lines.1.amount", "1000.00"),
        // No subtotal or rejected subtotal
        R("invoice.total", "1000.00"),
      ];

      const d = build(readings);
      const chk = f(d, "CHK.INVOICE");

      expect(chk).toBeDefined();
      expect(chk!.status).toBe("needsReview");
      expect(chk!.reason).toContain("No invoice subtotal was read");
      expect(chk!.reason).toContain("so the invoice line amounts were not added up against it");
      // Should NOT mention a subtotal value
      expect(chk!.reason).not.toContain('"');
    });
  });

  describe("Example 65.4: Invoice without a subtotal reading at all", () => {
    it("when invoice has no subtotal field, CHK.INVOICE says no subtotal was read", () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "USD"),
        R("invoice.lines.1.itemNo", "ITEM-001"),
        R("invoice.lines.1.description", "Product"),
        R("invoice.lines.1.hts", "6204.62.2050"),
        R("invoice.lines.1.origin", "VN"),
        R("invoice.lines.1.quantity", "100"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "10.00"),
        R("invoice.lines.1.amount", "1000.00"),
        R("invoice.total", "1000.00"),
      ];

      const d = build(readings);
      const chk = f(d, "CHK.INVOICE");

      expect(chk).toBeDefined();
      expect(chk!.status).toBe("needsReview");
      expect(chk!.reason).toContain("No invoice subtotal was read");
    });
  });

  describe("Example 65.5: Subtotal reading rejected (not accepted)", () => {
    it("when subtotal reading is rejected, the reason is about no subtotal being read", () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "USD"),
        R("invoice.lines.1.itemNo", "ITEM-001"),
        R("invoice.lines.1.description", "Product"),
        R("invoice.lines.1.hts", "6204.62.2050"),
        R("invoice.lines.1.origin", "VN"),
        R("invoice.lines.1.quantity", "100"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "10.00"),
        R("invoice.lines.1.amount", "1000.00"),
        // Subtotal reading that is rejected (not accepted status)
        R("invoice.subtotal", "2000.00", { status: "rejected", reason: "quote_not_found", message: "Quote not on page" }),
        R("invoice.total", "1000.00"),
      ];

      const d = build(readings);
      const chk = f(d, "CHK.INVOICE");

      expect(chk).toBeDefined();
      expect(chk!.status).toBe("needsReview");
      expect(chk!.reason).toContain("No invoice subtotal was read");
      // Should not mention the rejected reading's value
      expect(chk!.reason).not.toContain('"2000.00"');
    });
  });

  describe("Example 65.6: Empty subtotal reading that is accepted", () => {
    it("when subtotal reading is accepted but its value is empty, the reason is about no subtotal", () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "USD"),
        R("invoice.lines.1.itemNo", "ITEM-001"),
        R("invoice.lines.1.description", "Product"),
        R("invoice.lines.1.hts", "6204.62.2050"),
        R("invoice.lines.1.origin", "VN"),
        R("invoice.lines.1.quantity", "100"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "10.00"),
        R("invoice.lines.1.amount", "1000.00"),
        // Subtotal reading that is accepted but empty
        R("invoice.subtotal", ""),
        R("invoice.total", "1000.00"),
      ];

      const d = build(readings);
      const chk = f(d, "CHK.INVOICE");

      expect(chk).toBeDefined();
      expect(chk!.reason).toContain("No invoice subtotal was read");
    });
  });

  describe("Requirement 65 sanity checks: P2 checks not changed", () => {
    it("when subtotal is not parseable, P2.invoice.subtotal check does not exist", () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "USD"),
        R("invoice.lines.1.itemNo", "ITEM-001"),
        R("invoice.lines.1.description", "Product"),
        R("invoice.lines.1.hts", "6204.62.2050"),
        R("invoice.lines.1.origin", "VN"),
        R("invoice.lines.1.quantity", "100"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "10.00"),
        R("invoice.lines.1.amount", "1000.00"),
        R("invoice.subtotal", "9.299,00 EUR"),
        R("invoice.total", "1000.00"),
      ];

      const d = build(readings);

      // P2.invoice.subtotal check should not exist when subtotal is not parseable
      const p2Sub = d.checks.find((c) => c.id === "P2.invoice.subtotal");
      expect(p2Sub).toBeUndefined();
    });

    it("when subtotal is parseable and matches the line amount, P2.invoice.subtotal check runs and is ok", () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "USD"),
        R("invoice.lines.1.itemNo", "ITEM-001"),
        R("invoice.lines.1.description", "Product"),
        R("invoice.lines.1.hts", "6204.62.2050"),
        R("invoice.lines.1.origin", "VN"),
        R("invoice.lines.1.quantity", "100"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "10.00"),
        R("invoice.lines.1.amount", "1000.00"),
        R("invoice.subtotal", "1000.00"),
        R("invoice.total", "1000.00"),
      ];

      const d = build(readings);

      // P2.invoice.subtotal check should exist
      const p2Sub = d.checks.find((c) => c.id === "P2.invoice.subtotal");
      expect(p2Sub).toBeDefined();
      expect(p2Sub!.ok).toBe(true);
    });
  });

  describe("Requirement 65 sanity checks: CHK.INVOICE block and status", () => {
    it("CHK.INVOICE always has block P2 and label as specified", () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "USD"),
        R("invoice.lines.1.itemNo", "ITEM-001"),
        R("invoice.lines.1.description", "Product"),
        R("invoice.lines.1.hts", "6204.62.2050"),
        R("invoice.lines.1.origin", "VN"),
        R("invoice.lines.1.quantity", "100"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "10.00"),
        R("invoice.lines.1.amount", "1000.00"),
        R("invoice.subtotal", "USD 1000.00 not parseable"),
        R("invoice.total", "1000.00"),
      ];

      const d = build(readings);
      const chk = f(d, "CHK.INVOICE");

      expect(chk).toBeDefined();
      expect(chk!.block).toBe("P2");
      expect(chk!.label).toBe("Invoice lines against the invoice");
      expect(chk!.status).toBe("needsReview");
      expect(chk!.value).toBeNull();
    });
  });

  describe("Requirement 65 sanity checks: CSV contains CHK.INVOICE", () => {
    it("CSV includes CHK.INVOICE with its reason", () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "USD"),
        R("invoice.lines.1.itemNo", "ITEM-001"),
        R("invoice.lines.1.description", "Product"),
        R("invoice.lines.1.hts", "6204.62.2050"),
        R("invoice.lines.1.origin", "VN"),
        R("invoice.lines.1.quantity", "100"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "10.00"),
        R("invoice.lines.1.amount", "1000.00"),
        R("invoice.subtotal", "9.299,00 EUR"),
        R("invoice.total", "1000.00"),
      ];

      const d = build(readings);
      const csv = draftToCsv(d);
      const rows = parseCsv(csv);

      const chkRow = rows.find((r) => r[0] === "CHK.INVOICE");
      expect(chkRow).toBeDefined();
      expect(chkRow![1]).toBe("P2");
      expect(chkRow![6]).toBe("needsReview");
      const reasonColumn = 9;
      expect(chkRow![reasonColumn]).toBe('The invoice subtotal "9.299,00 EUR" is printed with a decimal comma, so the invoice line amounts were not added up against it. Compare the 7501 lines with the invoice.');
    });
  });
});
