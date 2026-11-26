import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { verifyReadings, type VerifiedReading } from "./reading";
import { buildDraft, allFields, IMAGE_COMPUTED_REVIEW_REASON, type Draft, type DraftField, type Override } from "./draft";
import { draftToCsv, parseCsv } from "./csv";
import { parseMoneyToCents } from "./parse";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Feature: document-intake, Requirement 63 (task 81.1): a person's exchange rate converts the amounts of an invoice that is
// not in USD. The invoice below has the printed values of the recorded read of bundle B (2026-11-26); the rate, its date and
// its source are a person's test values, not values of the app.

type Rate = { rate: string; date: string; source: string } | null;
const RATE: Rate = { rate: "1.0835", date: "2026-11-09", source: "Demo rate for this video, not a certified rate" };
const MIXED = "The invoice prints its amounts both with a decimal comma and in another form, so the draft does not convert them. A person enters the entered value.";

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

// the six lines of the invoice of bundle B: item, HTS, origin, quantity, unit, unit price, amount
const LINES_B: [string, string, string, string, string, string, string][] = [
  ["DG-01", "9505.90.6000", "DE", "120", "DZ", "18,00", "2.160,00"],
  ["DG-02", "7013.99.3500", "DE", "1.800", "PCS", "1,20", "2.160,00"],
  ["DG-03", "9505.90.4000", "CZ", "2.500", "PCS", "0,62", "1.550,00"],
  ["DG-04", "3926.40.0090", "CN", "900", "PCS", "0,85", "765,00"],
  ["DG-05", "9405.50.4000", "DE", "240", "PCS", "7,50", "1.800,00"],
  ["DG-06", "6913.90.5500", "DE", "360", "PCS", "2,40", "864,00"],
];

function invoiceB(change: { currency?: string; amount4?: string; currencyMore?: Record<string, unknown>; amount1More?: Record<string, unknown> } = {}): VerifiedReading[] {
  const out: VerifiedReading[] = [R("invoice.currency", change.currency ?? "EUR", change.currencyMore ?? {})];
  LINES_B.forEach(([itemNo, h, origin, qty, unit, price, amount], i) => {
    const n = i + 1;
    out.push(
      R(`invoice.lines.${n}.itemNo`, itemNo),
      R(`invoice.lines.${n}.description`, `Item ${n}`),
      R(`invoice.lines.${n}.hts`, h),
      R(`invoice.lines.${n}.origin`, origin),
      R(`invoice.lines.${n}.quantity`, qty),
      R(`invoice.lines.${n}.unit`, unit),
      R(`invoice.lines.${n}.unitPrice`, price),
      R(`invoice.lines.${n}.amount`, n === 4 && change.amount4 ? change.amount4 : amount, n === 1 ? change.amount1More ?? {} : {}),
    );
  });
  out.push(R("invoice.subtotal", "EUR 9.299,00"), R("invoice.total", "EUR 9.299,00"));
  return out;
}

const build = (readings: VerifiedReading[], exchangeRate?: Rate, overrides: Override[] = []): Draft =>
  buildDraft({ bundle: "upload", reader: "test", readings, hts, overrides, invoiceLineCount: null, packingListLineCount: null, ...(exchangeRate === undefined ? {} : { exchangeRate }) } as Parameters<typeof buildDraft>[0]);
const f = (d: Draft, id: string): DraftField | undefined => allFields(d).find((x) => x.id === id);
const enteredIds = (d: Draft) => allFields(d).filter((x) => x.block === "36A").map((x) => x.id);
const MONEY_IDS = (d: Draft) => allFields(d).filter((x) => ["36A", "38"].includes(x.block) || ["B39", "FEE.MPF", "FEE.HMF", "B41", "B42", "B43", "B44"].includes(x.id)).map((x) => x.id);
const kinds = (x: DraftField | undefined) => (x?.sources ?? []).map((s) => (s.kind === "document" ? s.readingField : s.kind));

/** The same readings with the invoice money values printed with a decimal comma and periods between thousands. */
function decimalComma(readings: VerifiedReading[]): VerifiedReading[] {
  return readings.map((r) => {
    if (!/^invoice\.(lines\.\d+\.(amount|unitPrice)|subtotal|total)$/.test(r.field) || !r.value) return r;
    const m = parseMoneyToCents(r.value.replace(/\s+/g, " ").trim());
    if (!m.ok) return r;
    const whole = Math.floor(m.value / 100).toLocaleString("en-US").replace(/,/g, ".");
    return { ...r, value: `${whole},${String(m.value % 100).padStart(2, "0")}` } as VerifiedReading;
  });
}
const withCurrency = (readings: VerifiedReading[], value: string, more: Record<string, unknown> = {}) =>
  readings.map((r) => (r.field === "invoice.currency" ? ({ ...r, value, ...more } as VerifiedReading) : r));

describe("Requirement 63.8: the invoice of bundle B with a person's rate", () => {
  it("without a rate every 36A waits with \"Currency is not USD.\"", () => {
    const d = build(invoiceB());
    expect(enteredIds(d)).toHaveLength(6);
    for (const id of enteredIds(d)) expect([f(d, id)?.status, f(d, id)?.value, f(d, id)?.reason]).toEqual(["needsReview", null, "Currency is not USD."]);
    expect(f(d, "FX.RATE")).toBeUndefined();
  });

  it("with the rate the entered values are computed from the decimal comma amounts, exactly, then P4", () => {
    const d = build(invoiceB(), RATE);
    const values = ["L001.36A", "L002.36A", "L003.36A", "L004.36A", "L005.36A", "L006.36A"].map((id) => [f(d, id)?.status, f(d, id)?.value]);
    expect(values).toEqual([
      ["computed", "2340"],
      ["computed", "2340"],
      ["computed", "1679"],
      ["computed", "829"],
      ["computed", "1950"],
      ["computed", "936"],
    ]);
    expect([f(d, "B39")?.status, f(d, "B39")?.value]).toEqual(["computed", "10074"]);
  });

  it("the 36A of line 001 has its rule, its note, its threads to the amount, the currency and the rate, and FX.RATE as its input", () => {
    const d = build(invoiceB(), RATE);
    const x = f(d, "L001.36A")!;
    expect(x.rule).toBe("P4");
    expect(x.note).toBe(
      '2160.00 EUR × 1.0835 = 2340.36 USD, rounded to whole dollars (P4). Invoice line 1 amount printed "2.160,00", read as 2160.00 (decimal comma). Nothing was deducted. A person confirms the entered value.',
    );
    expect(kinds(x)).toEqual(["invoice.lines.1.amount", "invoice.currency", "exchangeRate"]);
    expect(x.sources[2]).toEqual({ kind: "exchangeRate", currency: "EUR", rate: "1.0835", date: "2026-11-09", source: "Demo rate for this video, not a certified rate" });
    expect(x.inputs).toEqual(["FX.RATE"]);
    expect(f(d, "L003.36A")?.note).toBe(
      '1550.00 EUR × 1.0835 = 1679.425 USD, rounded to whole dollars (P4). Invoice line 3 amount printed "1.550,00", read as 1550.00 (decimal comma). Nothing was deducted. A person confirms the entered value.',
    );
  });

  it("FX.RATE is the last header field, entered by a person, with its note and source", () => {
    const d = build(invoiceB(), { rate: " 1.0835 ", date: " 2026-11-09 ", source: "  Demo rate for this video,   not a certified rate " });
    const last = d.header[d.header.length - 1];
    expect(last).toEqual({
      id: "FX.RATE",
      block: "FX",
      line: null,
      label: "Exchange rate (USD per 1 EUR)",
      value: "1.0835",
      unit: null,
      status: "personEdited",
      rule: null,
      note: 'Entered by a person: 1 EUR = 1.0835 USD, rate date 2026-11-09, source "Demo rate for this video, not a certified rate". The app does not choose, suggest or look up a rate.',
      reason: null,
      sources: [{ kind: "exchangeRate", currency: "EUR", rate: "1.0835", date: "2026-11-09", source: "Demo rate for this video, not a certified rate" }],
      inputs: [],
    });
    expect(d.needsReview.some((r) => r.fieldId === "FX.RATE")).toBe(false);
    expect(d.personInput.some((r) => r.fieldId === "FX.RATE")).toBe(false);
  });

  it("a person value for FX.RATE is ignored", () => {
    const d = build(invoiceB(), RATE, [{ fieldId: "FX.RATE", value: "2" }]);
    expect(f(d, "FX.RATE")?.value).toBe("1.0835");
    expect(f(d, "L001.36A")?.value).toBe("2340");
  });

  it("the CSV gives the rate source on the FX.RATE row and on each converted 36A row (63.6), with a quote doubled", () => {
    const rows = parseCsv(draftToCsv(build(invoiceB(), { ...RATE!, source: 'Desk "A" sheet' })));
    const text = 'Exchange rate entered by a person: 1 EUR = 1.0835 USD, rate date 2026-11-09, source "Desk ""A"" sheet"';
    const fx = rows.find((r) => r[0] === "FX.RATE")!;
    expect(fx.slice(0, 7)).toEqual(["FX.RATE", "FX", "", "Exchange rate (USD per 1 EUR)", "1.0835", "", "personEdited"]);
    expect(fx[10]).toBe(text);
    const l1 = rows.find((r) => r[0] === "L001.36A")!;
    expect(l1[10].split(" | ")[2]).toBe(text);
    expect(l1[11]).toBe("FX.RATE");
  });

  it("an invoice that mixes number forms converts nothing (63.4)", () => {
    const d = build(invoiceB({ amount4: "765.00" }), RATE);
    for (const id of enteredIds(d)) expect([f(d, id)?.status, f(d, id)?.value, f(d, id)?.reason]).toEqual(["needsReview", null, MIXED]);
    expect(kinds(f(d, "L004.36A"))).toEqual(["invoice.lines.4.amount"]);
  });

  it("a line printed with a decimal comma whose quantity times unit price is not its amount waits with the P1 reason (63.3)", () => {
    const readings = invoiceB().map((r) => (r.field === "invoice.lines.5.amount" ? ({ ...r, value: "1.788,00" } as VerifiedReading) : r));
    const d = build(readings, RATE);
    expect([f(d, "L005.36A")?.status, f(d, "L005.36A")?.value, f(d, "L005.36A")?.reason]).toEqual([
      "needsReview",
      null,
      "P1 mismatch: quantity × unitPrice = 1800.00, amount = 1788.00, diff = 12.00. A person decides.",
    ]);
    expect(f(d, "L001.36A")?.value).toBe("2340");
    expect(d.checks.some((c) => c.id === "P1.invoice.line.5")).toBe(false);
  });

  it("with the currency USD the same rate changes nothing and a decimal comma amount is not read", () => {
    const usd = invoiceB({ currency: "USD" });
    const d = build(usd, RATE);
    expect(d).toEqual(build(usd));
    expect(f(d, "L001.36A")?.reason).toBe("No accepted amount for invoice line 1. A person enters the entered value.");
  });
});

describe("Property 84: Without a Usable Rate the Draft Is As Before (Validates: Requirements 63.1, 63.4)", () => {
  const badRate = fc.oneof(
    fc.constantFrom("", "0", "0.000", "-1", "1,0835", "1.", ".5", "1e2", "1234567", "1.123456789", "abc"),
    fc.constant(null),
  );
  const badDate = fc.constantFrom("", "2026-11-31", "2026-02-29", "09.11.2026", "2026-1-9");
  const goodRate = fc.tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 1, max: 9999 })).map(([w, f]) => `${w}.${f}`);

  it("a rate, a date or a source that does not pass leaves the draft and the CSV as they are", () => {
    const eur = invoiceB();
    const base = build(eur);
    const csv = draftToCsv(base);
    fc.assert(
      fc.property(badRate, badDate, fc.constantFrom("", "   ", "x".repeat(201)), fc.integer({ min: 0, max: 2 }), goodRate, (rate, date, source, which, good) => {
        const input: Rate =
          rate === null
            ? null
            : which === 0
              ? { rate, date: "2026-11-09", source: "s" }
              : which === 1
                ? { rate: good, date, source: "s" }
                : { rate: good, date: "2026-11-09", source };
        const d = build(eur, input);
        expect(d).toEqual(base);
        expect(draftToCsv(d)).toBe(csv);
      }),
      { numRuns: 60 },
    );
  });

  it("a USD invoice, an unread currency and a currency the reader was not sure of are as before with any rate", () => {
    const cases = [
      sample,
      sample.filter((r) => r.field !== "invoice.currency"),
      withCurrency(sample, "EUR", { status: "uncertain", confidence: "low", message: "not sure" }),
      withCurrency(sample, "EUR", { status: "rejected", reason: "quote_not_found", message: "no" }),
    ];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), goodRate, fc.boolean(), (k, rate, withDemo) => {
        const ov = withDemo ? demo : [];
        const d = build(cases[k], { rate, date: "2026-11-09", source: "s" }, ov);
        expect(d).toEqual(build(cases[k], undefined, ov));
        expect(draftToCsv(d)).toBe(draftToCsv(build(cases[k], null, ov)));
      }),
      { numRuns: 40 },
    );
  });

  it("putting a rate in and taking it out gives the first draft back", () => {
    const eur = withCurrency(sample, "EUR");
    expect(build(eur, null)).toEqual(build(eur));
    expect(build(eur, RATE)).not.toEqual(build(eur));
  });
});

describe("Property 85: A Rate of 1 Gives the Values of the Same Invoice in USD (Validates: Requirements 63.3, 63.4)", () => {
  it("the sample in EUR at rate 1, and with its amounts printed with a decimal comma, has the money values and statuses of the sample in USD", () => {
    for (const ov of [[], demo]) {
      const usd = build(sample, undefined, ov);
      const one = { rate: "1", date: "2026-11-09", source: "test" };
      for (const other of [build(withCurrency(sample, "EUR"), one, ov), build(decimalComma(withCurrency(sample, "EUR")), one, ov)]) {
        for (const id of MONEY_IDS(usd)) {
          expect([id, f(other, id)?.status, f(other, id)?.value]).toEqual([id, f(usd, id)?.status, f(usd, id)?.value]);
        }
      }
    }
  });
});

describe("Property 86 and Property 87: values grow with the rate; the totals add up (Validates: Requirement 63.3)", () => {
  const rateArb = fc.tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 9999 })).map(([w, x]) => `${w}.${String(x).padStart(4, "0")}`).filter((r) => /[1-9]/.test(r));

  it("for rates r1 <= r2 every 36A and B39 for r1 are at most those for r2, and B39 is the sum of the 36A values", () => {
    const eur = invoiceB();
    fc.assert(
      fc.property(rateArb, rateArb, (a, b) => {
        const [lo, hi] = Number(a) <= Number(b) ? [a, b] : [b, a];
        const dl = build(eur, { rate: lo, date: "2026-11-09", source: "s" });
        const dh = build(eur, { rate: hi, date: "2026-11-09", source: "s" });
        for (const d of [dl, dh]) {
          const sum = enteredIds(d).reduce((s, id) => s + Number(f(d, id)!.value), 0);
          expect(f(d, "B39")?.value).toBe(String(sum));
        }
        for (const id of [...enteredIds(dl), "B39"]) expect(Number(f(dl, id)!.value)).toBeLessThanOrEqual(Number(f(dh, id)!.value));
      }),
      { numRuns: 60 },
    );
  });

  it("with the demo answers the sample in EUR at any rate keeps B44 = B41 + B42 + B43", () => {
    const eur = withCurrency(sample, "EUR");
    fc.assert(
      fc.property(rateArb, (rate) => {
        const d = build(eur, { rate, date: "2026-11-09", source: "s" }, demo);
        const v = (id: string) => f(d, id)?.value;
        if (v("B41") && v("B42") && v("B43") && v("B44")) {
          const cents = (s: string) => Math.round(Number(s) * 100);
          expect(cents(v("B44")!)).toBe(cents(v("B41")!) + cents(v("B42")!) + cents(v("B43")!));
        }
        expect(f(d, "B39")?.status).toBe("computed");
      }),
      { numRuns: 30 },
    );
  });
});

describe("Property 88: A Converted Value From an Image Reading Waits for a Person (Validates: Requirements 63.3, 26.1)", () => {
  it("a currency or an amount read from an image keeps every converted 36A waiting with its value until a person confirms it", () => {
    const image = { origin: "imageTranscript" };
    for (const readings of [invoiceB({ currencyMore: image }), invoiceB({ amount1More: image })]) {
      const d = build(readings, RATE);
      const ids = readings.some((r) => r.field === "invoice.currency" && (r as { origin?: string }).origin) ? enteredIds(d) : ["L001.36A"];
      for (const id of ids) {
        const x = f(d, id)!;
        expect([id, x.status, x.reason]).toEqual([id, "needsReview", IMAGE_COMPUTED_REVIEW_REASON]);
        expect(x.value).not.toBeNull();
        expect(kinds(x)).toContain("exchangeRate");
        const c = f(build(readings, RATE, [{ fieldId: id, value: x.value! }]), id)!;
        expect([c.status, c.value]).toEqual(["computed", x.value]);
      }
    }
  });
});

describe("Property 90: A Person's 36A Comes Before the Rate (Validates: Requirement 63.3)", () => {
  it("a person's whole-dollar 36A is the line's 36A whatever the rate, and B39 adds it", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 1_000_000 }), fc.constantFrom("1", "1.0835", "0.5", "150.25"), (n, value, rate) => {
        const id = `L00${n}.36A`;
        const d = build(invoiceB(), { rate, date: "2026-11-09", source: "s" }, [{ fieldId: id, value: String(value) }]);
        expect([f(d, id)?.status, f(d, id)?.value]).toEqual(["personEdited", String(value)]);
        const sum = enteredIds(d).reduce((s, x) => s + Number(f(d, x)!.value), 0);
        expect(f(d, "B39")?.value).toBe(String(sum));
      }),
      { numRuns: 40 },
    );
  });
});
