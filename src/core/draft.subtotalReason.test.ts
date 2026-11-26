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

// 9505.90.6000 is in data/hts/2026HTSRev23-subset.json.
const HTS = "9505.90.6000";

const TAIL = ", so the invoice line amounts were not added up against it. Compare the 7501 lines with the invoice.";
const NO_SUBTOTAL = `No invoice subtotal was read${TAIL}`;
const commaReason = (v: string) => `The invoice subtotal "${v}" is printed with a decimal comma${TAIL}`;
const notNumberReason = (v: string) => `The invoice subtotal "${v}" is not a number the app reads${TAIL}`;

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

const build = (readings: VerifiedReading[], overrides: Override[] = [], invoiceLineCount: number | null = null): Draft =>
  buildDraft({ bundle: "test", reader: "test", readings, hts, overrides, invoiceLineCount, packingListLineCount: null } as Parameters<typeof buildDraft>[0]);

const f = (d: Draft, id: string): DraftField | undefined => allFields(d).find((x) => x.id === id);

// The source CHK.INVOICE must carry for an accepted reading (Requirement 19.1), written out as the expected value.
const src = (r: VerifiedReading) => ({
  kind: "document",
  doc: r.doc,
  page: r.page,
  quote: r.quote.replace(/\s+/g, " ").trim(),
  box: (r as { box: unknown }).box,
  readingField: r.field,
});

// One USD invoice line of 1000.00, without subtotal and total.
const usdLine = (): VerifiedReading[] => [
  R("invoice.currency", "USD"),
  R("invoice.lines.1.itemNo", "ITEM-001"),
  R("invoice.lines.1.description", "Product"),
  R("invoice.lines.1.hts", HTS),
  R("invoice.lines.1.origin", "VN"),
  R("invoice.lines.1.quantity", "100"),
  R("invoice.lines.1.unit", "PCS"),
  R("invoice.lines.1.unitPrice", "10.00"),
  R("invoice.lines.1.amount", "1000.00"),
];

/** Checks the whole CHK.INVOICE of a subtotal that was accepted but not added up (Requirements 65.1 and 65.3). */
function expectNotAddedUp(value: string, expectedReason: string) {
  const sub = R("invoice.subtotal", value);
  const total = R("invoice.total", "1000.00");
  const d = build([...usdLine(), sub, total]);
  const chk = f(d, "CHK.INVOICE");
  expect(d.checks.filter((c) => c.rule === "P2")).toEqual([]);
  expect(chk?.reason).toBe(expectedReason);
  expect(chk?.status).toBe("needsReview");
  expect(chk?.value).toBeNull();
  expect(chk?.rule).toBeNull();
  expect(chk?.sources).toEqual([src(sub), src(total)]);
  expect(chk?.inputs).toEqual([]);
}

describe("Requirement 65: CHK.INVOICE Reason When Subtotal Was Read but Not Added Up (Example Tests)", () => {
  describe("Example 65.1: Subtotal in decimal comma form (not read by P2)", () => {
    it("Requirement 65.1: the subtotal \"EUR 9.299,00\" of the bundle B example gives the decimal comma reason", () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "EUR"),
        R("invoice.lines.1.itemNo", "DG-01"),
        R("invoice.lines.1.description", "Item 1"),
        R("invoice.lines.1.hts", HTS),
        R("invoice.lines.1.origin", "DE"),
        R("invoice.lines.1.quantity", "120"),
        R("invoice.lines.1.unit", "DZ"),
        R("invoice.lines.1.unitPrice", "18,00"),
        R("invoice.lines.1.amount", "2.160,00"),
        R("invoice.subtotal", "EUR 9.299,00"),
        R("invoice.total", "EUR 9.299,00"),
      ];

      const chk = f(build(readings), "CHK.INVOICE");

      expect(chk?.status).toBe("needsReview");
      expect(chk?.value).toBeNull();
      expect(chk?.reason).toBe(commaReason("EUR 9.299,00"));
    });

    // One leading and one trailing three-capital-letter code, "€" or "$" are removed; spaces are normalized.
    it.each([
      ["9.299,00", "9.299,00"],
      ["9299,00", "9299,00"],
      ["9.299,00 EUR", "9.299,00 EUR"],
      ["9.299,00 USD", "9.299,00 USD"],
      ["EUR9.299,00", "EUR9.299,00"],
      ["€ 9.299,00", "€ 9.299,00"],
      ["€9.299,00", "€9.299,00"],
      ["9.299,00 €", "9.299,00 €"],
      ["9.299,00€", "9.299,00€"],
      ["$9.299,00", "$9.299,00"],
      ["$ 9.299,00", "$ 9.299,00"],
      ["9.299,00 $", "9.299,00 $"],
      ["9.299,00$", "9.299,00$"],
      ["EUR 9.299,00 EUR", "EUR 9.299,00 EUR"],
      ["€ 0,50 EUR", "€ 0,50 EUR"],
      ["  EUR   9.299,00\t", "EUR 9.299,00"],
      ["9.299,00 \n $", "9.299,00 $"],
    ])("Requirement 65.1: subtotal %j gives the decimal comma reason with %j", (value, normalized) => {
      expectNotAddedUp(value, commaReason(normalized));
    });
  });

  describe("Example 65.2: Subtotal in another form (not read by P2)", () => {
    it.each([
      ["Subtotal: $1000.00 USD", "Subtotal: $1000.00 USD"],
      ["EUR 1,234.56", "EUR 1,234.56"],
      ["$ 1,234.56", "$ 1,234.56"],
      ["1,234.56 $", "1,234.56 $"],
      ["€ 1,234.56", "€ 1,234.56"],
      ["EUR EUR 9.299,00", "EUR EUR 9.299,00"],
      ["9.299,00 EUR EUR", "9.299,00 EUR EUR"],
      ["$$9.299,00", "$$9.299,00"],
      ["eur 9.299,00", "eur 9.299,00"],
      ["EUR 9.299,000", "EUR 9.299,000"],
      ["EUR 9,5", "EUR 9,5"],
      ["EUR 12.34,56", "EUR 12.34,56"],
      ["  EUR\t\t1,234.56  ", "EUR 1,234.56"],
    ])("Requirement 65.1: subtotal %j gives the reason that %j is not a number the app reads", (value, normalized) => {
      expectNotAddedUp(value, notNumberReason(normalized));
    });
  });

  describe("Example 65.2c: A US-style amount with a currency code is not a decimal comma", () => {
    it('Requirement 65.1: when the subtotal is "EUR 1,234.56", CHK.INVOICE says it is not a number the app reads', () => {
      const readings: VerifiedReading[] = [
        R("invoice.currency", "EUR"),
        R("invoice.lines.1.itemNo", "DG-01"),
        R("invoice.lines.1.description", "Item 1"),
        R("invoice.lines.1.hts", HTS),
        R("invoice.lines.1.origin", "DE"),
        R("invoice.lines.1.quantity", "1"),
        R("invoice.lines.1.unit", "PCS"),
        R("invoice.lines.1.unitPrice", "1,234.56"),
        R("invoice.lines.1.amount", "1,234.56"),
        R("invoice.subtotal", "EUR 1,234.56"),
        R("invoice.total", "EUR 1,234.56"),
      ];
      const chk = f(build(readings), "CHK.INVOICE");
      expect(chk?.status).toBe("needsReview");
      expect(chk?.value).toBeNull();
      expect(chk?.reason).toBe(notNumberReason("EUR 1,234.56"));
    });
  });

  describe("Example 65.3: Subtotal reading that is not accepted, or empty", () => {
    it("Requirement 65.2: without a subtotal reading the reason is the no-subtotal reason", () => {
      const total = R("invoice.total", "1000.00");
      const chk = f(build([...usdLine(), total]), "CHK.INVOICE");
      expect(chk?.status).toBe("needsReview");
      expect(chk?.value).toBeNull();
      expect(chk?.reason).toBe(NO_SUBTOTAL);
      expect(chk?.sources).toEqual([src(total)]);
      expect(chk?.inputs).toEqual([]);
    });

    it("Requirement 65.2: a rejected subtotal reading gives the no-subtotal reason and is not a source", () => {
      const base = [...usdLine(), R("invoice.total", "1000.00")];
      const without = f(build(base), "CHK.INVOICE");
      const sub = R("invoice.subtotal", "EUR 9.299,00", { status: "rejected", reason: "quote_not_found", message: "Quote not on page" });
      const chk = f(build([...base, sub]), "CHK.INVOICE");
      expect(chk?.reason).toBe(NO_SUBTOTAL);
      expect(chk).toEqual(without);
    });

    it("Requirement 65.3 (Property 92): a low-confidence subtotal reading does not change CHK.INVOICE", () => {
      const base = [...usdLine(), R("invoice.total", "1000.00")];
      const without = f(build(base), "CHK.INVOICE");
      const sub = R("invoice.subtotal", "EUR 9.299,00", { status: "uncertain", confidence: "low", message: "The reader was not sure of this value." });
      const chk = f(build([...base, sub]), "CHK.INVOICE");
      expect(chk?.reason).toBe(NO_SUBTOTAL);
      expect(chk).toEqual(without);
    });

    it("Requirement 65.3 (Property 92): a low-confidence subtotal outside the transcript does not change CHK.INVOICE", () => {
      const base = [...usdLine(), R("invoice.total", "1000.00")];
      const without = f(build(base), "CHK.INVOICE");
      const sub = R("invoice.subtotal", "9.299,00", {
        status: "uncertain",
        confidence: "low",
        notInTranscript: true,
        box: null,
        itemIds: [],
        message: "Not in the transcript.",
      });
      const chk = f(build([...base, sub]), "CHK.INVOICE");
      expect(chk?.reason).toBe(NO_SUBTOTAL);
      expect(chk).toEqual(without);
    });

    it("Requirement 65.2: an accepted subtotal reading with an empty value gives the no-subtotal reason", () => {
      const sub = R("invoice.subtotal", "");
      const total = R("invoice.total", "1000.00");
      const chk = f(build([...usdLine(), sub, total]), "CHK.INVOICE");
      expect(chk?.reason).toBe(NO_SUBTOTAL);
      expect(chk?.sources).toEqual([src(sub), src(total)]);
    });
  });

  describe("Example 65.4: Only the first reason changes", () => {
    it("Requirement 65.3: with other reasons, only the first reason differs from the empty-subtotal draft", () => {
      const sub = R("invoice.subtotal", "EUR 9.299,00");
      const emptySub = { ...sub, value: "" } as VerifiedReading;
      const total = R("invoice.total", "1000.00");
      const base = usdLine();
      const d = build([...base, sub, total], [], 9);
      const before = build([...base, emptySub, total], [], 9);
      const chk = f(d, "CHK.INVOICE");
      const chkBefore = f(before, "CHK.INVOICE");

      const others = " The invoice shows 9 item lines, but the draft has readings for 1. The invoice shows 9 item lines; this draft reads only the first 8.";
      expect(chkBefore?.reason).toBe(NO_SUBTOTAL + others);
      expect(chk?.reason).toBe(commaReason("EUR 9.299,00") + others);
      expect(chk).toEqual({ ...chkBefore!, reason: commaReason("EUR 9.299,00") + others });
      expect(chk?.sources).toEqual([src(sub), src(total)]);
      expect(chk?.inputs).toEqual([]);
      expect(d.checks).toEqual(before.checks);
    });
  });

  describe("Example 65.5: The sample bundle", () => {
    for (const withDemo of [false, true]) {
      const name = withDemo ? "with the demo answers" : "without person values";
      it(`Requirement 65.3: the sample subtotal is added up, so no subtotal reason appears (${name})`, () => {
        const d = build(sample, withDemo ? demo : []);
        expect(d.checks.filter((c) => c.id === "P2.invoice.subtotal").length).toBe(1);
        const reason = f(d, "CHK.INVOICE")?.reason ?? "";
        expect(reason.includes("The invoice subtotal \"")).toBe(false);
        expect(reason.includes("No invoice subtotal was read")).toBe(false);
      });

      it(`Requirement 65.3: a sample subtotal P2 does not read changes only the first reason of CHK.INVOICE (${name})`, () => {
        const sub = sample.find((r) => r.field === "invoice.subtotal" && r.status === "accepted");
        expect(sub?.status).toBe("accepted");
        const withValue = (value: string) => sample.map((r) => (r === sub ? ({ ...r, value } as VerifiedReading) : r));
        const overrides = withDemo ? demo : [];
        const before = build(withValue(""), overrides);
        const chkBefore = f(before, "CHK.INVOICE");
        expect(chkBefore?.reason?.startsWith(NO_SUBTOTAL)).toBe(true);
        const rest = chkBefore!.reason!.slice(NO_SUBTOTAL.length);

        for (const [value, first] of [
          ["EUR  9.299,00", commaReason("EUR 9.299,00")],
          ["9.299,00 $", commaReason("9.299,00 $")],
          ["Subtotal 9299", notNumberReason("Subtotal 9299")],
        ] as const) {
          const d = build(withValue(value), overrides);
          expect(d.checks).toEqual(before.checks);
          expect(f(d, "CHK.INVOICE")).toEqual({ ...chkBefore!, reason: first + rest });
        }
      });
    }
  });

  describe("Requirement 65 sanity checks: P2 checks not changed", () => {
    it("Requirement 65.3: when the subtotal is not parseable, no P2 check runs", () => {
      const readings: VerifiedReading[] = [...usdLine(), R("invoice.subtotal", "9.299,00 EUR"), R("invoice.total", "1000.00")];
      const d = build(readings);
      expect(d.checks.filter((c) => c.rule === "P2")).toEqual([]);
    });

    it("Requirement 65.3: when the subtotal is parseable and matches the line amount, the P2 checks run and are ok", () => {
      const readings: VerifiedReading[] = [...usdLine(), R("invoice.subtotal", "1000.00"), R("invoice.total", "1000.00")];
      const d = build(readings);
      expect(d.checks.filter((c) => c.rule === "P2")).toEqual([
        { id: "P2.invoice.subtotal", rule: "P2", label: "Invoice subtotal", ok: true, detail: "sum of line amounts = subtotal" },
        { id: "P2.invoice.total", rule: "P2", label: "Invoice total", ok: true, detail: "subtotal = total" },
      ]);
      expect(f(d, "CHK.INVOICE")).toBeUndefined();
    });
  });

  describe("Requirement 65 sanity checks: CHK.INVOICE block and status", () => {
    it("Requirement 65.3: CHK.INVOICE keeps block P2, its label, needsReview and no value", () => {
      const readings: VerifiedReading[] = [...usdLine(), R("invoice.subtotal", "USD 1000.00 not parseable"), R("invoice.total", "1000.00")];
      const chk = f(build(readings), "CHK.INVOICE");
      expect(chk?.block).toBe("P2");
      expect(chk?.label).toBe("Invoice lines against the invoice");
      expect(chk?.status).toBe("needsReview");
      expect(chk?.value).toBeNull();
      expect(chk?.reason).toBe(notNumberReason("USD 1000.00 not parseable"));
    });
  });

  describe("Requirement 65 sanity checks: CSV contains CHK.INVOICE", () => {
    it("Requirement 65.1: the CSV row of CHK.INVOICE has the decimal comma reason", () => {
      const readings: VerifiedReading[] = [...usdLine(), R("invoice.subtotal", "9.299,00 EUR"), R("invoice.total", "1000.00")];
      const rows = parseCsv(draftToCsv(build(readings)));
      const chkRow = rows.find((r) => r[0] === "CHK.INVOICE");
      expect(chkRow?.[1]).toBe("P2");
      expect(chkRow?.[6]).toBe("needsReview");
      const reasonColumn = 9;
      expect(chkRow?.[reasonColumn]).toBe(commaReason("9.299,00 EUR"));
    });
  });
});
