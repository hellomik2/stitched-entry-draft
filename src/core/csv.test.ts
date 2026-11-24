import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { runBundleFromDisk } from "../node/index";
import * as fc from "fast-check";
import { draftToCsv, parseCsv } from "./csv";
import type { Draft } from "./draft";

describe("CSV output verification", () => {
  describe("Feature: document-intake, CSV output SHA-256 (Validates: Requirements 4.5)", () => {
    it("should produce stable CSV output for lantern-hollow bundle without overrides", async () => {
      const { csv } = await runBundleFromDisk(process.cwd(), "lantern-hollow", []);

      // Compute SHA-256 of the CSV as UTF-8
      const hash = createHash("sha256").update(csv, "utf8").digest("hex");

      // Expected hash: the CSV is stable and should not change
      // This hash will be verified by the maintainer's test run
      expect(hash).toBe("4276d1db29164275a6221adbfc284ba8c240ae1b75adea5ce1388c730a16f803");
    });

    it("should produce stable CSV output for lantern-hollow bundle with demo overrides", async () => {
      // Read the demo overrides
      const { overrides } = await import("../../samples/lantern-hollow/overrides-demo.json");

      const { csv } = await runBundleFromDisk(process.cwd(), "lantern-hollow", overrides);

      // Compute SHA-256 of the CSV as UTF-8
      const hash = createHash("sha256").update(csv, "utf8").digest("hex");

      // Expected hash: the CSV with demo overrides is stable and should not change
      expect(hash).toBe("3312056aa79544807eeea352444ec1105bfe59e39dfe2ae8885ba75243c674a3");
    });
  });
});
describe("Feature: document-intake, Property 45 and Property 59: A Plain Number Keeps Its Sign and No Other Cell Starts a Formula (Validates: Requirements 28.2, 44.1, 44.2)", () => {
  // The value goes into Block 8 of the sample draft and is read back from the real draftToCsv output (Requirement 44.2).
  const sample = runBundleFromDisk(process.cwd(), "lantern-hollow", []).then((r) => r.draft);
  const cellOf = (d: Draft, value: string): string => {
    const copy = structuredClone(d);
    const b8 = copy.header.find((f) => f.id === "B8");
    if (!b8) throw new Error("sample draft has no B8");
    b8.value = value;
    const rows = parseCsv(draftToCsv(copy));
    const row = rows.find((r) => r[0] === "B8");
    if (!row) throw new Error("CSV has no B8 row");
    return row[rows[0].indexOf("value")];
  };
  const isPlainNumber = (v: string) => /^[+-]?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/.test(v);
  const startsFormula = (v: string) => /^[=+\-@\t\r]/.test(v);

  it("44.1 a plain number keeps its sign and gets no quote", async () => {
    const d = await sample;
    for (const v of ["-12", "+5", "-1,234.50", "-0.5", "+1", "-1", "12"]) expect(cellOf(d, v)).toBe(v);
  });

  it("28.2, 44.1 every other cell that starts with a formula character gets the leading quote", async () => {
    const d = await sample;
    for (const v of ["+5V adapter", '=HYPERLINK("http://example.invalid","x")', "@SUM(A1)", "\tx", "\rx", "-1+2", "+", "-", "--1", "-1,23", "-.5"]) expect(cellOf(d, v)).toBe("'" + v);
  });

  it("text that does not start with a formula character is unchanged", async () => {
    const d = await sample;
    for (const v of ["ABC", "5V adapter", "Party decorations, see invoice"]) expect(cellOf(d, v)).toBe(v);
  });

  it("Property 59: for any string or signed number, the CSV cell is the string, or a quote and the string when it would start a formula", async () => {
    const d = await sample;
    const signed = fc.tuple(fc.constantFrom("+", "-", ""), fc.nat(), fc.option(fc.nat(), { nil: null })).map(([s, a, b]) => `${s}${a}${b === null ? "" : "." + b}`);
    fc.assert(
      fc.property(fc.oneof(fc.string(), signed), (v) => {
        expect(cellOf(d, v)).toBe(startsFormula(v) && !isPlainNumber(v) ? "'" + v : v);
      }),
      { numRuns: 200 },
    );
  });
});
