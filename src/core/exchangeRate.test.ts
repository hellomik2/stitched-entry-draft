import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  invoiceForeignCurrency,
  exchangeRateProblem,
  exchangeRateSource,
  decimalCommaCents,
  exchangeMoneyCents,
  mixesNumberForms,
  exchangeLineMismatch,
  convertedEnteredValue,
  exchangeRateSourceText,
  exchangeRateNote,
  convertedNote,
  EXCHANGE_RATE_FIELD_ID,
  EXCHANGE_RATE_HELP,
} from "./exchangeRate";
import { parseMoneyToCents } from "./parse";
import type { VerifiedReading } from "./reading";

// Feature: document-intake, Requirement 63 (task 81.1): the helpers of a person's exchange rate.

const reading = (value: string | null, more: Record<string, unknown> = {}): VerifiedReading =>
  ({ field: "invoice.currency", value, quote: value ?? "", doc: "invoice", page: 1, status: "accepted", box: null, itemIds: [], ...more }) as VerifiedReading;

describe("Requirement 63.1: invoiceForeignCurrency and exchangeRateProblem", () => {
  it("gives the accepted currency in capitals when it is not USD", () => {
    expect(invoiceForeignCurrency([reading("EUR")])).toBe("EUR");
    expect(invoiceForeignCurrency([reading(" eur ")])).toBe("EUR");
    expect(invoiceForeignCurrency([reading("USD")])).toBeNull();
    expect(invoiceForeignCurrency([reading("usd")])).toBeNull();
    expect(invoiceForeignCurrency([reading("")])).toBeNull();
    expect(invoiceForeignCurrency([])).toBeNull();
  });

  it("does not count a currency that is not sure or rejected, and counts the image readings the draft counts", () => {
    expect(invoiceForeignCurrency([reading("EUR", { status: "uncertain", message: "m", confidence: "low" })])).toBeNull();
    expect(invoiceForeignCurrency([reading("EUR", { status: "rejected", reason: "quote_not_found", message: "m" })])).toBeNull();
    expect(invoiceForeignCurrency([reading("EUR", { status: "uncertain", message: "m", notInTranscript: true, origin: "imageTranscript" })])).toBe("EUR");
    expect(invoiceForeignCurrency([reading("EUR", { status: "uncertain", message: "m", lineWithoutBox: true, origin: "imageTranscript" })])).toBe("EUR");
    expect(invoiceForeignCurrency([reading("EUR", { status: "uncertain", message: "m", lineWithoutBox: true, confidence: "low" })])).toBeNull();
  });

  it("accepts a rate of the form, a real date and a source of 1 to 200 characters", () => {
    const ok = { rate: "1.0835", date: "2026-11-09", source: "Demo rate for this video, not a certified rate" };
    expect(exchangeRateProblem(ok)).toBeNull();
    expect(exchangeRateProblem({ ...ok, rate: " 1.0835 ", date: " 2026-11-09 ", source: "  a  b  " })).toBeNull();
    expect(exchangeRateProblem({ ...ok, rate: "1" })).toBeNull();
    expect(exchangeRateProblem({ ...ok, rate: "999999.99999999" })).toBeNull();
    expect(exchangeRateProblem({ ...ok, rate: "0.00000001" })).toBeNull();
    expect(exchangeRateProblem({ ...ok, date: "2028-02-29" })).toBeNull();
    expect(exchangeRateProblem({ ...ok, source: "x".repeat(200) })).toBeNull();
  });

  it("refuses every other rate, date and source with a reason", () => {
    const ok = { rate: "1.0835", date: "2026-11-09", source: "s" };
    for (const rate of ["", "0", "0.0", "0.00000000", "-1", "+1", "1,0835", "1.", ".5", "1e3", "1234567", "1.123456789", "1 .5", "NaN", "Infinity"]) {
      expect(exchangeRateProblem({ ...ok, rate }), rate).toMatch(/^The rate must be/);
    }
    for (const date of ["", "2026-11-31", "2026-02-29", "2026-13-01", "2026-00-10", "09.11.2026", "11/09/2026", "2026-11-9", "20261109"]) {
      expect(exchangeRateProblem({ ...ok, date }), date).toMatch(/^The rate date must be/);
    }
    for (const source of ["", "   ", "x".repeat(201)]) {
      expect(exchangeRateProblem({ ...ok, source }), JSON.stringify(source)).toMatch(/^Say where the rate came from/);
    }
  });

  it("keeps the rate and the date trimmed and the source with its spaces normalized", () => {
    expect(exchangeRateSource("EUR", { rate: " 1.0835 ", date: " 2026-11-09 ", source: "  Demo   rate \n x " })).toEqual({
      kind: "exchangeRate",
      currency: "EUR",
      rate: "1.0835",
      date: "2026-11-09",
      source: "Demo rate x",
    });
  });
});

describe("Requirement 63.4: decimalCommaCents, exchangeMoneyCents and mixesNumberForms", () => {
  it("reads the two decimal comma forms and nothing else (63.8)", () => {
    expect(decimalCommaCents("2.160,00")).toBe(216000);
    expect(decimalCommaCents("1.550,00")).toBe(155000);
    expect(decimalCommaCents("765,00")).toBe(76500);
    expect(decimalCommaCents("18,00")).toBe(1800);
    expect(decimalCommaCents("0,62")).toBe(62);
    expect(decimalCommaCents("1.234.567,89")).toBe(123456789);
    expect(decimalCommaCents(" 9.299,00 ")).toBe(929900);
    for (const t of ["1.800", "1,800", "1.80", "2.160,0", "2,160.00", "EUR 2.160,00", "2.160,00 EUR", "€2.160,00", "-765,00", "765,000", "7,5", "21.60,00", "2160.00", "2160", "1.2345,00", "", "abc"]) {
      expect(decimalCommaCents(t), t).toBeNull();
    }
  });

  it("Property 89: a text today's reading takes gives null; cents only for the two forms, from their digits", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("0", "1", "2", "5", "9", ",", ".", " ", "-", "E"), maxLength: 14 }), (t) => {
        const today = parseMoneyToCents(t.replace(/\s+/g, " ").trim());
        const got = decimalCommaCents(t);
        if (today.ok) expect(got).toBeNull();
        if (got !== null) {
          const n = t.replace(/\s+/g, " ").trim();
          expect(/^\d{1,3}(\.\d{3})+,\d{2}$/.test(n) || /^\d+,\d{2}$/.test(n)).toBe(true);
          expect(got).toBe(Number(n.replace(/[.,]/g, "")));
          expect(exchangeMoneyCents(t)).toBe(got);
        }
        if (today.ok) expect(exchangeMoneyCents(t)).toBe(today.value);
      }),
      { numRuns: 3000 },
    );
  });

  it("Property 89: a number written in both forms gives the same cents in each", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_999_999 }), (cents) => {
        const whole = Math.floor(cents / 100);
        const dec = String(cents % 100).padStart(2, "0");
        const us = `${whole.toLocaleString("en-US")}.${dec}`;
        const de = `${whole.toLocaleString("en-US").replace(/,/g, ".")},${dec}`;
        expect(exchangeMoneyCents(us)).toBe(cents);
        expect(decimalCommaCents(de)).toBe(cents);
        expect(decimalCommaCents(us)).toBeNull();
      }),
    );
  });

  it("finds mixed number forms only when a decimal comma form meets another form with a comma or a period", () => {
    expect(mixesNumberForms(["2.160,00", "18,00", "765,00", "EUR 9.299,00"])).toBe(false);
    expect(mixesNumberForms(["2.160,00", "765.00"])).toBe(true);
    expect(mixesNumberForms(["2.160,00", "1,800"])).toBe(true);
    expect(mixesNumberForms(["2.160,00", "765"])).toBe(false);
    expect(mixesNumberForms(["2,160.00", "765.00", "USD 9,299.00"])).toBe(false);
    expect(mixesNumberForms(["9.299,00 EUR", "€ 18,00", "$1.20"])).toBe(true);
    expect(mixesNumberForms([])).toBe(false);
  });
});

describe("Requirement 63.3: exchangeLineMismatch and convertedEnteredValue", () => {
  it("gives the P1 detail only when quantity, unit price and amount are read and differ by more than 1 cent", () => {
    expect(exchangeLineMismatch(120, "18,00", "2.160,00")).toBeNull();
    expect(exchangeLineMismatch(150, "3,20", "468,00")).toBe("quantity × unitPrice = 480.00, amount = 468.00, diff = 12.00");
    expect(exchangeLineMismatch(150, "3.20", "468.00")).toBe("quantity × unitPrice = 480.00, amount = 468.00, diff = 12.00");
    expect(exchangeLineMismatch(null, "1,20", "2.160,00")).toBeNull();
    expect(exchangeLineMismatch(1800, null, "2.160,00")).toBeNull();
    expect(exchangeLineMismatch(1800, "1,20", "2.160,0")).toBeNull();
  });

  it("converts exactly and rounds once by P4 (63.8)", () => {
    expect(convertedEnteredValue(216000, "1.0835")).toEqual({ ok: true, exactUsd: "2340.36", dollars: 2340 });
    expect(convertedEnteredValue(155000, "1.0835")).toEqual({ ok: true, exactUsd: "1679.425", dollars: 1679 });
    expect(convertedEnteredValue(76500, "1.0835")).toEqual({ ok: true, exactUsd: "828.8775", dollars: 829 });
    expect(convertedEnteredValue(216000, "1")).toEqual({ ok: true, exactUsd: "2160.00", dollars: 2160 });
    expect(convertedEnteredValue(46850, "1")).toEqual({ ok: true, exactUsd: "468.50", dollars: 469 });
    expect(convertedEnteredValue(100, "0.495")).toEqual({ ok: true, exactUsd: "0.495", dollars: 0 });
    expect(convertedEnteredValue(100, "0.5")).toEqual({ ok: true, exactUsd: "0.50", dollars: 1 });
    expect(convertedEnteredValue(1, "0.00000001")).toEqual({ ok: true, exactUsd: "0.0000000001", dollars: 0 });
    expect(convertedEnteredValue(-1, "1").ok).toBe(false);
    expect(convertedEnteredValue(100, "1,5").ok).toBe(false);
    expect(convertedEnteredValue(Number.MAX_SAFE_INTEGER, "999999").ok).toBe(false);
  });

  it("Property 86: P4 of the exact product computed apart as a fraction; the text is the exact product; never goes down with the rate", () => {
    const rateArb = fc
      .tuple(fc.integer({ min: 0, max: 999_999 }), fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 99_999_999 }))
      .map(([w, k, f]) => (k === 0 ? String(w) : `${w}.${String(f % 10 ** k).padStart(k, "0")}`))
      .filter((r) => /[1-9]/.test(r));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_00 }), rateArb, rateArb, (cents, ra, rb) => {
        for (const rate of [ra, rb]) {
          const got = convertedEnteredValue(cents, rate);
          expect(got.ok).toBe(true);
          if (!got.ok) return;
          const [w, f = ""] = rate.split(".");
          const num = BigInt(cents) * BigInt(w + f); // exact USD = num / 10^(2 + f.length)
          const den = 10n ** BigInt(2 + f.length);
          const want = (2n * num + den) / (2n * den); // half up: floor(x + 1/2)
          expect(BigInt(got.dollars)).toBe(want);
          const [gi, gf] = got.exactUsd.split(".");
          expect(gf.length).toBeGreaterThanOrEqual(2);
          expect(BigInt(gi + gf) * den).toBe(num * 10n ** BigInt(gf.length));
        }
        const [lo, hi] = Number(ra) <= Number(rb) ? [ra, rb] : [rb, ra];
        const a = convertedEnteredValue(cents, lo);
        const b = convertedEnteredValue(cents, hi);
        if (a.ok && b.ok && Number(lo) < Number(hi)) expect(a.dollars).toBeLessThanOrEqual(b.dollars);
      }),
      { numRuns: 500 },
    );
  });
});

describe("Requirements 63.2, 63.3, 63.5, 63.6: the texts", () => {
  const s = exchangeRateSource("EUR", { rate: "1.0835", date: "2026-11-09", source: "Demo rate for this video, not a certified rate" });

  it("the source, the FX.RATE note and the 36A note", () => {
    expect(EXCHANGE_RATE_FIELD_ID).toBe("FX.RATE");
    expect(exchangeRateSourceText(s)).toBe(
      'Exchange rate entered by a person: 1 EUR = 1.0835 USD, rate date 2026-11-09, source "Demo rate for this video, not a certified rate"',
    );
    expect(exchangeRateNote(s)).toBe(
      'Entered by a person: 1 EUR = 1.0835 USD, rate date 2026-11-09, source "Demo rate for this video, not a certified rate". The app does not choose, suggest or look up a rate.',
    );
    expect(convertedNote([216000], "EUR", "1.0835", "2340.36", [{ line: 1, printed: "2.160,00", cents: 216000 }])).toBe(
      '2160.00 EUR × 1.0835 = 2340.36 USD, rounded to whole dollars (P4). Invoice line 1 amount printed "2.160,00", read as 2160.00 (decimal comma). Nothing was deducted. A person confirms the entered value.',
    );
    expect(convertedNote([54000, 43200], "EUR", "1", "972.00", [])).toBe(
      "(540.00 + 432.00) EUR × 1 = 972.00 USD, rounded to whole dollars (P4). Nothing was deducted. A person confirms the entered value.",
    );
  });

  it("the help text cites only the sections that were read and names no rate", () => {
    expect(EXCHANGE_RATE_HELP).toBe(
      "Customs converts foreign currency only at a proclaimed or certified rate (19 CFR 159.31), for the date of exportation: the day the goods finally left the country of exportation for the United States (159.32, 152.1(c)). 159.34 and 159.35 say when the quarterly or the daily certified rate applies. Enter the rate, its date and where it came from. The app does not choose, suggest or look up a rate.",
    );
    expect(EXCHANGE_RATE_HELP).not.toMatch(/\d\.\d{3,}/);
  });
});
