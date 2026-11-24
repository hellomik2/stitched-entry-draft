import { describe, it, expect, beforeAll } from "vitest";
import { runBundleFromDisk } from "../node/index";
import { buildDraft, allFields, type Draft } from "./draft";
import type { VerifiedReading } from "./reading";
import type { HtsTable } from "./hts";

// Feature: document-intake, Requirement 52.2, 52.3 and 51.5 (tasks 64.1 and 65.1): an accepted country name, a printed
// date and an origin the app does not know reach the draft with the right status and reason; the packing list line count.

let verified: VerifiedReading[];
let hts: HtsTable;
let sample: Draft;

beforeAll(async () => {
  const b = await runBundleFromDisk(process.cwd(), "lantern-hollow", []);
  verified = b.verified;
  hts = b.hts;
  sample = b.draft;
});

const withValue = (field: string, value: string) =>
  verified.map((r) => (r.field === field && r.status === "accepted" ? ({ ...r, value } as VerifiedReading) : r));
const build = (readings: VerifiedReading[], packingListLineCount?: number | null) =>
  buildDraft({ bundle: "lantern-hollow", reader: "test", readings, hts, ...(packingListLineCount !== undefined ? { packingListLineCount } : {}) });
const header = (d: Draft, id: string) => d.header.find((f) => f.id === id)!;
const tenOfInvoiceLine = (d: Draft, n: number) => d.lines.find((l) => l.invoiceLines.includes(n))!.fields.find((f) => f.block === "10")!;

describe("Feature: document-intake, Requirement 52: B14, B15 and L<nnn>.10 for an accepted value", () => {
  it("B14: the accepted country name \"Germany\" gives DE, copied, with the printed name as its note", () => {
    expect(header(build(withValue("invoice.countryOfExport", "Germany")), "B14")).toMatchObject({ status: "copied", value: "DE", note: "Germany" });
  });

  it("B15: the accepted on-board date \"12-NOV-2026\" gives 11/12/2026, copied", () => {
    expect(header(build(withValue("billOfLading.onBoardDate", "12-NOV-2026")), "B15")).toMatchObject({ status: "copied", value: "11/12/2026" });
  });

  it("B15: a date form the quote check does not know still waits with the parseUsDate reason", () => {
    const f = header(build(withValue("billOfLading.onBoardDate", "12/11/26")), "B15");
    expect(f.status).toBe("needsReview");
    expect(f.value).toBeNull();
    expect(f.reason).toContain('Invalid date format: "12/11/26"');
  });

  it("L<nnn>.10: an accepted origin \"DE\" is copied", () => {
    expect(tenOfInvoiceLine(build(withValue("invoice.lines.1.origin", "DE")), 1)).toMatchObject({ status: "copied", value: "DE" });
  });

  it("L<nnn>.10: an accepted origin the app does not know says so, and does not say it was rejected", () => {
    const f = tenOfInvoiceLine(build(withValue("invoice.lines.1.origin", "ZZ")), 1);
    expect(f.status).toBe("needsReview");
    expect(f.value).toBeNull();
    expect(f.reason).toContain('Invoice line 1: the AI reader read "ZZ", which is not a country name or code the app knows. A person checks it on the invoice.');
    expect(f.reason).not.toContain("its quote is not on the page");
  });

  it("the sample draft is unchanged when nothing is changed", () => {
    const d = build(verified);
    expect(allFields(d)).toEqual(allFields(sample));
    expect(d.checks).toEqual(sample.checks);
  });
});

describe("Feature: document-intake, Requirement 51.5: the packing list line count", () => {
  const linesRead = () =>
    new Set(verified.map((r) => /^packingList\.lines\.(\d+)\./.exec(r.field)?.[1]).filter((n): n is string => n !== undefined && Number(n) <= 8)).size;

  it("with no count the checks are as today", () => {
    expect(build(verified).checks.some((c) => c.id === "P3.packing.lines")).toBe(false);
    expect(build(verified, null).checks).toEqual(sample.checks);
  });

  it("a count equal to the lines read gives an ok check", () => {
    const m = linesRead();
    const c = build(verified, m).checks.find((x) => x.id === "P3.packing.lines");
    expect(c).toEqual({ id: "P3.packing.lines", rule: "P3", label: "Packing list lines read", ok: true, detail: `the packing list shows ${m} item lines and the draft has readings for ${m}` });
  });

  it("a count that differs gives a failed check that names both numbers", () => {
    const m = linesRead();
    const fewer = verified.filter((r) => !/^packingList\.lines\.[2-9]\./.test(r.field));
    const c = build(fewer, 6).checks.find((x) => x.id === "P3.packing.lines");
    expect(c).toEqual({ id: "P3.packing.lines", rule: "P3", label: "Packing list lines read", ok: false, detail: "the packing list shows 6 item lines, but the draft has readings for 1" });
    expect(m).toBe(8);
  });

  it("a count over 8 says the draft reads only the first 8", () => {
    const c = build(verified, 9).checks.find((x) => x.id === "P3.packing.lines");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toBe("the packing list shows 9 item lines, but the draft has readings for 8; this draft reads only the first 8");
  });
});
