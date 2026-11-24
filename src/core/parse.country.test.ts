import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { countryCode, parseDocumentDate, parseUsDate, findPrintedDates } from "./parse";

// Feature: document-intake, Requirement 52.1 and 52.2 (task 65.1): every ISO 3166-1 code and its names, and the printed date forms.

type Row = { code: string; names: string[] };
const table = JSON.parse(readFileSync(join(process.cwd(), "data", "codes", "iso-3166-1.json"), "utf8")) as { countries: Row[] };
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

describe("Feature: document-intake, Requirement 52.1: the ISO 3166-1 table", () => {
  it("has the 249 officially assigned codes, each once, each two capital letters, each with at least one name", () => {
    const codes = table.countries.map((r) => r.code);
    expect(codes.length).toBe(249);
    expect(new Set(codes).size).toBe(249);
    for (const r of table.countries) {
      expect(r.code).toMatch(/^[A-Z]{2}$/);
      expect(r.names.length).toBeGreaterThan(0);
    }
  });

  it("no name belongs to two codes, and no name is another row's code", () => {
    const owner = new Map<string, string>();
    const codes = new Set(table.countries.map((r) => r.code));
    for (const r of table.countries) {
      for (const n of r.names) {
        const k = norm(n);
        expect([n, owner.get(k) ?? r.code]).toEqual([n, r.code]);
        owner.set(k, r.code);
        if (codes.has(k)) expect([n, k]).toEqual([n, r.code]);
      }
    }
  });
});

describe("Feature: document-intake, Requirement 52.1: countryCode", () => {
  it("knows the names of the recorded real reads and the old table", () => {
    const cases: [string, string][] = [
      ["Germany", "DE"],
      ["GERMANY", "DE"],
      ["germany", "DE"],
      ["DE", "DE"],
      ["de", "DE"],
      ["Viet Nam", "VN"],
      ["Vietnam", "VN"],
      ["VIETNAM", "VN"],
      ["Portugal", "PT"],
      ["Czechia", "CZ"],
      ["Czech Republic", "CZ"],
      ["China", "CN"],
      ["USA", "US"],
      ["United States", "US"],
      ["  United   States ", "US"],
      ["United Kingdom", "GB"],
      ["Hong Kong", "HK"],
      ["Taiwan", "TW"],
      ["South Korea", "KR"],
      ["Mexico", "MX"],
      ["Canada", "CA"],
      ["India", "IN"],
      ["Italy", "IT"],
      ["Japan", "JP"],
      ["Thailand", "TH"],
      ["Türkiye", "TR"],
      ["Turkey", "TR"],
    ];
    for (const [text, code] of cases) expect([text, countryCode(text)]).toEqual([text, { ok: true, value: code }]);
  });

  it("refuses what is not in the table as today", () => {
    for (const text of ["Atlantis", "XX", "UK X", "Europe"]) {
      expect(countryCode(text)).toEqual({ ok: false, reason: `Unknown country: "${text}"` });
    }
    expect(countryCode("")).toEqual({ ok: false, reason: "Country text is empty" });
  });
});

describe("Feature: document-intake, Property 71: Every ISO Code and Name Gives Its Code (Validates: Requirement 52.1)", () => {
  const casing = (s: string, flips: boolean[]) =>
    s
      .split("")
      .map((ch, i) => (flips[i % flips.length] ? ch.toLowerCase() : ch.toUpperCase()))
      .join("");
  it("for any row and any of its names or its code, in any letter case and with extra spaces, countryCode gives the code", () => {
    const rowArb = fc.constantFrom(...table.countries);
    fc.assert(
      fc.property(
        rowArb.chain((r) => fc.tuple(fc.constant(r), fc.constantFrom(r.code, ...r.names))),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        fc.constantFrom("", " ", "  "),
        ([row, text], flips, pad) => {
          const spaced = pad + casing(text, flips).replace(/ /g, pad === "" ? " " : "  ") + pad;
          expect(countryCode(spaced)).toEqual({ ok: true, value: row.code });
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("Feature: document-intake, Requirement 52.2: parseDocumentDate", () => {
  it("a value parseUsDate accepts gives what it gives today", () => {
    for (const v of ["10/28/2026", "1/2/2026", "02/28/2027"]) expect(parseDocumentDate(v)).toEqual(parseUsDate(v));
  });

  it("the printed forms of Requirement 35.1 give MM/DD/YYYY when the whole value is one date", () => {
    const cases: [string, string][] = [
      ["12-NOV-2026", "11/12/2026"],
      ["12 Nov 2026", "11/12/2026"],
      ["03-Nov-2026", "11/03/2026"],
      ["Nov 12, 2026", "11/12/2026"],
      ["Nov 12 2026", "11/12/2026"],
      ["November 12, 2026", "11/12/2026"],
      ["2026-11-12", "11/12/2026"],
      ["12.11.2026", "11/12/2026"],
      ["  12-NOV-2026 ", "11/12/2026"],
    ];
    for (const [text, us] of cases) expect([text, parseDocumentDate(text)]).toEqual([text, { ok: true, value: us }]);
  });

  it("other forms, dates that do not exist and text around a date are refused with the reason of parseUsDate", () => {
    for (const text of ["12/11/26", "31-FEB-2026", "Shipped 12-NOV-2026", "12-NOV-2026 / 13-NOV-2026", "2026/11/12", "13.13.2026"]) {
      const r = parseDocumentDate(text);
      expect([text, r]).toEqual([text, parseUsDate(text)]);
      expect(r.ok).toBe(false);
    }
  });

  it("one function reads the printed forms for the quote check and the draft", () => {
    expect(findPrintedDates("Date: Nov 06, 2026").map((d) => [d.month, d.day, d.year])).toEqual([[11, 6, 2026]]);
    const readingSource = readFileSync(join(process.cwd(), "src", "core", "reading.ts"), "utf8");
    expect(readingSource).not.toContain("function findPrintedDates");
  });
});
