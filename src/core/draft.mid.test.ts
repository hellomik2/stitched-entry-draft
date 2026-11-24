import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runBundleFromDisk } from "../node/index";
import { buildDraft, type Draft, type DraftField } from "./draft";
import { readCsvSheet } from "./sheet";
import { readPartsList, type PartsList } from "./partsList";
import type { VerifiedReading } from "./reading";
import type { HtsTable } from "./hts";

// Feature: document-intake, Requirement 48.9 (task 60.1): B13 suggested by the MID rule.

const hts: HtsTable = JSON.parse(readFileSync(join(process.cwd(), "data", "hts", "2026HTSRev23-subset.json"), "utf8"));
const BOX = { x: 10, y: 10, w: 40, h: 10 };
const BASE = "Suggested from the invoice issuer's name and address by the MID rule of the 7501 instructions (Appendix 2). The MID names the manufacturer: a person checks that the invoice issuer made the goods or sold them directly, and confirms.";
const NOT_READ = "The invoice issuer's name or address was not read, so no MID is suggested. A person enters the manufacturer's MID.";
const NO_ORIGIN = "The country of origin of a line is not known, so the first two letters of the MID are not known. A person enters the MID.";
const GLOAM = { name: "Gloamwick Paper Lantern Co.", address: "88 Duskvine Lane, Thornhollow 00000, Vietnam" };

let seq = 0;
function acc(field: string, value: string): VerifiedReading {
  const doc = field.split(".")[0];
  seq += 1;
  return { field, value, quote: value, doc, page: 1, confidence: "high", status: "accepted", box: BOX, itemIds: [`${doc}:p1:i${seq}`] };
}
type Line = { hts: string; origin?: string; item?: string };
function readings(lines: Line[], seller: { name: string; address: string } | null): VerifiedReading[] {
  const out: VerifiedReading[] = [acc("invoice.currency", "USD")];
  if (seller) out.push(acc("invoice.seller.name", seller.name), acc("invoice.seller.address", seller.address));
  lines.forEach((l, i) => {
    const n = i + 1;
    if (l.item) out.push(acc(`invoice.lines.${n}.itemNo`, l.item));
    out.push(acc(`invoice.lines.${n}.description`, `Item ${n}`));
    out.push(acc(`invoice.lines.${n}.hts`, l.hts));
    if (l.origin) out.push(acc(`invoice.lines.${n}.origin`, l.origin));
    out.push(acc(`invoice.lines.${n}.quantity`, "100"));
    out.push(acc(`invoice.lines.${n}.unit`, "PCS"));
    out.push(acc(`invoice.lines.${n}.unitPrice`, "1.00"));
    out.push(acc(`invoice.lines.${n}.amount`, "100.00"));
  });
  return out;
}
const draftOf = (lines: Line[], seller: { name: string; address: string } | null, table: HtsTable = hts, partsList: PartsList | null = null): Draft =>
  buildDraft({ bundle: "upload", reader: "test", readings: readings(lines, seller), hts: table, partsList });
const b13 = (d: Draft): DraftField => d.header.find((f) => f.id === "B13")!;
const docFields = (f: DraftField) => f.sources.filter((s) => s.kind === "document").map((s: any) => s.readingField);

describe("Requirement 48.9: B13", () => {
  it("the sample: a line without an origin, so no MID is suggested (no more 'trading company' text)", async () => {
    const f = b13((await runBundleFromDisk(process.cwd(), "lantern-hollow", [])).draft);
    expect([f.status, f.value, f.rule, f.reason, f.inputs]).toEqual(["needsReview", null, "7501 Appendix 2", NO_ORIGIN, ["B10"]]);
    expect(docFields(f)).toEqual(["invoice.seller.name", "invoice.seller.address"]);
  });

  it("one origin: the MID is suggested, with its parts, and waits for a person", () => {
    const f = b13(draftOf([{ hts: "9405.50.4000", origin: "VN" }, { hts: "7013.99.3500", origin: "VN" }], GLOAM));
    expect([f.status, f.value, f.rule, f.reason, f.inputs]).toEqual(["needsReview", "VNGLOPAP88THO", "7501 Appendix 2", BASE, ["B10"]]);
    expect(f.candidates).toEqual([{ value: "VNGLOPAP88THO", label: "VNGLOPAP88THO" }]);
    expect(f.note).toBe(`VN + GLOPAP + 88 + THO from "Gloamwick Paper Lantern Co." and "88 Duskvine Lane, Thornhollow 00000, Vietnam".`);
    expect(docFields(f)).toEqual(["invoice.seller.name", "invoice.seller.address"]);
    expect(f.reason).not.toContain("trading company");
  });

  it("the origin differs from the issuer's country", () => {
    const f = b13(draftOf([{ hts: "9405.50.4000", origin: "PT" }], GLOAM));
    expect(f.value).toBe("PTGLOPAP88THO");
    expect(f.reason).toBe(`${BASE} The goods come from PT but the invoice issuer's address is in VN; the MID starts with the country of origin.`);
  });

  // Block 10 knows VN, PT, CZ, CN and US today, so this case has CN goods from an Indonesian issuer; the Canadian province code is covered in mid.test.ts.
  it("a generic leading word: named in the reason, and the MID without it is a second candidate", () => {
    const f = b13(draftOf([{ hts: "9405.50.4000", origin: "CN" }], { name: "PT Sinar Lantern Indah", address: "Jl. Merdeka 45, Surabaya, Indonesia" }));
    expect(f.value).toBe("CNPTSIN45SUR");
    expect(f.candidates).toEqual([
      { value: "CNPTSIN45SUR", label: "CNPTSIN45SUR" },
      { value: "CNSINLAN45SUR", label: `CNSINLAN45SUR without "PT"` },
    ]);
    expect(f.reason).toBe(`${BASE} The name starts with "PT", a word for a kind of company. Appendix 2 leaves out some such words; a person decides whether to leave it out. The goods come from CN but the invoice issuer's address is in ID; the MID starts with the country of origin.`);
  });

  it("textiles: the MID must be the actual manufacturer's", () => {
    const tex: HtsTable = {
      ...hts,
      rows: [...hts.rows, { htsno: "6109.10.00.12", indent: 3, description: "Men's or boys' T-shirts of cotton", units: ["doz.", "kg"], general: "16.5%", special: "Free (AU)", footnotes: [] }],
    };
    const f = b13(draftOf([{ hts: "6109.10.0012", origin: "VN" }], GLOAM, tex));
    expect(f.value).toBe("VNGLOPAP88THO");
    expect(f.reason).toBe(`${BASE} Textile goods (chapters 50 to 63): the MID must be the actual manufacturer's (19 CFR 102.23), not a trading company's.`);
  });

  it("several origins: no value, the MID of each line in the reason", () => {
    const f = b13(draftOf([{ hts: "9405.50.4000", origin: "VN" }, { hts: "7013.99.3500", origin: "VN" }, { hts: "9505.90.6000", origin: "CN" }], GLOAM));
    expect([f.status, f.value]).toEqual(["needsReview", null]);
    expect(f.reason).toBe("The lines come from more than one country, so the MID differs by line: VNGLOPAP88THO for line 001, 002; CNGLOPAP88THO for line 003. A person enters MULTI and the MID of each line.");
  });

  it("not read, or a line without an origin: no value", () => {
    const notRead = b13(draftOf([{ hts: "9405.50.4000", origin: "VN" }], null));
    expect([notRead.status, notRead.value, notRead.reason, notRead.sources]).toEqual(["needsReview", null, NOT_READ, []]);
    const noOrigin = b13(draftOf([{ hts: "9405.50.4000", origin: "VN" }, { hts: "7013.99.3500" }], GLOAM));
    expect([noOrigin.status, noOrigin.value, noOrigin.reason]).toEqual(["needsReview", null, NO_ORIGIN]);
  });

  it("no city in the address: the rule's reason", () => {
    const f = b13(draftOf([{ hts: "9405.50.4000", origin: "VN" }], { name: "Gloamwick Paper Lantern Co.", address: "Vietnam" }));
    expect([f.status, f.value, f.reason]).toEqual(["needsReview", null, "The invoice issuer's name or city gives no letters for the MID."]);
  });

  it("the customer parts list MID comes first (Requirement 46.7)", () => {
    const sh = readCsvSheet("Part No,HTS,MID\nA-1,9405.50.4000,VNAAABBB11HAN\n", "parts.csv");
    if (!sh.ok) throw new Error(sh.reason);
    const pl = readPartsList(sh.value);
    if (!pl.ok) throw new Error(pl.reason);
    const f = b13(draftOf([{ hts: "9405.50.4000", origin: "VN", item: "A-1" }], GLOAM, hts, pl.value));
    expect([f.status, f.value, f.note]).toEqual(["copied", "VNAAABBB11HAN", "From the customer parts list (one MID for every line)."]);
  });

  it("a person confirms the suggestion", () => {
    const d = buildDraft({ bundle: "upload", reader: "test", readings: readings([{ hts: "9405.50.4000", origin: "VN" }], GLOAM), hts, overrides: [{ fieldId: "B13", value: "VNGLOPAP88THO" }] });
    expect([b13(d).status, b13(d).value]).toEqual(["personEdited", "VNGLOPAP88THO"]);
  });
});
