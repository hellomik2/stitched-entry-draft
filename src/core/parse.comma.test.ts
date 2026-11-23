import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { parseKgToTenths, parsePackages, parseMoneyToCents, parseCount } from "./parse";
import { verifyReadings } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import { buildDraft, allFields } from "./draft";
import type { DocumentText } from "./pdfText";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

const val = (r: { ok: boolean }) => (r.ok ? (r as { ok: true; value: number }).value : "REVIEW");

describe("Requirement 40: thousands commas in weights and package counts", () => {
  it("40.1 weights with thousands commas read as the same value", () => {
    expect(val(parseKgToTenths("1,248.0"))).toBe(12480);
    expect(val(parseKgToTenths("12,345.6 kg"))).toBe(123456);
    expect(val(parseKgToTenths("1,284"))).toBe(12840);
    expect(val(parseKgToTenths("1,234,567.8"))).toBe(12345678);
    expect(val(parseKgToTenths("286.2"))).toBe(2862);
    expect(val(parseKgToTenths("48.0 KG"))).toBe(480);
  });

  it("40.1 a comma in a wrong place and other bad forms are not a weight", () => {
    for (const t of ["1,24.8", "12,34", "1,2345.0", ",123.4", "123,", "1,,234.5", "1,248.05", "1.25", "1 248.0", "12,345,67.8"]) {
      expect(val(parseKgToTenths(t)), t).toBe("REVIEW");
    }
  });

  it("40.2 package counts with thousands commas", () => {
    expect(val(parsePackages("1,200 CTNS"))).toBe(1200);
    expect(val(parsePackages("12,000"))).toBe(12000);
    expect(val(parsePackages("77 CTNS"))).toBe(77);
    for (const t of ["1,20 CTNS", "1,2000 CTNS", ",200 CTNS"]) expect(val(parsePackages(t)), t).toBe("REVIEW");
  });

  it("40.3 money and counts already read thousands commas (unchanged)", () => {
    expect(val(parseMoneyToCents("3,294.20"))).toBe(329420);
    expect(val(parseMoneyToCents("1,23.00"))).toBe("REVIEW");
    expect(val(parseCount("1,236"))).toBe(1236);
    expect(val(parseCount("1,23"))).toBe("REVIEW");
  });

  it("Property 56: a thousands comma does not change a weight; a comma before the last two digits is never read (200 runs)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_999 }), fc.integer({ min: 0, max: 9 }), (whole, tenth) => {
        const tenths = whole * 10 + tenth;
        const grouped = whole.toLocaleString("en-US") + "." + tenth;
        expect(val(parseKgToTenths(grouped))).toBe(tenths);
        expect(val(parseKgToTenths(String(whole) + "." + tenth))).toBe(tenths);
        expect(val(parseKgToTenths(grouped + " kg"))).toBe(tenths);
        if (whole >= 100) {
          const s = String(whole);
          expect(val(parseKgToTenths(s.slice(0, -2) + "," + s.slice(-2) + "." + tenth))).toBe("REVIEW");
        }
      }),
      { numRuns: 200 }
    );
  });
});

describe("Requirement 40: the draft of the sample with weights over 1,000 kg", () => {
  let answer: ReadingAnswer;
  let documents: DocumentText[];
  let hts: HtsTable;
  beforeAll(async () => {
    const b = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    answer = b.answer;
    documents = b.documents;
    hts = b.hts;
  });
  const draftWith = (values: Record<string, string>) => {
    const readings: VerifiedReading[] = verifyReadings(answer, documents);
    for (const r of readings) if (r.field in values) r.value = values[r.field];
    return buildDraft({ bundle: "lantern-hollow", reader: answer.reader, readings, hts, invoiceLineCount: answer.invoiceLineCount ?? null, overrides: [] });
  };

  it("34A, P3.packing.gross and X.bl.gross read 1,286.2 kg", () => {
    const d = draftWith({ "packingList.lines.1.grossKg": "1,055.5", "packingList.totalGrossKg": "1,286.2", "billOfLading.grossKg": "1,286.2" });
    const f34 = allFields(d).filter((f) => /\.34A$/.test(f.id));
    expect(f34.map((f) => [f.id, f.status])).toEqual(f34.map((f) => [f.id, "computed"]));
    const g = d.checks.find((c) => c.id === "P3.packing.gross");
    expect([g?.ok, g?.detail]).toEqual([true, "line sum = 1286.2, total = 1286.2"]);
    const x = d.checks.find((c) => c.id === "X.bl.gross");
    expect([x?.ok, x?.detail]).toEqual([true, "B/L gross = 1286.2, packing gross = 1286.2"]);
  });

  it("X.bl.packages reads 1,037 CTNS", () => {
    const d = draftWith({ "billOfLading.packages": "1,037 CTNS", "packingList.totalCartons": "1,037" });
    const x = d.checks.find((c) => c.id === "X.bl.packages");
    expect([x?.ok, x?.detail]).toEqual([true, "B/L packages = 1037, packing cartons = 1037"]);
  });

  it("40.4 P3 sum checks name a packing list line whose weight or cartons were not used", () => {
    const names = ["packingList.lines.3.grossKg", "packingList.lines.3.netKg", "packingList.lines.3.cartons"];
    const low = { ...answer, fields: answer.fields.map((f) => (names.includes(f.field) ? { ...f, confidence: "low" as const } : f)) };
    const d = buildDraft({ bundle: "lantern-hollow", reader: answer.reader, readings: verifyReadings(low, documents), hts, invoiceLineCount: answer.invoiceLineCount ?? null, overrides: [] });
    const c = (id: string) => { const x = d.checks.find((k) => k.id === id); return [x?.ok, x?.detail]; };
    expect(c("P3.packing.gross")).toEqual([false, "packing list line 3 gross weight not read or not sure"]);
    expect(c("P3.packing.net")).toEqual([false, "packing list line 3 net weight not read or not sure"]);
    expect(c("P3.packing.cartons")).toEqual([false, "packing list line 3 cartons not read or not sure"]);
    const plain = draftWith({});
    expect(["P3.packing.gross", "P3.packing.net", "P3.packing.cartons"].map((id) => plain.checks.find((k) => k.id === id)?.ok)).toEqual([true, true, true]);
  });
});
