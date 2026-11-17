import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveReaderSetup } from "./index";

const optional = (values: string[]) => fc.option(fc.constantFrom(...values), { nil: undefined });
const envArb = fc.record({
  DOCUMENT_INTAKE_KILL_SWITCH: optional(["", "  ", "1"]),
  DOCUMENT_INTAKE_MODE: optional(["fake", "claude", "x", ""]),
  DOCUMENT_INTAKE_STORE: optional(["file", "blobs", ""]),
  ANTHROPIC_API_KEY: optional(["", "test-key-not-real"]),
  DOCUMENT_INTAKE_TOTAL_CAP: optional(["5", "abc", ""]),
  DOCUMENT_INTAKE_DAILY_CAP: optional(["0", "7", "x1"]),
  DOCUMENT_INTAKE_VISITOR_DAILY_CAP: optional(["3", "-1"]),
});

type Env = Record<string, string | undefined>;
const isSet = (v: string | undefined) => v !== undefined && v.trim() !== "";
const capsValid = (e: Env) =>
  ["DOCUMENT_INTAKE_TOTAL_CAP", "DOCUMENT_INTAKE_DAILY_CAP", "DOCUMENT_INTAKE_VISITOR_DAILY_CAP"].every(
    (k) => !isSet(e[k]) || /^\d{1,6}$/.test(e[k]!.trim()),
  );

describe("Feature: document-intake, Property 13: Resolver Mode Respects Kill Switch (Validates: Requirements 7.1, 7.3)", () => {
  it("kill switch set => mode off and apiKey null", () => {
    fc.assert(
      fc.property(envArb, (env) => {
        const s = resolveReaderSetup(env);
        if (isSet(env.DOCUMENT_INTAKE_KILL_SWITCH)) {
          expect(s.mode).toBe("off");
          expect(s.reason).toBe("kill switch is on");
          expect(s.apiKey).toBeNull();
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("Feature: document-intake, Property 14: Resolver Mode Fake Needs No Key (Validates: Requirements 7.1)", () => {
  it("mode is fake exactly when: no kill switch, valid caps, DOCUMENT_INTAKE_MODE is fake; apiKey is null", () => {
    fc.assert(
      fc.property(envArb, (env) => {
        const s = resolveReaderSetup(env);
        const shouldBeFake = !isSet(env.DOCUMENT_INTAKE_KILL_SWITCH) && capsValid(env) && env.DOCUMENT_INTAKE_MODE?.trim() === "fake";
        expect((s.mode === "fake") === shouldBeFake).toBe(true);
        if (s.mode === "fake") {
          expect(s.apiKey).toBeNull();
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("Feature: document-intake, Property 15: Resolver Mode Claude Needs Key and Store (Validates: Requirements 7.1, 7.2)", () => {
  it("mode is claude only when: key set, store file, no kill switch, valid caps, mode not fake; apiKey is non-null only in that case", () => {
    fc.assert(
      fc.property(envArb, (env) => {
        const s = resolveReaderSetup(env);
        const shouldBeClaude =
          !isSet(env.DOCUMENT_INTAKE_KILL_SWITCH) &&
          capsValid(env) &&
          env.DOCUMENT_INTAKE_MODE?.trim() !== "fake" &&
          isSet(env.ANTHROPIC_API_KEY) &&
          env.DOCUMENT_INTAKE_STORE?.trim() === "file";
        expect((s.mode === "claude") === shouldBeClaude).toBe(true);
        expect((s.apiKey !== null) === (s.mode === "claude")).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("Feature: document-intake, Property 16: Resolver Provides Reason When Off (Validates: Requirements 7.4)", () => {
  it("mode off <=> reason is a non-empty string", () => {
    fc.assert(
      fc.property(envArb, (env) => {
        const s = resolveReaderSetup(env);
        expect((s.mode === "off") === (typeof s.reason === "string" && s.reason.length > 0)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
