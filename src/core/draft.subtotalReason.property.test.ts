import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { type VerifiedReading } from "./reading";
import { buildDraft, allFields, type Draft, type DraftField, type Override } from "./draft";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

// Feature: document-intake, Requirement 65 (task 84.1): a subtotal that was read but not added up
// says so. Property 92 validates that only the first reason of CHK.INVOICE changes, and how.

let hts: HtsTable;

beforeAll(async () => {
  const b = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
  hts = b.hts;
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

const build = (readings: VerifiedReading[], invoiceLineCount: number | null = null, overrides: Override[] = []): Draft =>
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

// The other reasons of CHK.INVOICE (Requirement 19) for an invoice with readings for one line.
const otherReasons = (count: number | null): string => {
  if (count === null) return "";
  let s = "";
  if (count !== 1) s += ` The invoice shows ${count} item lines, but the draft has readings for 1.`;
  if (count > 8) s += ` The invoice shows ${count} item lines; this draft reads only the first 8.`;
  return s;
};

// A minimal USD invoice with one line of 1000.00, and optionally an invoice total of 1000.00.
function minimalInvoice(withTotal: boolean): { readings: VerifiedReading[]; total: VerifiedReading | null } {
  item = 0;
  const readings = [
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
  const total = withTotal ? R("invoice.total", "1000.00") : null;
  if (total) readings.push(total);
  return { readings, total };
}

// A generated subtotal text, the same text with spaces normalized, and what it contains.
type Sub = { text: string; normalized: string; affixes: string[]; spaced: boolean };

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");

// Whitespace that normalizes to one space, and whitespace around the whole text that normalizes to nothing.
const innerSpace = fc.constantFrom(" ", "  ", "\t", " \n ", "   ");
const outerSpace = fc.constantFrom("", "", " ", "  ", "\t", "\n");

/** Joins tokens with generated whitespace; `normalized` is the tokens joined with one space. */
const spaced = (tokens: string[], affixes: string[]): fc.Arbitrary<Sub> =>
  fc
    .tuple(outerSpace, fc.array(innerSpace, { minLength: tokens.length - 1, maxLength: tokens.length - 1 }), outerSpace)
    .map(([before, seps, after]) => {
      const text = before + tokens.map((t, i) => (i === 0 ? t : seps[i - 1] + t)).join("") + after;
      const normalized = tokens.join(" ");
      return { text, normalized, affixes, spaced: text !== normalized };
    });

// The two decimal comma forms of Requirement 63.4 (at most 14 digits).
const groupedForm = fc
  .tuple(fc.integer({ min: 1, max: 999 }), fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 3 }), fc.integer({ min: 0, max: 99 }))
  .map(([head, groups, c]) => `${head}${groups.map((g) => `.${pad3(g)}`).join("")},${pad2(c)}`);
const plainForm = fc.tuple(fc.integer({ min: 0, max: 9999999 }), fc.integer({ min: 0, max: 99 })).map(([w, c]) => `${w},${pad2(c)}`);
const decimalCommaNumber = fc.oneof(groupedForm, plainForm);

const codes = ["EUR", "GBP", "CHF", "SEK", "USD"];
const affix = fc.constantFrom("", "", ...codes, "€", "$");

// Requirement 65.1, first case: a decimal comma form with at most one leading and one trailing code, "€" or "$",
// each attached or separated by any whitespace.
const decimalCommaSubtotal: fc.Arbitrary<Sub> = fc
  .tuple(affix, fc.boolean(), decimalCommaNumber, affix, fc.boolean())
  .chain(([pre, attachPre, num, suf, attachSuf]) => {
    const tokens: string[] = [];
    let middle = num;
    if (pre && attachPre) middle = pre + middle;
    else if (pre) tokens.push(pre);
    if (suf && attachSuf) middle = middle + suf;
    tokens.push(middle);
    if (suf && !attachSuf) tokens.push(suf);
    return spaced(tokens, [pre ? `lead:${pre}` : "", suf ? `trail:${suf}` : ""].filter((a) => a !== ""));
  });

// Requirement 65.1, second case: texts that P2 does not read and that are not a decimal comma form once one
// leading and one trailing code, "€" or "$" are removed. None of them is taken by today's money reading.
const code = fc.constantFrom(...codes);
const symbolOrCode = fc.constantFrom(...codes, "€", "$");
const usForm = fc
  .tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 99 }))
  .map(([a, b, c]) => `${a},${pad3(b)}.${pad2(c)}`);
const notANumberSubtotal: fc.Arbitrary<Sub> = fc.oneof(
  // two leading codes or symbols: only one is removed
  fc.tuple(symbolOrCode, code, decimalCommaNumber).chain(([a, b, n]) => spaced([a, b, n], [`lead:${a}`])),
  // two trailing codes or symbols: only one is removed
  fc.tuple(decimalCommaNumber, code, symbolOrCode).chain(([n, a, b]) => spaced([n, a, b], [`trail:${b}`])),
  // a code in lower case is not a three-capital-letter code
  fc.tuple(fc.constantFrom("eur", "gbp", "Eur", "usd"), decimalCommaNumber).chain(([c, n]) => spaced([c, n], [])),
  // one or three digits after the comma
  fc
    .tuple(code, fc.integer({ min: 1, max: 99999 }), fc.constantFrom(1, 3), fc.integer({ min: 0, max: 999 }))
    .chain(([c, w, len, d]) => spaced([c, `${w},${String(d).padStart(3, "0").slice(0, len)}`], [`lead:${c}`])),
  // a period that is not between groups of three digits
  fc.tuple(code, fc.integer({ min: 1, max: 99 }), fc.integer({ min: 10, max: 99 }), fc.integer({ min: 0, max: 99 }))
    .chain(([c, a, b, d]) => spaced([c, `${a}.${b},${pad2(d)}`], [`lead:${c}`])),
  // a US-style amount with a code or a symbol before (separated) or after it
  fc.tuple(symbolOrCode, usForm).chain(([c, n]) => spaced([c, n], [`lead:${c}`])),
  fc.tuple(usForm, symbolOrCode).chain(([n, c]) => spaced([n, c], [`trail:${c}`])),
  // a label in front of the number
  fc.tuple(fc.constantFrom("Subtotal:", "Sub-total", "Total"), decimalCommaNumber, fc.constantFrom("", "EUR", "€"))
    .chain(([label, n, c]) => spaced(c ? [label, n, c] : [label, n], c ? [`trail:${c}`] : [])),
);

const lineCount = fc.constantFrom<number | null>(null, null, 1, 2, 5, 9, 12);

/** Requirements 65.1 and 65.3: the whole CHK.INVOICE of an accepted subtotal that P2 did not add up. */
function checkNotAddedUp(sub: Sub, withTotal: boolean, count: number | null, firstReason: (v: string) => string) {
  const { readings, total } = minimalInvoice(withTotal);
  const without = build(readings, count);
  const reading = R("invoice.subtotal", sub.text);
  const d = build([...readings, reading], count);
  const chk = f(d, "CHK.INVOICE");

  // P2 did not read the subtotal, and the P2 checks are the same as without a subtotal reading (65.3)
  expect(d.checks.filter((c) => c.rule === "P2")).toEqual([]);
  expect(d.checks).toEqual(without.checks);
  // 65.1: the first reason names the value with spaces normalized; 65.3: the other reasons follow unchanged
  expect(chk?.reason).toBe(firstReason(sub.normalized) + otherReasons(count));
  expect(f(without, "CHK.INVOICE")?.reason).toBe(NO_SUBTOTAL + otherReasons(count));
  // 65.3: status, value, sources and inputs stay
  expect(chk?.status).toBe("needsReview");
  expect(chk?.value).toBeNull();
  expect(chk?.rule).toBeNull();
  expect(chk?.block).toBe("P2");
  expect(chk?.label).toBe("Invoice lines against the invoice");
  expect(chk?.sources).toEqual(total ? [src(reading), src(total)] : [src(reading)]);
  expect(chk?.inputs).toEqual([]);
}

describe("Property 92: A Subtotal That Was Read but Not Added Up Says So (Validates: Requirements 65.1, 65.2, 65.3)", () => {
  it("Requirement 65.1 and 65.3: an accepted decimal comma subtotal gives the decimal comma reason, and only that reason changes", () => {
    const seen = { leadEuro: 0, leadDollar: 0, leadCode: 0, trailEuro: 0, trailDollar: 0, trailCode: 0, spaced: 0 };
    fc.assert(
      fc.property(decimalCommaSubtotal, fc.boolean(), lineCount, (sub, withTotal, count) => {
        for (const a of sub.affixes) {
          const [where, what] = a.split(":");
          const kind = what === "€" ? "Euro" : what === "$" ? "Dollar" : "Code";
          seen[`${where}${kind}` as keyof typeof seen]++;
        }
        if (sub.spaced) seen.spaced++;
        checkNotAddedUp(sub, withTotal, count, commaReason);
      }),
      { numRuns: 300 },
    );
    // Point 4: the generator reaches every case Requirement 65.1 names
    for (const [name, n] of Object.entries(seen)) expect([name, n > 0]).toEqual([name, true]);
  });

  it("Requirement 65.1 and 65.3: an accepted subtotal in another form gives the not-a-number reason, and only that reason changes", () => {
    const seen = { lead: 0, trail: 0, spaced: 0 };
    fc.assert(
      fc.property(notANumberSubtotal, fc.boolean(), lineCount, (sub, withTotal, count) => {
        if (sub.affixes.some((a) => a.startsWith("lead:"))) seen.lead++;
        if (sub.affixes.some((a) => a.startsWith("trail:"))) seen.trail++;
        if (sub.spaced) seen.spaced++;
        checkNotAddedUp(sub, withTotal, count, notNumberReason);
      }),
      { numRuns: 300 },
    );
    for (const [name, n] of Object.entries(seen)) expect([name, n > 0]).toEqual([name, true]);
  });

  it("Requirement 65.2: without a subtotal reading the reason is the no-subtotal reason with the other reasons after it", () => {
    fc.assert(
      fc.property(fc.boolean(), lineCount, (withTotal, count) => {
        const { readings, total } = minimalInvoice(withTotal);
        const chk = f(build(readings, count), "CHK.INVOICE");
        expect(chk?.reason).toBe(NO_SUBTOTAL + otherReasons(count));
        expect(chk?.status).toBe("needsReview");
        expect(chk?.value).toBeNull();
        expect(chk?.sources).toEqual(total ? [src(total)] : []);
        expect(chk?.inputs).toEqual([]);
      }),
      { numRuns: 30 },
    );
  });

  // Point 8: the subtotal reading is made uncertain (low confidence) or rejected, with values of every kind.
  const anySubtotalText = fc.oneof(
    decimalCommaSubtotal.map((s) => s.text),
    notANumberSubtotal.map((s) => s.text),
    fc.integer({ min: 1, max: 999999 }).map((c) => (c / 100).toFixed(2)),
    fc.constant("1000.00"),
  );
  const notAcceptedStatus = fc.constantFrom(
    { status: "uncertain", confidence: "low", message: "The reader was not sure of this value." },
    { status: "uncertain", confidence: "low", notInTranscript: true, box: null, itemIds: [], message: "Not in the transcript." },
    { status: "uncertain", confidence: "low", lineWithoutBox: true, box: null, itemIds: [], message: "No usable place." },
    { status: "rejected", reason: "quote_not_found", message: "Rejected" },
    { status: "rejected", reason: "value_not_in_quote", message: "Rejected" },
    { status: "rejected", reason: "empty_quote", message: "Rejected" },
  );

  it("Requirement 65.2 and 65.3: a low-confidence or rejected subtotal reading does not change CHK.INVOICE", () => {
    const seen = { lowConfidence: 0, rejected: 0 };
    fc.assert(
      fc.property(anySubtotalText, notAcceptedStatus, fc.boolean(), lineCount, (text, more, withTotal, count) => {
        if (more.status === "uncertain") seen.lowConfidence++;
        else seen.rejected++;
        const { readings } = minimalInvoice(withTotal);
        const without = build(readings, count);
        const d = build([...readings, R("invoice.subtotal", text, more)], count);
        expect(d.checks).toEqual(without.checks);
        expect(f(d, "CHK.INVOICE")).toEqual(f(without, "CHK.INVOICE"));
        expect(f(d, "CHK.INVOICE")?.reason).toBe(NO_SUBTOTAL + otherReasons(count));
      }),
      { numRuns: 150 },
    );
    expect(seen.lowConfidence).toBeGreaterThan(0);
    expect(seen.rejected).toBeGreaterThan(0);
  });

  it("Requirement 65.2: an accepted subtotal reading with an empty value gives the no-subtotal reason and stays a source", () => {
    fc.assert(
      fc.property(fc.boolean(), lineCount, (withTotal, count) => {
        const { readings, total } = minimalInvoice(withTotal);
        const reading = R("invoice.subtotal", "");
        const chk = f(build([...readings, reading], count), "CHK.INVOICE");
        expect(chk?.reason).toBe(NO_SUBTOTAL + otherReasons(count));
        expect(chk?.sources).toEqual(total ? [src(reading), src(total)] : [src(reading)]);
        expect(chk?.inputs).toEqual([]);
      }),
      { numRuns: 30 },
    );
  });

  it("Requirement 65.3: CHK.INVOICE always has block P2, is needsReview with null value and no rule", () => {
    fc.assert(
      fc.property(fc.oneof(decimalCommaSubtotal, notANumberSubtotal), (sub) => {
        const { readings } = minimalInvoice(true);
        const chk = f(build([...readings, R("invoice.subtotal", sub.text)]), "CHK.INVOICE");
        expect(chk?.block).toBe("P2");
        expect(chk?.label).toBe("Invoice lines against the invoice");
        expect(chk?.status).toBe("needsReview");
        expect(chk?.value).toBeNull();
        expect(chk?.rule).toBeNull();
      }),
      { numRuns: 50 },
    );
  });

  it("Requirement 65.3: P2 invoice checks are the same as without a subtotal reading when P2 does not read the subtotal", () => {
    fc.assert(
      fc.property(fc.oneof(decimalCommaSubtotal, notANumberSubtotal), fc.boolean(), (sub, withTotal) => {
        const { readings } = minimalInvoice(withTotal);
        const without = build(readings);
        const d = build([...readings, R("invoice.subtotal", sub.text)]);
        expect(d.checks.find((c) => c.id === "P2.invoice.subtotal")).toBeUndefined();
        expect(d.checks).toEqual(without.checks);
      }),
      { numRuns: 50 },
    );
  });

  it("Requirement 65.1 and 65.3: when P2 reads the subtotal, the P2 checks run and CHK.INVOICE has no subtotal reason", () => {
    const seen = { equal: 0, different: 0 };
    fc.assert(
      fc.property(fc.oneof(fc.constant(100000), fc.integer({ min: 100, max: 999999 })), lineCount, (subtotalCents, count) => {
        const subtotalText = (subtotalCents / 100).toFixed(2);
        const { readings, total } = minimalInvoice(true);
        const reading = R("invoice.subtotal", subtotalText);
        const d = build([...readings, reading], count);
        const chk = f(d, "CHK.INVOICE");
        // P2 allows a difference of one cent
        const ok = Math.abs(subtotalCents - 100000) <= 1;
        if (ok) seen.equal++;
        else seen.different++;

        expect(d.checks.filter((c) => c.rule === "P2")).toEqual([
          {
            id: "P2.invoice.subtotal",
            rule: "P2",
            label: "Invoice subtotal",
            ok,
            detail: ok ? "sum of line amounts = subtotal" : `line sum = 1000.00, subtotal = ${subtotalText}`,
          },
          {
            id: "P2.invoice.total",
            rule: "P2",
            label: "Invoice total",
            ok,
            detail: ok ? "subtotal = total" : `subtotal = ${subtotalText}, total = 1000.00`,
          },
        ]);

        const mismatch = ok
          ? ""
          : `The invoice line amounts do not match the invoice totals (line sum = 1000.00, subtotal = ${subtotalText}; subtotal = ${subtotalText}, total = 1000.00). A line may be missing; compare the 7501 lines with the invoice.`;
        const expectedReason = [mismatch, otherReasons(count).trim()].filter((s) => s !== "").join(" ");
        if (expectedReason === "") {
          expect(chk).toBeUndefined();
        } else {
          expect(chk?.reason).toBe(expectedReason);
          expect(chk?.sources).toEqual([src(reading), src(total!)]);
          expect(chk?.inputs).toEqual(["P2.invoice.subtotal", "P2.invoice.total"]);
        }
      }),
      { numRuns: 100 },
    );
    expect(seen.equal).toBeGreaterThan(0);
    expect(seen.different).toBeGreaterThan(0);
  });
});
