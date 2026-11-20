import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveReaderSetup } from "./index";
import { intakeConfig } from "../core/intakeConfig";

const optional = (values: string[]) => fc.option(fc.constantFrom(...values), { nil: undefined });
const envArb = fc.record({
  DOCUMENT_INTAKE_KILL_SWITCH: optional(["", "  ", "1"]),
  DOCUMENT_INTAKE_MODE: optional(["fake", "claude", "x", ""]),
  DOCUMENT_INTAKE_STORE: optional(["file", "netlify-blobs", "blobs", ""]),
  DOCUMENT_INTAKE_ANTHROPIC_KEY: optional(["", "test-key-not-real"]),
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
  it("store file or netlify-blobs: mode is claude only when: key set, store file or netlify-blobs, no kill switch, valid caps, mode not fake; apiKey is non-null only in that case", () => {
    fc.assert(
      fc.property(envArb, (env) => {
        const s = resolveReaderSetup(env);
        const storeTrimmed = env.DOCUMENT_INTAKE_STORE?.trim();
        const shouldBeClaude =
          !isSet(env.DOCUMENT_INTAKE_KILL_SWITCH) &&
          capsValid(env) &&
          env.DOCUMENT_INTAKE_MODE?.trim() !== "fake" &&
          isSet(env.DOCUMENT_INTAKE_ANTHROPIC_KEY) &&
          (storeTrimmed === "file" || storeTrimmed === "netlify-blobs");
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

describe("Feature: document-intake, Property 30: Public Site Caps Default (Validates: Requirements 11.1)", () => {
  it("when cap variable not set, use publicSite for netlify-blobs store and local for file store; when set, use parsed number", () => {
    fc.assert(
      fc.property(envArb, (env) => {
        const s = resolveReaderSetup(env);

        // Only check when mode is claude (has both key and store)
        if (s.mode === "claude") {
          if (env.DOCUMENT_INTAKE_STORE?.trim() === "netlify-blobs") {
            if (!isSet(env.DOCUMENT_INTAKE_TOTAL_CAP)) {
              expect(s.caps.total).toBe(intakeConfig.caps.publicSite.total);
            }
            if (!isSet(env.DOCUMENT_INTAKE_DAILY_CAP)) {
              expect(s.caps.daily).toBe(intakeConfig.caps.publicSite.daily);
            }
            if (!isSet(env.DOCUMENT_INTAKE_VISITOR_DAILY_CAP)) {
              expect(s.caps.perVisitorDaily).toBe(intakeConfig.caps.publicSite.perVisitorDaily);
            }
          } else if (env.DOCUMENT_INTAKE_STORE?.trim() === "file") {
            if (!isSet(env.DOCUMENT_INTAKE_TOTAL_CAP)) {
              expect(s.caps.total).toBe(intakeConfig.caps.local.total);
            }
            if (!isSet(env.DOCUMENT_INTAKE_DAILY_CAP)) {
              expect(s.caps.daily).toBe(intakeConfig.caps.local.daily);
            }
            if (!isSet(env.DOCUMENT_INTAKE_VISITOR_DAILY_CAP)) {
              expect(s.caps.perVisitorDaily).toBe(intakeConfig.caps.local.perVisitorDaily);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("Feature: document-intake, Property 42: Platform Variables Cannot Turn the Reader On (Validates: Requirements 25.1)", () => {
  it("property: ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL never affect the result", () => {
    fc.assert(
      fc.property(
        envArb,
        fc.record({
          ANTHROPIC_API_KEY: fc.option(fc.constantFrom("platform-gateway-key", ""), { nil: undefined }),
          ANTHROPIC_BASE_URL: fc.option(fc.constantFrom("https://gateway.invalid/anthropic", ""), { nil: undefined }),
        }),
        (env, extra) => {
          const withoutExtra = resolveReaderSetup(env);
          const withExtra = resolveReaderSetup({ ...env, ...extra });

          expect(withExtra.mode).toBe(withoutExtra.mode);
          expect(withExtra.reason).toBe(withoutExtra.reason);
          expect(withExtra.apiKey).toBe(withoutExtra.apiKey);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("example: ANTHROPIC_API_KEY with no DOCUMENT_INTAKE_ANTHROPIC_KEY gives mode off", () => {
    const result = resolveReaderSetup({
      ANTHROPIC_API_KEY: "platform-gateway-key",
      DOCUMENT_INTAKE_STORE: "netlify-blobs",
    });
    expect(result.mode).toBe("off");
    expect(result.reason).toBe("no API key");
    expect(result.apiKey).toBeNull();
  });

  it("example: both ANTHROPIC_* and DOCUMENT_INTAKE_ANTHROPIC_KEY set, DOCUMENT_INTAKE_ANTHROPIC_KEY wins", () => {
    const result = resolveReaderSetup({
      ANTHROPIC_API_KEY: "platform-gateway-key",
      ANTHROPIC_BASE_URL: "https://gateway.invalid/anthropic",
      DOCUMENT_INTAKE_ANTHROPIC_KEY: "test-key-not-real",
      DOCUMENT_INTAKE_STORE: "netlify-blobs",
    });
    expect(result.mode).toBe("claude");
    expect(result.apiKey).toBe("test-key-not-real");
  });
});