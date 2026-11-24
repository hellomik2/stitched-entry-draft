import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runBundleFromDisk } from "../node/index";
import { buildDraft, IMAGE_COMPUTED_REVIEW_REASON, type Draft, type DraftField } from "./draft";
import { draftToCsv, parseCsv, formatSource } from "./csv";
import type { VerifiedReading } from "./reading";
import type { HtsTable } from "./hts";
import { SCHEDULE_D, SCHEDULE_K, lookupUsPort, lookupForeignPort } from "./codeTables";

// Feature: document-intake, Requirement 47.4 to 47.10 (task 59.1): B6, B9, B19 and B20 from the bill of lading and the CBP code tables.

const hts: HtsTable = JSON.parse(readFileSync(join(process.cwd(), "data", "hts", "2026HTSRev23-subset.json"), "utf8"));
const BOX = { x: 10, y: 10, w: 40, h: 10 };
const K_DATE = "Schedule K (CBP Appendix F list of 2024-08-27 with the changes to 04/2026 from the table of 2026-08-20; later Army Corps updates not included)";
const B9_WAIT = "The container number on the bill of lading was not read, so the mode of transport is not known. A person checks the bill of lading.";
const B9_TEN_NOTE = "Vessel, not containerized: no container number was read on the bill of lading. The 7501 instructions use 10 for a vessel when it is not known whether the goods were containerized.";
const B9_NO_VESSEL = "No vessel and no container number were read from the bill of lading, so the mode of transport is not known. A person checks the transport document.";
const B6_ONE = "Block 6 is the port where the entry is filed. It is the port of unlading (Block 20) unless the goods moved in bond to another port, so the Block 20 code is suggested. A person confirms it or enters the port of entry.";
const B6_SEVERAL = "Block 6 is the port where the entry is filed. Schedule D has more than one code for the port of discharge, so a person picks it.";
const B6_NONE = "Block 6 is the port where the entry is filed. The port of discharge gave no Schedule D code, so a person enters it.";

let seq = 0;
function acc(field: string, value: string, image = false): VerifiedReading {
  const doc = field.split(".")[0];
  seq += 1;
  const r: VerifiedReading = { field, value, quote: value, doc, page: 1, confidence: "high", status: "accepted", box: BOX, itemIds: [`${doc}:p${1}:i${seq}`] };
  if (image) (r as any).origin = "imageTranscript";
  return r;
}
function baseReadings(): VerifiedReading[] {
  return [
    acc("invoice.currency", "USD"),
    acc("invoice.lines.1.description", "Item 1"),
    acc("invoice.lines.1.hts", "9405.50.4000"),
    acc("invoice.lines.1.origin", "VN"),
    acc("invoice.lines.1.quantity", "100"),
    acc("invoice.lines.1.unit", "PCS"),
    acc("invoice.lines.1.unitPrice", "1.00"),
    acc("invoice.lines.1.amount", "100.00"),
  ];
}
const draftOf = (bl: VerifiedReading[]): Draft => buildDraft({ bundle: "upload", reader: "test", readings: [...baseReadings(), ...bl], hts });
const header = (d: Draft, id: string): DraftField => d.header.find((f) => f.id === id)!;
const docFields = (f: DraftField) => f.sources.filter((s) => s.kind === "document").map((s: any) => s.readingField);
const tableRows = (f: DraftField) => f.sources.filter((s) => s.kind === "codeTable").map((s: any) => [s.table, s.edition, s.code, s.name, s.country]);

describe("Requirement 47.10: the sample bundle", () => {
  const load = runBundleFromDisk(process.cwd(), "lantern-hollow", []);

  it("B19 is computed from Haiphong, Vietnam", async () => {
    const f = header((await load).draft, "B19");
    expect([f.status, f.value, f.rule, f.reason]).toEqual(["computed", "55201", "7501 p.11, Schedule K", null]);
    expect(f.note).toBe(`55201 is "Haiphong; Hai Phong" (Vietnam) in ${K_DATE}.`);
    expect(docFields(f)).toEqual(["billOfLading.portOfLoading"]);
    expect(tableRows(f)).toEqual([["Schedule K", "2024-08-27, changes to 04/2026", "55201", "Haiphong; Hai Phong", "Vietnam"]]);
  });

  it("B20 waits with the two Los Angeles and Long Beach codes, and B6 waits with the same", async () => {
    const d = (await load).draft;
    const b20 = header(d, "B20");
    expect([b20.status, b20.value]).toEqual(["needsReview", null]);
    expect(b20.reason).toBe(`The bill of lading names "Los Angeles, CA, USA". Schedule D has more than one code for it: 2704 Los Angeles, California; 2709 Long Beach, California. A person picks the code.`);
    expect(b20.candidates).toEqual([
      { value: "2704", label: "2704 Los Angeles, California" },
      { value: "2709", label: "2709 Long Beach, California" },
    ]);
    expect(docFields(b20)).toEqual(["billOfLading.portOfDischarge"]);
    expect(tableRows(b20)).toEqual([
      ["Schedule D", "2026-02-03", "2704", "Los Angeles, California", null],
      ["Schedule D", "2026-02-03", "2709", "Long Beach, California", null],
    ]);
    const b6 = header(d, "B6");
    expect([b6.status, b6.value, b6.reason, b6.inputs]).toEqual(["needsReview", null, B6_SEVERAL, ["B20"]]);
    expect(b6.candidates).toEqual(b20.candidates);
  });

  it("B9 stays 11 and the Needs review list has 20 items", async () => {
    const d = (await load).draft;
    const b9 = header(d, "B9");
    expect([b9.status, b9.value]).toEqual(["computed", "11"]);
    expect(d.needsReview.length).toBe(20);
    expect(d.needsReview.map((x) => x.fieldId)).not.toContain("B19");
  });

  it("the CSV gives the code table sources", async () => {
    const rows = parseCsv(draftToCsv((await load).draft));
    const head = rows[0];
    const b19 = rows.find((r) => r[0] === "B19")!;
    expect(b19[head.indexOf("sources")]).toContain(` | Schedule K 2024-08-27, changes to 04/2026 55201 "Haiphong; Hai Phong, Vietnam"`);
    const b20 = rows.find((r) => r[0] === "B20")!;
    expect(b20[head.indexOf("sources")]).toContain(`Schedule D 2026-02-03 2704 "Los Angeles, California" | Schedule D 2026-02-03 2709 "Long Beach, California"`);
  });
});

describe("Requirement 47.4 and 47.5: B20 and B6", () => {
  it("one Schedule D row: B20 computed, B6 suggests it", () => {
    const d = draftOf([acc("billOfLading.portOfDischarge", "Savannah, GA, USA")]);
    const b20 = header(d, "B20");
    expect([b20.status, b20.value, b20.rule, b20.reason]).toEqual(["computed", "1703", "7501 p.12, Schedule D", null]);
    expect(b20.note).toBe(`1703 is "Savannah, Georgia" in Schedule D (CBP Appendix E, 2026-02-03).`);
    expect(docFields(b20)).toEqual(["billOfLading.portOfDischarge"]);
    expect(tableRows(b20)).toEqual([["Schedule D", "2026-02-03", "1703", "Savannah, Georgia", null]]);
    const b6 = header(d, "B6");
    expect([b6.status, b6.value, b6.reason, b6.inputs]).toEqual(["needsReview", "1703", B6_ONE, ["B20"]]);
    expect(b6.candidates).toEqual([{ value: "1703", label: "1703 Savannah, Georgia" }]);
    expect(tableRows(b6)).toEqual(tableRows(b20));
  });

  it("no Schedule D row: both wait without a value", () => {
    const d = draftOf([acc("billOfLading.portOfDischarge", "Atlantis, ZZ, USA")]);
    const b20 = header(d, "B20");
    expect([b20.status, b20.value, b20.candidates ?? []]).toEqual(["needsReview", null, []]);
    expect(b20.reason).toBe(`The port of discharge "Atlantis, ZZ, USA" on the bill of lading is not a port in Schedule D (CBP Appendix E, 2026-02-03). A person looks up the code.`);
    expect(docFields(b20)).toEqual(["billOfLading.portOfDischarge"]);
    expect([header(d, "B6").status, header(d, "B6").value, header(d, "B6").reason]).toEqual(["needsReview", null, B6_NONE]);
  });

  it("not read: both wait", () => {
    const d = draftOf([]);
    expect([header(d, "B20").status, header(d, "B20").value, header(d, "B20").reason]).toEqual(["needsReview", null, "The port of discharge was not read from the bill of lading. A person looks up the Schedule D code."]);
    expect([header(d, "B6").status, header(d, "B6").reason]).toEqual(["needsReview", B6_NONE]);
  });

  it("a port read from an image waits for a person with its value", () => {
    const b20 = header(draftOf([acc("billOfLading.portOfDischarge", "Savannah, GA, USA", true)]), "B20");
    expect([b20.status, b20.value, b20.reason]).toEqual(["needsReview", "1703", IMAGE_COMPUTED_REVIEW_REASON]);
  });

  it("a person picks a candidate", () => {
    const readings = [...baseReadings(), acc("billOfLading.portOfDischarge", "Long Beach, CA, USA")];
    const d = buildDraft({ bundle: "upload", reader: "test", readings, hts, overrides: [{ fieldId: "B20", value: "2709" }, { fieldId: "B6", value: "2709" }] });
    expect([header(d, "B20").status, header(d, "B20").value]).toEqual(["personEdited", "2709"]);
    expect([header(d, "B6").status, header(d, "B6").value]).toEqual(["personEdited", "2709"]);
  });
});

describe("Requirement 47.6: B19", () => {
  it("several codes: waits with every candidate", () => {
    const f = header(draftOf([acc("billOfLading.portOfLoading", "Treasure Cay, Bahamas")]), "B19");
    expect([f.status, f.value]).toEqual(["needsReview", null]);
    expect(f.candidates).toEqual([
      { value: "23644", label: "23644 Treasure Cay (Bahamas)" },
      { value: "26344", label: "26344 Treasure Cay (Bahamas)" },
    ]);
    expect(f.reason).toBe(`The bill of lading names "Treasure Cay, Bahamas". ${K_DATE} has more than one code for it: 23644 Treasure Cay (Bahamas); 26344 Treasure Cay (Bahamas). A person picks the code.`);
    expect(tableRows(f).map((r) => r[2])).toEqual(["23644", "26344"]);
  });

  it("no code: waits, and the country's All Other rows are candidates", () => {
    const f = header(draftOf([acc("billOfLading.portOfLoading", "Cai Mep, Vietnam")]), "B19");
    expect([f.status, f.value]).toEqual(["needsReview", null]);
    expect(f.reason).toBe(
      `The port of loading "Cai Mep, Vietnam" on the bill of lading is not in ${K_DATE}. A person looks up the code. The 7501 instructions use the country's "All Other" code (55200) when the bill of lading names no port; a person decides whether it applies here.`,
    );
    expect(f.candidates).toEqual([{ value: "55200", label: "55200 All Other Viet Nam Ports (Vietnam)" }]);
    const none = header(draftOf([acc("billOfLading.portOfLoading", "Nowhere Bay")]), "B19");
    expect(none.reason).toBe(`The port of loading "Nowhere Bay" on the bill of lading is not in ${K_DATE}. A person looks up the code.`);
    expect(none.candidates ?? []).toEqual([]);
  });

  it("not read: waits", () => {
    const f = header(draftOf([]), "B19");
    expect([f.status, f.value, f.reason]).toEqual(["needsReview", null, "The port of loading was not read from the bill of lading. A person looks up the Schedule K code."]);
  });
});

describe("Requirement 47.7: B9", () => {
  const vessel = () => acc("billOfLading.vessel", "MV TEST STAR");
  const b9 = (bl: VerifiedReading[]) => header(draftOf(bl), "B9");
  const show = (f: DraftField) => [f.status, f.value, f.rule, f.note, f.reason];

  it("a container number gives 11 as before", () => {
    const f = b9([vessel(), acc("billOfLading.containerNo", "DEMU 2601173")]);
    expect(show(f)).toEqual(["computed", "11", "7501 p.8", "Vessel, containerized: the B/L lists a container.", null]);
    expect(docFields(f)).toEqual(["billOfLading.containerNo"]);
  });

  it("a vessel and no container number gives 10", () => {
    const f = b9([vessel()]);
    expect(show(f)).toEqual(["computed", "10", "7501 p.8", B9_TEN_NOTE, null]);
    expect(docFields(f)).toEqual(["billOfLading.vessel"]);
  });

  it("a container number rejected only because its value is missing also gives 10", () => {
    const missing: VerifiedReading = { field: "billOfLading.containerNo", value: null, quote: "", doc: "billOfLading", page: 1, status: "rejected", reason: "value_missing", message: "Value is missing or empty on billOfLading page 1." };
    expect(show(b9([vessel(), missing]))).toEqual(["computed", "10", "7501 p.8", B9_TEN_NOTE, null]);
  });

  it("a container number rejected for another reason, or not sure, waits as in Requirement 44.3", () => {
    const rejected: VerifiedReading = { field: "billOfLading.containerNo", value: "ABCU 0000000", quote: "Container No.: ABCU 0000000", doc: "billOfLading", page: 1, status: "rejected", reason: "quote_not_found", message: "x" };
    expect(show(b9([vessel(), rejected]))).toEqual(["needsReview", null, null, null, B9_WAIT]);
    const unsure: VerifiedReading = { field: "billOfLading.containerNo", value: "DEMU 2601173", quote: "DEMU 2601173", doc: "billOfLading", page: 1, confidence: "low", status: "uncertain", box: BOX, itemIds: ["billOfLading:p1:i999"], message: "x" };
    expect(show(b9([vessel(), unsure]))).toEqual(["needsReview", null, null, null, B9_WAIT]);
  });

  it("no vessel and no container number: waits", () => {
    expect(show(b9([]))).toEqual(["needsReview", null, null, null, B9_NO_VESSEL]);
  });
});

describe("Requirement 47.9: a code table source in the CSV", () => {
  it("formats Schedule D and Schedule K rows", () => {
    expect(formatSource({ kind: "codeTable", table: "Schedule D", edition: "2026-02-03", code: "1703", name: "Savannah, Georgia", country: null })).toBe(`Schedule D 2026-02-03 1703 "Savannah, Georgia"`);
    expect(formatSource({ kind: "codeTable", table: "Schedule K", edition: "2024-08-27, changes to 04/2026", code: "55201", name: "Haiphong; Hai Phong", country: "Vietnam" })).toBe(
      `Schedule K 2024-08-27, changes to 04/2026 55201 "Haiphong; Hai Phong, Vietnam"`,
    );
  });
});

describe("Property 65: a port code is filled only from one table row (Requirements 47.4, 47.5, 47.6)", () => {
  const dTexts = SCHEDULE_D.rows.filter((r) => r.name.split(",").length === 2).map((r) => r.name);
  const kTexts = SCHEDULE_K.rows.map((r) => `${r.name.split(";")[0].trim()}, ${r.country}`);
  const junk = fc.stringMatching(/^[A-Za-z ,]{0,20}$/);

  it("B20 and B19 are computed only for one code, with it as the value and the row as a source; several codes give one candidate each; B6 is never computed or copied", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...dTexts), junk), fc.oneof(fc.constantFrom(...kTexts), junk), (discharge, loading) => {
        const bl: VerifiedReading[] = [];
        if (discharge.trim()) bl.push(acc("billOfLading.portOfDischarge", discharge));
        if (loading.trim()) bl.push(acc("billOfLading.portOfLoading", loading));
        const d = draftOf(bl);
        const b20 = header(d, "B20");
        const b19 = header(d, "B19");
        const b6 = header(d, "B6");
        expect(["computed", "copied"]).not.toContain(b6.status);
        if (discharge.trim()) {
          const u = lookupUsPort(discharge);
          if (u.kind === "one") {
            expect([b20.status, b20.value]).toEqual(["computed", u.row.code]);
            expect(tableRows(b20).map((r) => r[2])).toEqual([u.row.code]);
            expect(docFields(b20)).toEqual(["billOfLading.portOfDischarge"]);
          } else {
            expect([b20.status, b20.value]).toEqual(["needsReview", null]);
            expect((b20.candidates ?? []).map((c) => c.value)).toEqual(u.kind === "several" ? u.rows.map((r) => r.code) : []);
          }
        }
        if (loading.trim()) {
          const k = lookupForeignPort(loading);
          if (k.kind === "one") {
            expect([b19.status, b19.value]).toEqual(["computed", k.rows[0].code]);
            expect(new Set(tableRows(b19).map((r) => r[2]))).toEqual(new Set([k.rows[0].code]));
          } else {
            expect([b19.status, b19.value]).toEqual(["needsReview", null]);
            if (k.kind === "several") expect((b19.candidates ?? []).map((c) => c.value)).toEqual([...new Set(k.rows.map((r) => r.code))]);
          }
        }
      }),
      { numRuns: 150 },
    );
  });
});
