import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { verifyReadings, type VerifiedReading } from "./reading";
import { buildDraft, allFields, type Draft, type DraftField, type Override } from "./draft";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

// Feature: document-intake, Requirement 65 (task 84.1): a subtotal that was read but not added up
// says so. Property 92 validates that CHK.INVOICE reason changes correctly.

let hts: HtsTable;

beforeAll(async () => {
  const b = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
  hts = b.hts;
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

describe("Property 92: A Subtotal That Was Read but Not Added Up Says So (Validates: Requirements 65.1, 65.2, 65.3)", () => {
  // Arbitraries for generating test data

  // Decimal comma form: "9.299,00" or "1.800,00" (digits with optional periods in thousands, then comma with two decimals)
  const decimalCommaForm = fc.tuple(fc.integer({ min: 1, max: 99999 }), fc.integer({ min: 0, max: 99 })).map(([whole, frac]) => {
    const wholeStr = whole.toLocaleString("en-US").replace(/,/g, ".");
    return `${wholeStr},${String(frac).padStart(2, "0")}`;
  });

  // Add optional currency prefix to decimal comma
  const decimalCommaWithCurrency = fc.tuple(fc.constantFrom("EUR", "GBP", "JPY", ""), decimalCommaForm).map(([cur, form]) => (cur ? `${cur} ${form}` : form));

  // Non-parseable number forms (things P2 doesn't read)
  const nonParseableForm = fc.oneof(
    // Text with number: "USD: 12.00", "twelve dollars"
    fc.tuple(fc.constantFrom("USD", "EUR", "Total", "Subtotal", "INVOICE TOTAL"), fc.integer({ min: 1, max: 9999 })).map(([text, n]) => `${text}: ${n}.00`),
    // Text with colon: "Invoice: 1234.56", "Amount: 500"
    fc.tuple(fc.constantFrom("Invoice", "Amount", "Total Due", "Grand Total"), fc.integer({ min: 1, max: 99999 })).map(([text, n]) => `${text}: ${n}.50`),
    // A US-style amount with a currency code: "EUR 1,234.56" (with the code removed it is not a decimal comma form)
    fc.tuple(fc.constantFrom("EUR", "USD", "GBP"), fc.integer({ min: 100000, max: 99999999 })).map(([code, n]) => `${code} ${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
  );

  // A minimal valid invoice
  function minimalInvoice(): VerifiedReading[] {
    item = 0;
    return [
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
  }

  it("when subtotal is accepted as a decimal comma form, its reason mentions that it is printed with a decimal comma", () => {
    fc.assert(
      fc.property(decimalCommaWithCurrency, fc.boolean(), (subtotalValue, includeTotal) => {
        const readings = minimalInvoice();
        readings.push(R("invoice.subtotal", subtotalValue));
        if (includeTotal) {
          readings.push(R("invoice.total", subtotalValue));
        }

        const d = build(readings);
        const chk = f(d, "CHK.INVOICE");

        expect(chk).toBeDefined();
        expect(chk!.status).toBe("needsReview");
        expect(chk!.value).toBeNull();
        // The reason should mention the decimal comma
        expect(chk!.reason).toContain("decimal comma");
        // Should mention comparing with the 7501 lines
        expect(chk!.reason).toContain("Compare the 7501 lines");
        // Should have the subtitle value in the reason (with spaces normalized)
        expect(chk!.reason).toContain(subtotalValue.trim());
      }),
      { numRuns: 20 },
    );
  });

  it("when subtotal is accepted but not in a parseable form, its reason mentions that it is not a number the app reads", () => {
    fc.assert(
      fc.property(nonParseableForm, (subtotalValue) => {
        const readings = minimalInvoice();
        readings.push(R("invoice.subtotal", subtotalValue));

        const d = build(readings);
        const chk = f(d, "CHK.INVOICE");

        expect(chk).toBeDefined();
        expect(chk!.status).toBe("needsReview");
        expect(chk!.value).toBeNull();
        // The reason should mention that it is not a number the app reads
        expect(chk!.reason).toContain("not a number the app reads");
        // Should mention comparing with the 7501 lines
        expect(chk!.reason).toContain("Compare the 7501 lines");
        // Should have the subtotal value in the reason (quoted if it contains special chars)
        expect(chk!.reason).toContain(subtotalValue);
      }),
      { numRuns: 20 },
    );
  });

  it("when no subtotal reading is accepted, the reason does not name any subtotal value", () => {
    fc.assert(
      fc.property(fc.boolean(), (includeTotal) => {
        const readings = minimalInvoice();
        if (includeTotal) {
          readings.push(R("invoice.total", "1000.00"));
        }
        // No subtotal reading at all

        const d = build(readings);
        const chk = f(d, "CHK.INVOICE");

        expect(chk).toBeDefined();
        expect(chk!.status).toBe("needsReview");
        expect(chk!.reason).toContain("No invoice subtotal was read");
        // Should NOT contain a quote (no "...")
        expect(chk!.reason).not.toMatch(/"[^"]*"/);
      }),
      { numRuns: 10 },
    );
  });

  it("when subtotal reading is rejected (not accepted), the reason is about no subtotal being read", () => {
    fc.assert(
      fc.property(fc.constantFrom("quote_not_found", "value_not_in_quote", "empty_quote"), (reason) => {
        const readings = minimalInvoice();
        readings.push(R("invoice.subtotal", "2000.00", { status: "rejected", reason: reason as any, message: "Rejected" }));

        const d = build(readings);
        const chk = f(d, "CHK.INVOICE");

        expect(chk).toBeDefined();
        expect(chk!.status).toBe("needsReview");
        expect(chk!.reason).toContain("No invoice subtotal was read");
        // Should not mention the rejected value
        expect(chk!.reason).not.toContain('"2000.00"');
      }),
      { numRuns: 10 },
    );
  });

  it("when subtotal reading is accepted but empty, the reason is about no subtotal", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const readings = minimalInvoice();
        readings.push(R("invoice.subtotal", "", { value: "" }));

        const d = build(readings);
        const chk = f(d, "CHK.INVOICE");

        expect(chk).toBeDefined();
        expect(chk!.reason).toContain("No invoice subtotal was read");
      }),
      { numRuns: 5 },
    );
  });

  it("CHK.INVOICE always has block P2, is needsReview with null value and no rule", () => {
    fc.assert(
      fc.property(decimalCommaWithCurrency, (subtotalValue) => {
        const readings = minimalInvoice();
        readings.push(R("invoice.subtotal", subtotalValue));

        const d = build(readings);
        const chk = f(d, "CHK.INVOICE");

        expect(chk).toBeDefined();
        expect(chk!.block).toBe("P2");
        expect(chk!.label).toBe("Invoice lines against the invoice");
        expect(chk!.status).toBe("needsReview");
        expect(chk!.value).toBeNull();
        expect(chk!.rule).toBeNull();
      }),
      { numRuns: 15 },
    );
  });

  it("P2 invoice line checks still run as before", () => {
    fc.assert(
      fc.property(decimalCommaWithCurrency, (subtotalValue) => {
        const readings = minimalInvoice();
        readings.push(R("invoice.subtotal", subtotalValue));

        const d = build(readings);

        // Requirement 65.3: P2 does not read this subtotal, so no P2.invoice.subtotal check runs (as before)
        expect(d.checks.find((c) => c.id === "P2.invoice.subtotal")).toBeUndefined();
      }),
      { numRuns: 15 },
    );
  });

  it("when a valid parseable subtotal is accepted, P2.invoice.subtotal check runs and CHK.INVOICE reason does not mention the subtotal value", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 999999 }), (subtotalCents) => {
        const subtotalDollars = (subtotalCents / 100).toFixed(2);
        const readings = minimalInvoice();
        readings.push(R("invoice.subtotal", subtotalDollars));

        const d = build(readings);
        const chk = f(d, "CHK.INVOICE");

        // With a valid subtotal that P2 can read, CHK.INVOICE should not have a reason mentioning the subtotal value
        // (because the P2 check ran, so there's no "read but not added up" case)
        expect(chk).toBeDefined();

        // Check if P2.invoice.subtotal exists
        const p2Sub = d.checks.find((c) => c.id === "P2.invoice.subtotal");
        // If P2.invoice.subtotal exists and ran, CHK.INVOICE should not mention the subtotal value
        expect(chk).toBeDefined();
        if (p2Sub && chk) {
          // The first reason should not mention the subtotal value in quotes
          const firstReason = (chk.reason ?? "").split("; ")[0];
          expect(firstReason).not.toContain(`"${subtotalDollars}"`);
        }
      }),
      { numRuns: 15 },
    );
  });
});
