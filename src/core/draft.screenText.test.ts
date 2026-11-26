import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReadings, type VerifiedReading } from "./reading";
import { buildDraft, allFields, type Draft, type Override } from "./draft";
import { draftToCsv, parseCsv } from "./csv";
import type { HtsTable } from "./hts";
import { loadBundleFromDisk } from "../node/index";

// Feature: document-intake, Requirement 64 (task 82.1): three screen texts read as sentences and equations.

let hts: HtsTable;
let sample: VerifiedReading[];
let demo: Override[];

beforeAll(async () => {
  const b = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
  hts = b.hts;
  sample = verifyReadings(b.answer, b.documents);
  demo = JSON.parse(readFileSync(join(process.cwd(), "samples", "lantern-hollow", "overrides-demo.json"), "utf8")).overrides;
});

const build = (readings: VerifiedReading[], overrides: Override[] = []): Draft =>
  buildDraft({ bundle: "lantern-hollow", reader: "fixture", readings, hts, overrides, invoiceLineCount: 8 });
const f = (d: Draft, id: string) => allFields(d).find((x) => x.id === id);

const NEW_35 = "120 PCS + 96 PCS = 216 PCS = 18 Dz Pcs";
const NEW_QTY = "Invoice line 3 says 240 PCS; the packing list says 216 PCS. A person decides.";
const NEW_P1 = "P1 mismatch: quantity × unitPrice = 480.00, amount = 468.00, diff = 12.00. A person decides.";
const OLD_35 = "120 + 96 Dz Pcs";
const OLD_QTY = "says 240 PCS, the packing list says 216 PCS. A person decides.";
const OLD_P1 = "P1 mismatch: quantity × unitPrice = 480.00, amount = 468.00, diff = 12.00 A person decides.";

describe("Requirement 64: the sample's three texts", () => {
  it("64.1 to 64.3: the note of L001.35 and the reasons of L003.35 and L004.36A", () => {
    const d = build(sample);
    expect([f(d, "L001.35")?.status, f(d, "L001.35")?.value, f(d, "L001.35")?.unit, f(d, "L001.35")?.note]).toEqual(["computed", "18", "Dz Pcs", NEW_35]);
    expect([f(d, "L003.35")?.status, f(d, "L003.35")?.reason]).toEqual(["needsReview", NEW_QTY]);
    expect([f(d, "L004.36A")?.status, f(d, "L004.36A")?.reason]).toEqual(["needsReview", NEW_P1]);
  });

  it("64.1 to 64.3 with the demo answers: the notes keep the new texts after \"Before:\"", () => {
    const d = build(sample, demo);
    expect(f(d, "L001.35")?.note).toBe(NEW_35);
    expect(f(d, "L003.35")?.note).toBe(`Entered by a person. Before: ${NEW_QTY}`);
    expect(f(d, "L004.36A")?.note).toBe(`Entered by a person. Before: ${NEW_P1}`);
  });

  it("64.4: the sample CSVs differ from before only in these texts (the old texts put back give the old fingerprints)", async () => {
    const { runBundleFromDisk } = await import("../node/index");
    const before: Record<string, string> = {
      raw: "4276d1db29164275a6221adbfc284ba8c240ae1b75adea5ce1388c730a16f803",
      demo: "3312056aa79544807eeea352444ec1105bfe59e39dfe2ae8885ba75243c674a3",
    };
    for (const [name, ov] of [["raw", [] as Override[]], ["demo", demo]] as [string, Override[]][]) {
      const csv: string = (await runBundleFromDisk(process.cwd(), "lantern-hollow", ov)).csv;
      expect(csv.split(NEW_35).length - 1).toBe(1);
      expect(csv.split(NEW_QTY).length - 1).toBe(1);
      expect(csv.split(NEW_P1).length - 1).toBe(1);
      // put the old texts back cell by cell and write the CSV again by the rule of draftToCsv (a cell with a comma, a quote or a line break is quoted)
      const cell = (c: string) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
      const old =
        parseCsv(csv)
          .map((row) => row.map((c) => cell(c.replace(NEW_35, OLD_35).replace(NEW_QTY, OLD_QTY).replace(NEW_P1, OLD_P1))).join(","))
          .join("\r\n") + "\r\n";
      expect(createHash("sha256").update(old, "utf8").digest("hex")).toBe(before[name]);
    }
  });
});

let item = 0;
const R = (field: string, value: string, doc = "invoice"): VerifiedReading =>
  ({ field, value, quote: value, doc, page: 1, confidence: "high", status: "accepted", box: { x: 1, y: 1 + item, w: 5, h: 5 }, itemIds: [`${doc}:p1:i${++item}`] }) as VerifiedReading;

/** One 7501 line made of k invoice lines with the same HTS number and origin, and a packing list line for each item. */
function group(htsNo: string, lines: { qty: number; unit: string; packed?: number }[]): VerifiedReading[] {
  const out: VerifiedReading[] = [R("invoice.currency", "USD")];
  lines.forEach(({ qty, unit, packed }, i) => {
    const n = i + 1;
    out.push(
      R(`invoice.lines.${n}.itemNo`, `IT-${n}`),
      R(`invoice.lines.${n}.hts`, htsNo),
      R(`invoice.lines.${n}.origin`, "PT"),
      R(`invoice.lines.${n}.quantity`, String(qty)),
      R(`invoice.lines.${n}.unit`, unit),
      R(`invoice.lines.${n}.unitPrice`, "1.00"),
      R(`invoice.lines.${n}.amount`, `${qty}.00`),
      R(`packingList.lines.${n}.itemNo`, `IT-${n}`, "packingList"),
      R(`packingList.lines.${n}.quantity`, String(packed ?? qty), "packingList"),
    );
  });
  return out;
}

describe("Property 91: A Quantity Note in Piece Units Is an Equation That Holds (Validates: Requirements 64.1, 64.2, 64.3)", () => {
  const pieceUnit = fc.constantFrom("PCS", "PC", "EA", "PIECES", "NO.", "pcs", "Pcs");

  it("the note of a computed 35 of several invoice lines in piece units is q1 u1 + ... = s PCS = v unit", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("6913.90.5000", "7013.99.3500"),
        fc.array(fc.record({ qty: fc.integer({ min: 1, max: 5000 }), unit: pieceUnit }), { minLength: 2, maxLength: 4 }),
        (htsNo, lines) => {
          const d = buildDraft({ bundle: "t", reader: "t", readings: group(htsNo, lines), hts, overrides: [] });
          const x = f(d, "L001.35")!;
          expect(x.status).toBe("computed");
          const sum = lines.reduce((s, l) => s + l.qty, 0);
          const terms = lines.map((l) => `${l.qty} ${l.unit.toUpperCase()}`).join(" + ");
          expect(x.note).toBe(`${terms} = ${sum} PCS${x.unit ? ` = ${x.value} ${x.unit}` : ""}`);
          if (x.unit === "Dz Pcs") expect(Number(x.value)).toBeCloseTo(sum / 12, 2);
          else expect(x.value).toBe(String(sum));
        },
      ),
      { numRuns: 80 },
    );
  });

  it("one invoice line keeps today's note", () => {
    const d = buildDraft({ bundle: "t", reader: "t", readings: group("7013.99.3500", [{ qty: 200, unit: "PCS" }]), hts, overrides: [] });
    expect(f(d, "L001.35")?.note).toBe("200 No.");
  });

  it("the reason of a quantity that is not the packing list sum names the invoice line", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 1, max: 999 }), (qty, packed) => {
        fc.pre(qty !== packed);
        const d = buildDraft({ bundle: "t", reader: "t", readings: group("7013.99.3500", [{ qty: 10, unit: "PCS" }, { qty, unit: "PCS", packed }]), hts, overrides: [] });
        expect(f(d, "L001.35")?.reason).toBe(`Invoice line 2 says ${qty} PCS; the packing list says ${packed} PCS. A person decides.`);
      }),
      { numRuns: 40 },
    );
  });

  it("the reason of the P1 case of 36A ends with \". A person decides.\" and has no digit right before \" A person decides.\"", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50_000 }), (off) => {
        const readings = sample.map((r) => (r.field === "invoice.lines.2.amount" ? ({ ...r, value: `${(42000 + off) / 100}` } as VerifiedReading) : r));
        const x = f(build(readings), "L002.36A")!;
        expect(x.status).toBe("needsReview");
        expect(x.reason).toMatch(/^P1 mismatch: quantity × unitPrice = \d+\.\d{2}, amount = \d+\.\d{2}, diff = \d+\.\d{2}\. A person decides\.$/);
        expect(x.reason).not.toMatch(/\d A person decides/);
      }),
      { numRuns: 40 },
    );
  });
});
