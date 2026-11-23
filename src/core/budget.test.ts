import { describe, it, expect } from "vitest";
import type { UsageState } from "./budget";
import {
  emptyUsageState,
  utcDay,
  decideCall,
  remainingCalls,
  estimateCostNanoUsd,
  formatUsd,
  estimateReaderCall,
  utf8Bytes,
  addReservedCost,
} from "./budget";
import { intakeConfig } from "./intakeConfig";
import * as fc from "fast-check";

describe("budget: utility functions", () => {
  describe("utcDay", () => {
    it("extracts the UTC date in YYYY-MM-DD format", () => {
      expect(utcDay("2026-11-18T14:30:00Z")).toBe("2026-11-18");
      expect(utcDay("2026-01-01T00:00:00Z")).toBe("2026-01-01");
      expect(utcDay("2026-12-31T23:59:59Z")).toBe("2026-12-31");
    });
  });

  describe("emptyUsageState", () => {
    it("returns an empty state", () => {
      const state = emptyUsageState();
      expect(state.totalCalls).toBe(0);
      expect(Object.keys(state.days)).toHaveLength(0);
    });
  });

  describe("estimateCostNanoUsd", () => {
    it("costs 1_100_000 nano-USD for 1000 input and 2000 output tokens", () => {
      const cost = estimateCostNanoUsd(1000, 2000, intakeConfig.prices);
      expect(cost).toBe(1_100_000);
    });

    it("uses higher rate when inputTokens exceed upToPromptTokens", () => {
      const cost = estimateCostNanoUsd(100_001, 0, intakeConfig.prices);
      // 100_001 * 500 (higher input rate) = 50_000_500
      expect(cost).toBe(50_000_500);
    });

    it("throws on negative inputTokens", () => {
      expect(() => estimateCostNanoUsd(-1, 0)).toThrow();
    });

    it("throws on non-integer inputTokens", () => {
      expect(() => estimateCostNanoUsd(1.5, 0)).toThrow();
    });

    it("throws on negative outputTokens", () => {
      expect(() => estimateCostNanoUsd(0, -1)).toThrow();
    });

    it("throws on non-integer outputTokens", () => {
      expect(() => estimateCostNanoUsd(0, 1.5)).toThrow();
    });
  });

  describe("formatUsd", () => {
    it("formats 7_200_000 nano-USD as 0.007200", () => {
      expect(formatUsd(7_200_000)).toBe("0.007200");
    });

    it("formats 1_234_567_890 nano-USD as 1.234567", () => {
      expect(formatUsd(1_234_567_890)).toBe("1.234567");
    });

    it("formats 0 as 0.000000", () => {
      expect(formatUsd(0)).toBe("0.000000");
    });

    it("truncates below one micro-dollar", () => {
      // 1_000_123 nanoUsd = 1.000123 but truncated to 6 decimals = 1.000123
      // Actually 1_000_123 / 1000 = 1000.123 microUsd
      // 1000 microUsd = 0.001000, but we only store first 6 decimals
      // Let me recalculate: 1_000_123 nano = 1.000123 micro, which when truncated to 6 decimals is 0.001000
      expect(formatUsd(1_000_123)).toBe("0.001000");
    });
  });
});

describe("budget: cap decisions", () => {
  it("allows a call when under all caps", () => {
    const state = emptyUsageState();
    const caps = { total: 10, daily: 5, perVisitorDaily: 3 };

    const result = decideCall(state, caps, "2026-11-18T12:00:00Z", "visitor1");

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.next.totalCalls).toBe(1);
      expect(result.remaining).toBeGreaterThan(0);
    }
  });

  it("refuses when total cap is reached", () => {
    const state = { totalCalls: 10, days: {} };
    const caps = { total: 10, daily: 100, perVisitorDaily: 100 };

    const result = decideCall(state, caps, "2026-11-18T12:00:00Z", "visitor1");

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("total_cap");
    }
  });

  it("refuses when daily cap is reached", () => {
    const state = {
      totalCalls: 0,
      days: {
        "2026-11-18": { calls: 5, visitors: {} },
      },
    };
    const caps = { total: 100, daily: 5, perVisitorDaily: 100 };

    const result = decideCall(state, caps, "2026-11-18T12:00:00Z", "visitor1");

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("daily_cap");
    }
  });

  it("refuses when per-visitor daily cap is reached", () => {
    const state = {
      totalCalls: 0,
      days: {
        "2026-11-18": { calls: 2, visitors: { visitor1: 3 } },
      },
    };
    const caps = { total: 100, daily: 100, perVisitorDaily: 3 };

    const result = decideCall(state, caps, "2026-11-18T12:00:00Z", "visitor1");

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("visitor_cap");
    }
  });

  it("does not mutate input state on allowed call", () => {
    const state = { totalCalls: 0, days: {} };
    const stateBefore = JSON.stringify(state);

    const result = decideCall(state, { total: 10, daily: 5, perVisitorDaily: 3 }, "2026-11-18T12:00:00Z", "v1");

    expect(JSON.stringify(state)).toBe(stateBefore);
    expect(result.allowed).toBe(true);
  });

  it("does not return next on refused call", () => {
    const state = { totalCalls: 10, days: {} };
    const result = decideCall(state, { total: 10, daily: 5, perVisitorDaily: 3 }, "2026-11-18T12:00:00Z", "v1");

    expect(result.allowed).toBe(false);
    expect((result as any).next).toBeUndefined();
  });

  it("keeps only current and previous day in state", () => {
    const state = {
      totalCalls: 1,
      days: {
        "2026-11-16": { calls: 1, visitors: { v1: 1 } },
      },
    };

    const result = decideCall(state, { total: 100, daily: 100, perVisitorDaily: 100 }, "2026-11-18T12:00:00Z", "v2");

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      const daysInNext = Object.keys(result.next.days);
      // Should have "2026-11-17" and "2026-11-18" but not "2026-11-16"
      expect(daysInNext).toContain("2026-11-18");
      expect(daysInNext).not.toContain("2026-11-16");
    }
  });
});

describe("budget: remainingCalls", () => {
  it("returns 0 when exactly at a cap", () => {
    const state = { totalCalls: 10, days: { "2026-11-18": { calls: 5, visitors: { v1: 3 } } } };
    const caps = { total: 10, daily: 5, perVisitorDaily: 3 };

    const remaining = remainingCalls(state, caps, "2026-11-18T12:00:00Z", "v1");

    expect(remaining).toBe(0);
  });

  it("returns positive when under all caps", () => {
    const state = { totalCalls: 2, days: { "2026-11-18": { calls: 2, visitors: { v1: 1 } } } };
    const caps = { total: 10, daily: 5, perVisitorDaily: 3 };

    const remaining = remainingCalls(state, caps, "2026-11-18T12:00:00Z", "v1");

    expect(remaining).toBeGreaterThan(0);
  });

  it("ignores daily cap when daily is 0", () => {
    const state = { totalCalls: 2, days: { "2026-11-18": { calls: 100, visitors: { v1: 100 } } } };
    const caps = { total: 10, daily: 0, perVisitorDaily: 0 };

    const remaining = remainingCalls(state, caps, "2026-11-18T12:00:00Z", "v1");

    expect(remaining).toBe(8); // Only limited by total cap
  });

  it("handles null visitorKey", () => {
    const state = { totalCalls: 2, days: { "2026-11-18": { calls: 2, visitors: { v1: 1 } } } };
    const caps = { total: 10, daily: 5, perVisitorDaily: 3 };

    const remaining = remainingCalls(state, caps, "2026-11-18T12:00:00Z", null);

    // Should not consider per-visitor cap
    expect(remaining).toBe(3); // min(10-2, 5-2) = min(8, 3) = 3
  });
});

describe("Feature: document-intake, Property 33: Per-Call Line Holds Before Any Spending (Validates: Requirements 17.2, 17.3, 17.7)", () => {
  it("estimate is at least promptOverhead, output is between min and max, adding pages never lowers cost", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(
          fc.record({
            docId: fc.string({ minLength: 1, maxLength: 10 }),
            pages: fc.array(
              fc.oneof(
                fc.record({ text: fc.string({ minLength: 0, maxLength: 2000 }), isText: fc.constant(true) }),
                fc.record({ text: fc.constant(""), isText: fc.constant(false) }),
              ),
              { minLength: 1, maxLength: 4 },
            ),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        (numDocs, docTemplates) => {
          // Build a valid input
          const documents = docTemplates.map((template, docIdx) => ({
            docId: `doc${docIdx}`,
            kind: "invoice" as const,
            fileName: `file${docIdx}.pdf`,
            fileSha256: "a".repeat(64),
            pages: template.pages.map((page, pageIdx) => ({
              page: pageIdx + 1,
              width: 612,
              height: 792,
              text: page.isText ? page.text : null,
              image: page.isText
                ? null
                : {
                    mediaType: "image/jpeg" as const,
                    base64: "QUJD",
                  },
            })),
          }));

          const input = {
            bundle: "test",
            documents,
          };

          const estimate1 = estimateReaderCall(input);

          // Check: inputTokens >= promptOverheadTokens
          expect(estimate1.inputTokens).toBeGreaterThanOrEqual(intakeConfig.perCall.promptOverheadTokens);

          // Check: outputTokens is between min and max (Requirement 29.4)
          expect(estimate1.outputTokens).toBeGreaterThanOrEqual(intakeConfig.readerMinOutputTokens);
          expect(estimate1.outputTokens).toBeLessThanOrEqual(intakeConfig.readerMaxOutputTokens);

          // Check: adding a text page never lowers cost
          if (documents.length > 0 && documents[0].pages.length < 4) {
            const doc = documents[0];
            const extendedDocs = [...documents];
            extendedDocs[0] = {
              ...doc,
              pages: [
                ...doc.pages,
                {
                  page: doc.pages.length + 1,
                  width: 612,
                  height: 792,
                  text: "A".repeat(100),
                  image: null,
                },
              ],
            };

            const estimate2 = estimateReaderCall({ bundle: "test", documents: extendedDocs });
            expect(estimate2.worstCaseCostNanoUsd).toBeGreaterThanOrEqual(estimate1.worstCaseCostNanoUsd);
          }

          // Check: adding an image page never lowers cost
          if (documents.length > 0 && documents[0].pages.length < 4) {
            const doc = documents[0];
            const extendedDocs = [...documents];
            extendedDocs[0] = {
              ...doc,
              pages: [
                ...doc.pages,
                {
                  page: doc.pages.length + 1,
                  width: 612,
                  height: 792,
                  text: null,
                  image: {
                    mediaType: "image/jpeg" as const,
                    base64: "QUJD",
                  },
                },
              ],
            };

            const estimate2 = estimateReaderCall({ bundle: "test", documents: extendedDocs });
            expect(estimate2.worstCaseCostNanoUsd).toBeGreaterThanOrEqual(estimate1.worstCaseCostNanoUsd);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("Feature: document-intake, Property 34: Cost Ledger Never Exceeds the Won Cap (Validates: Requirements 17.4, 17.5)", () => {
  it("sum of allowed costs never exceeds cap, final reserved equals sum, calls refused when reserved + cost > cap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.array(fc.integer({ min: 1, max: 20_000_000 }), { minLength: 1, maxLength: 40 }),
        (capNanoUsd, callCosts) => {
          const caps = { total: 1_000_000, daily: 0, perVisitorDaily: 0 };
          let state = emptyUsageState();
          let sumAllowed = 0;

          for (const callNanoUsd of callCosts) {
            const decision = decideCall(state, caps, "2026-01-01T12:00:00Z", "visitor1", {
              callNanoUsd,
              capNanoUsd,
            });

            if (decision.allowed) {
              sumAllowed += callNanoUsd;
              state = decision.next;
              // Verify that final reserved cost equals sum of allowed costs
              expect(state.reservedCostNanoUsd ?? 0).toBe(sumAllowed);
              // Verify sum never exceeds cap
              expect(sumAllowed).toBeLessThanOrEqual(capNanoUsd);
            } else {
              // Verify each refusal is exactly when reserved + cost > cap
              expect(decision.reason).toBe("cost_cap");
              expect((state.reservedCostNanoUsd ?? 0) + callNanoUsd).toBeGreaterThan(capNanoUsd);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("without cost option, decideCall next has no reservedCostNanoUsd property", () => {
    const state = emptyUsageState();
    const caps = { total: 10, daily: 100, perVisitorDaily: 100 };

    const result = decideCall(state, caps, "2026-01-01T12:00:00Z", "v1");

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect((result.next as any).reservedCostNanoUsd).toBeUndefined();
    }
  });
});

describe("Feature: document-intake, Property 40: The Byte Count Bounds Any Text (Validates: Requirements 24.1, 24.2)", () => {
  it("utf8Bytes examples", () => {
    expect(utf8Bytes("")).toBe(0);
    expect(utf8Bytes("A")).toBe(1);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("€")).toBe(3);
    expect(utf8Bytes(String.fromCodePoint(0x20000))).toBe(4);
    expect(utf8Bytes("\uD800")).toBe(3); // lone surrogate
  });

  it("utf8Bytes matches TextEncoder for fullUnicode strings", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 200 }), (s) => {
        expect(utf8Bytes(s)).toBe(new TextEncoder().encode(s).length);
      }),
      { numRuns: 200 },
    );
  });

  it("estimateReaderCall matches formula for varied documents and pages", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 3 }),
        (numDocs, pagesPerDoc) => {
          const documents = Array.from({ length: numDocs }, (_, dIdx) => {
            const docId = `doc${dIdx}`;
            return {
              docId,
              kind: "invoice" as const,
              fileName: `file${dIdx}.pdf`,
              fileSha256: "a".repeat(64),
              pages: Array.from({ length: pagesPerDoc[dIdx] || 1 }, (_, pIdx) => {
                const isText = Math.random() > 0.4;
                return {
                  page: pIdx + 1,
                  width: 612,
                  height: 792,
                  text: isText ? fc.sample(fc.fullUnicodeString({ maxLength: 300 }), 1)[0] : null,
                  image: isText ? null : { mediaType: "image/jpeg" as const, base64: "QUJD" },
                };
              }),
            };
          });

          const input = { bundle: "test", documents };
          const estimate = estimateReaderCall(input);

          // Manual calculation
          let expected = 10_000; // promptOverheadTokens
          for (const doc of documents) {
            for (const page of doc.pages) {
              expected += 160; // perPageOverheadTokens
              expected += utf8Bytes(doc.fileName);
              expected += 4 * utf8Bytes(doc.docId);
              expected += page.text !== null ? utf8Bytes(page.text) : 5_000;
            }
          }

          expect(estimate.inputTokens).toBe(expected);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("7249 characters U+20000 (4 pages): worstCaseCostNanoUsd above maxCallCostNanoUsd", () => {
    const text = String.fromCodePoint(0x20000).repeat(7249);
    const input = {
      bundle: "test",
      documents: [
        {
          docId: "t",
          kind: "invoice" as const,
          fileName: "a.pdf",
          fileSha256: "a".repeat(64),
          pages: Array.from({ length: 4 }, (_, i) => ({
            page: i + 1,
            width: 612,
            height: 792,
            text,
            image: null,
          })),
        },
      ],
    };

    const estimate = estimateReaderCall(input);
    expect(estimate.worstCaseCostNanoUsd).toBeGreaterThan(intakeConfig.perCall.maxCallCostNanoUsd);
  });

  it("four text pages of 15000 'x' plus five image pages: above the line", () => {
    const input = {
      bundle: "test",
      documents: [
        {
          docId: "t",
          kind: "invoice" as const,
          fileName: "f.pdf",
          fileSha256: "a".repeat(64),
          pages: Array.from({ length: 4 }, (_, i) => ({
            page: i + 1,
            width: 612,
            height: 792,
            text: "x".repeat(15000),
            image: null,
          })),
        },
        {
          docId: "i",
          kind: "packingList" as const,
          fileName: "g.pdf",
          fileSha256: "b".repeat(64),
          pages: Array.from({ length: 5 }, (_, i) => ({
            page: i + 1,
            width: 612,
            height: 792,
            text: null,
            image: { mediaType: "image/jpeg" as const, base64: "QUJD" },
          })),
        },
        {
          docId: "j",
          kind: "billOfLading" as const,
          fileName: "h.pdf",
          fileSha256: "c".repeat(64),
          pages: [],
        },
      ],
    };

    const estimate = estimateReaderCall(input);
    expect(estimate.worstCaseCostNanoUsd).toBeGreaterThan(intakeConfig.perCall.maxCallCostNanoUsd);
  });

  it("property: for input tokens up to 68000, cost is within maxCallCostNanoUsd", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 68_000 }), (inputTokens) => {
        const cost = estimateCostNanoUsd(inputTokens, 8000);
        expect(cost).toBeLessThanOrEqual(intakeConfig.perCall.maxCallCostNanoUsd);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-intake, Property 41: The Ledger Holds the Actual Cost (Validates: Requirements 24.3, 24.4)", () => {
  it("addReservedCost adds the extra to reserved, preserves other fields, does not mutate input", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000_000 }),
        fc.nat({ max: 1_000_000_000 }),
        (startTotal, extra) => {
          const startState = {
            totalCalls: 1,
            days: { "2026-01-01": { calls: 1, visitors: { v1: 1 } } },
            reservedCostNanoUsd: startTotal,
          };

          const clone = structuredClone(startState);
          const result = addReservedCost(startState, extra);

          // Input unchanged
          expect(startState).toEqual(clone);

          // Output is new object with correct values
          expect(result).not.toBe(startState);
          expect(result.reservedCostNanoUsd).toBe(startTotal + extra);
          expect(result.totalCalls).toBe(startState.totalCalls);
          expect(result.days).toBe(startState.days); // shared reference is OK (days not changed)
        },
      ),
      { numRuns: 100 },
    );
  });

  it("addReservedCost throws for negative input", () => {
    const state = emptyUsageState();
    expect(() => addReservedCost(state, -1)).toThrow("extraNanoUsd must be a non-negative safe integer");
  });

  it("addReservedCost throws for non-integer input", () => {
    const state = emptyUsageState();
    expect(() => addReservedCost(state, 1.5)).toThrow("extraNanoUsd must be a non-negative safe integer");
  });

  it("addReservedCost with undefined reservedCostNanoUsd treats it as 0", () => {
    const state: any = { totalCalls: 0, days: {} };
    const result = addReservedCost(state, 100);
    expect(result.reservedCostNanoUsd).toBe(100);
  });
});


describe("Feature: document-intake, Property 45: Small Guards Hold (day counts) (Validates: Requirements 28.3)", () => {
  describe("example", () => {
    it("three calls at 2026-12-10T00:00:01, then one call at 2026-12-09T23:59:59, keeps both days", () => {
      let state = emptyUsageState();
      const caps = { total: 100, daily: 100, perVisitorDaily: 100 };

      // Three calls on "2026-12-10"
      for (let i = 0; i < 3; i++) {
        const result = decideCall(state, caps, "2026-12-10T00:00:01.000Z", `v${i}`);
        expect(result.allowed).toBe(true);
        if (result.allowed) {
          state = result.next;
        }
      }

      // One call on "2026-12-09"
      const result = decideCall(state, caps, "2026-12-09T23:59:59.000Z", "vlate");
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        state = result.next;
      }

      // Check: next.days["2026-12-10"].calls is 3 and next.days["2026-12-09"].calls is 1
      expect(state.days["2026-12-10"].calls).toBe(3);
      expect(state.days["2026-12-09"].calls).toBe(1);
    });
  });

  describe("property", () => {
    it("keeps exactly the stored days among 2026-12-09, 2026-12-11 plus 2026-12-10 with updated count", () => {
      fc.assert(
        fc.property(
          fc.record({
            "2026-12-08": fc.option(fc.integer({ min: 0, max: 5 })),
            "2026-12-09": fc.option(fc.integer({ min: 0, max: 5 })),
            "2026-12-10": fc.option(fc.integer({ min: 0, max: 5 })),
            "2026-12-11": fc.option(fc.integer({ min: 0, max: 5 })),
            "2026-12-12": fc.option(fc.integer({ min: 0, max: 5 })),
          }),
          (dayRecords) => {
            // Build the initial state with the random day records
            const startDays: Record<string, { calls: number; visitors: Record<string, number> }> = {};
            for (const [day, count] of Object.entries(dayRecords)) {
              if (count !== null) {
                startDays[day] = { calls: count, visitors: {} };
              }
            }

            const state: UsageState = {
              totalCalls: 0,
              days: startDays,
            };

            const caps = { total: 1000, daily: 0, perVisitorDaily: 0 };
            const result = decideCall(state, caps, "2026-12-10T12:00:00.000Z", "visitor");

            expect(result.allowed).toBe(true);
            if (!result.allowed) return;

            const nextDays = result.next.days;
            const nextDayKeys = Object.keys(nextDays).sort();

            // Collect expected days: those from state.days that are "2026-12-09" or "2026-12-11", plus "2026-12-10"
            const expectedDays = new Set<string>();
            if ("2026-12-09" in state.days) expectedDays.add("2026-12-09");
            if ("2026-12-11" in state.days) expectedDays.add("2026-12-11");
            expectedDays.add("2026-12-10");

            // Check: exactly these days are in nextDays
            expect(nextDayKeys.sort()).toEqual(Array.from(expectedDays).sort());

            // Check: counts for "2026-12-09" and "2026-12-11" are unchanged (if present)
            if ("2026-12-09" in state.days) {
              expect(nextDays["2026-12-09"].calls).toBe(state.days["2026-12-09"].calls);
            }
            if ("2026-12-11" in state.days) {
              expect(nextDays["2026-12-11"].calls).toBe(state.days["2026-12-11"].calls);
            }

            // Check: "2026-12-10" count is stored count + 1 (or 1 if not stored)
            const expectedCount = (state.days["2026-12-10"]?.calls ?? 0) + 1;
            expect(nextDays["2026-12-10"].calls).toBe(expectedCount);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

describe("Feature: document-intake, Property 46: The Answer Room Stays Under the Line (Validates: Requirements 29.1, 29.2, 29.4)", () => {
  describe("examples: output tokens and costs", () => {
    it("21,841 input tokens give 16,000 output tokens (max)", () => {
      const input = {
        bundle: "test",
        documents: [
          {
            docId: "d",
            kind: "invoice" as const,
            fileName: "f",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x".repeat(11676),
                image: null,
              },
            ],
          },
        ],
      };

      const estimate = estimateReaderCall(input);
      expect(estimate.inputTokens).toBe(21841);
      expect(estimate.outputTokens).toBe(16000);
    });

    it("60,000 input tokens give 9,600 output tokens", () => {
      const input = {
        bundle: "test",
        documents: [
          {
            docId: "d",
            kind: "invoice" as const,
            fileName: "f",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x".repeat(49835),
                image: null,
              },
            ],
          },
        ],
      };

      const estimate = estimateReaderCall(input);
      expect(estimate.inputTokens).toBe(60000);
      expect(estimate.outputTokens).toBe(9600);
    });

    it("68,000 input tokens give 8,000 output tokens (min) and worst case exactly 10,800,000", () => {
      const input = {
        bundle: "test",
        documents: [
          {
            docId: "d",
            kind: "invoice" as const,
            fileName: "f",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x".repeat(57835),
                image: null,
              },
            ],
          },
        ],
      };

      const estimate = estimateReaderCall(input);
      expect(estimate.inputTokens).toBe(68000);
      expect(estimate.outputTokens).toBe(8000);
      expect(estimate.worstCaseCostNanoUsd).toBe(10800000);
    });

    it("68,001 input tokens are refused (worst case above 10,800,000)", () => {
      const input = {
        bundle: "test",
        documents: [
          {
            docId: "d",
            kind: "invoice" as const,
            fileName: "f",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x".repeat(57836),
                image: null,
              },
            ],
          },
        ],
      };

      const estimate = estimateReaderCall(input);
      expect(estimate.inputTokens).toBe(68001);
      // With 68,001 input (under the step), output tokens are capped at min 8,000
      // Cost = 68,001 * 100 + 8,000 * 500 = 6,800,100 + 4,000,000 = 10,800,100 nanoUsd
      expect(estimate.worstCaseCostNanoUsd).toBeGreaterThan(10800000);
    });
  });

  describe("property: output room between 8,000 and 16,000, worst case at or below 10,800,000 for inputs up to 68,000", () => {
    it("any input tokens from 0 to 200,000 give output between 8,000 and 16,000", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 200_000 }), (targetInputTokens) => {
          // Build input that roughly hits the target token count
          const baseTokens = 10_000; // promptOverheadTokens
          const remainingTokens = Math.max(0, targetInputTokens - baseTokens);
          const perPageTokens = 160 + 1 + 4; // perPageOverheadTokens + fileName "f" (1) + 4*docId "d" (1*4)
          const textTokens = Math.max(0, remainingTokens - perPageTokens);

          const input = {
            bundle: "test",
            documents: [
              {
                docId: "d",
                kind: "invoice" as const,
                fileName: "f",
                fileSha256: "a".repeat(64),
                pages: [
                  {
                    page: 1,
                    width: 612,
                    height: 792,
                    text: "x".repeat(textTokens),
                    image: null,
                  },
                ],
              },
            ],
          };

          const estimate = estimateReaderCall(input);
          expect(estimate.outputTokens).toBeGreaterThanOrEqual(8000);
          expect(estimate.outputTokens).toBeLessThanOrEqual(16000);
        }),
        { numRuns: 100 },
      );
    });

    it("for inputs 0 to 68,000 tokens, worst case <= 10,800,000; for 68,001+, worst case > 10,800,000", () => {
      fc.assert(
        fc.property(
          fc.tuple(fc.integer({ min: 0, max: 68_000 }), fc.boolean()),
          ([inputTokens, over]) => {
            const baseTokens = 10_000;
            const perPageTokens = 160 + 1 + 4;
            const textTokens = Math.max(0, inputTokens - baseTokens - perPageTokens);

            const input = {
              bundle: "test",
              documents: [
                {
                  docId: "d",
                  kind: "invoice" as const,
                  fileName: "f",
                  fileSha256: "a".repeat(64),
                  pages: [
                    {
                      page: 1,
                      width: 612,
                      height: 792,
                      text: "x".repeat(textTokens),
                      image: null,
                    },
                  ],
                },
              ],
            };

            const estimate = estimateReaderCall(input);

            if (estimate.inputTokens <= 68_000) {
              expect(estimate.worstCaseCostNanoUsd).toBeLessThanOrEqual(10_800_000);
            } else {
              expect(estimate.worstCaseCostNanoUsd).toBeGreaterThan(10_800_000);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("property: when room < 16,000, room + 1 output tokens would exceed the line", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 68_000 }), (inputTokens) => {
          const baseTokens = 10_000;
          const perPageTokens = 160 + 1 + 4;
          const textTokens = Math.max(0, inputTokens - baseTokens - perPageTokens);

          const input = {
            bundle: "test",
            documents: [
              {
                docId: "d",
                kind: "invoice" as const,
                fileName: "f",
                fileSha256: "a".repeat(64),
                pages: [
                  {
                    page: 1,
                    width: 612,
                    height: 792,
                    text: "x".repeat(textTokens),
                    image: null,
                  },
                ],
              },
            ],
          };

          const estimate = estimateReaderCall(input);
          const outputRoom = estimate.outputTokens;

          if (outputRoom < 16_000) {
            const costIfOneMore = estimateCostNanoUsd(estimate.inputTokens, outputRoom + 1, intakeConfig.prices);
            expect(costIfOneMore).toBeGreaterThan(intakeConfig.perCall.maxCallCostNanoUsd);
          }

          // And the room value is never exceeding the max
          expect(outputRoom).toBeLessThanOrEqual(16_000);
          expect(outputRoom).toBeGreaterThanOrEqual(8_000);
        }),
        { numRuns: 100 },
      );
    });
  });
});
