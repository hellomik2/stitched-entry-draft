import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { emptyUsageState, decideCall, remainingCalls, estimateCostNanoUsd, utcDay, estimateReaderCall } from "./budget";
import { intakeConfig } from "./intakeConfig";

describe("budget: property tests", () => {
  describe("Property 7: Cap Enforcement Never Exceeds Limit (Validates: 11.1, 11.2)", () => {
    it("Feature: document-intake, Property 7: Cap Enforcement Never Exceeds Limit", () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: 0, max: 20 }),
            fc.integer({ min: 0, max: 10 }),
            fc.integer({ min: 0, max: 5 }),
          ),
          fc.array(
            fc.tuple(
              fc.integer({ min: 0, max: 2 }), // day offset
              fc.constantFrom("a", "b", "c"), // visitor key
            ),
            { minLength: 0, maxLength: 60 },
          ),
          (capsData, requests) => {
            const [totalCap, dailyCap, perVisitorCap] = capsData;
            const caps = { total: totalCap, daily: dailyCap, perVisitorDaily: perVisitorCap };

            let state = emptyUsageState();
            let allowedCount = 0;
            const dailyCounts: Record<string, number> = {};
            const visitorDailyCounts: Record<string, Record<string, number>> = {};

            const ordered = [...requests].sort((p, q) => p[0] - q[0]);
            for (const [dayOffset, visitorKey] of ordered) {
              const baseDate = new Date("2026-11-18T00:00:00Z");
              baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
              const nowIso = baseDate.toISOString();
              const day = utcDay(nowIso);

              const result = decideCall(state, caps, nowIso, visitorKey);

              if (result.allowed) {
                state = result.next;
                allowedCount++;

                dailyCounts[day] = (dailyCounts[day] ?? 0) + 1;
                if (!visitorDailyCounts[day]) visitorDailyCounts[day] = {};
                visitorDailyCounts[day][visitorKey] = (visitorDailyCounts[day][visitorKey] ?? 0) + 1;

                // Verify never exceed total cap
                expect(state.totalCalls).toBeLessThanOrEqual(totalCap);

                // Verify never exceed daily cap for any day
                for (const dayCount of Object.values(dailyCounts)) {
                  if (dailyCap > 0) {
                    expect(dayCount).toBeLessThanOrEqual(dailyCap);
                  }
                }

                // Verify never exceed per-visitor daily cap for any (day, visitor) pair
                for (const dayVisitors of Object.values(visitorDailyCounts)) {
                  for (const visitorCount of Object.values(dayVisitors)) {
                    if (perVisitorCap > 0) {
                      expect(visitorCount).toBeLessThanOrEqual(perVisitorCap);
                    }
                  }
                }
              }
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe("Property 8: Cap Counters Equal Allowed Calls (11.7)", () => {
    it("Feature: document-intake, Property 8: Cap Counters Equal Allowed Calls", () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: 0, max: 20 }),
            fc.integer({ min: 0, max: 10 }),
            fc.integer({ min: 0, max: 5 }),
          ),
          fc.array(
            fc.tuple(
              fc.integer({ min: 0, max: 2 }),
              fc.constantFrom("a", "b", "c"),
            ),
            { minLength: 0, maxLength: 60 },
          ),
          (capsData, requests) => {
            const [totalCap, dailyCap, perVisitorCap] = capsData;
            const caps = { total: totalCap, daily: dailyCap, perVisitorDaily: perVisitorCap };

            let state = emptyUsageState();
            let allowedCount = 0;
            let lastDay: string | null = null;
            let lastDayAllowedCount = 0;

            const ordered = [...requests].sort((p, q) => p[0] - q[0]);
            for (const [dayOffset, visitorKey] of ordered) {
              const baseDate = new Date("2026-11-18T00:00:00Z");
              baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
              const nowIso = baseDate.toISOString();
              const day = utcDay(nowIso);

              const result = decideCall(state, caps, nowIso, visitorKey);

              if (result.allowed) {
                state = result.next;
                allowedCount++;

                if (day !== lastDay) {
                  lastDay = day;
                  lastDayAllowedCount = 1;
                } else {
                  lastDayAllowedCount++;
                }
              }
            }

            // Verify total calls equals allowed calls
            expect(state.totalCalls).toBe(allowedCount);

            // Verify last day calls equals last day allowed count
            if (lastDay !== null && lastDay in state.days) {
              expect(state.days[lastDay].calls).toBe(lastDayAllowedCount);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe("Property 9: Cap State Not Mutated (11)", () => {
    it("Feature: document-intake, Property 9: Cap State Not Mutated", () => {
      fc.assert(
        fc.property(
          fc.object({ maxKeys: 5 } as any),
          fc.integer({ min: 0, max: 20 }),
          (stateRaw, totalCap) => {
            const state = { totalCalls: 0, days: {} };
            const stateBefore = JSON.stringify(state);

            decideCall(state, { total: totalCap, daily: 10, perVisitorDaily: 5 }, "2026-11-18T12:00:00Z", "v1");

            expect(JSON.stringify(state)).toBe(stateBefore);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe("Property 10: Remaining Calls Never Negative (11.7)", () => {
    it("Feature: document-intake, Property 10: Remaining Calls Never Negative", () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: 0, max: 20 }),
            fc.integer({ min: 0, max: 10 }),
            fc.integer({ min: 0, max: 5 }),
          ),
          fc.array(
            fc.tuple(
              fc.integer({ min: 0, max: 2 }),
              fc.constantFrom("a", "b", "c"),
              fc.integer({ min: 0, max: 23 }), // hour
            ),
            { minLength: 0, maxLength: 60 },
          ),
          (capsData, requests) => {
            const [totalCap, dailyCap, perVisitorCap] = capsData;
            const caps = { total: totalCap, daily: dailyCap, perVisitorDaily: perVisitorCap };

            let state = emptyUsageState();

            const ordered = [...requests].sort((p, q) => p[0] - q[0] || p[2] - q[2]);
            for (const [dayOffset, visitorKey, hour] of ordered) {
              const baseDate = new Date("2026-11-18T00:00:00Z");
              baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
              baseDate.setUTCHours(hour);
              const nowIso = baseDate.toISOString();

              const result = decideCall(state, caps, nowIso, visitorKey);

              if (result.allowed) {
                state = result.next;
              }

              // Check remainingCalls is >= 0
              const remaining = remainingCalls(state, caps, nowIso, visitorKey);
              expect(remaining).toBeGreaterThanOrEqual(0);

              // Check: remaining is 0 exactly when decideCall refuses with the same params
              const nextResult = decideCall(state, caps, nowIso, visitorKey);
              if (remaining === 0) {
                expect(nextResult.allowed).toBe(false);
              } else if (nextResult.allowed) {
                expect(remaining).toBeGreaterThan(0);
              }
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe("Property 11: Cost Estimate Monotonic (10.3)", () => {
    it("Feature: document-intake, Property 11: Cost Estimate Monotonic", () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: 0, max: 1000 }),
            fc.integer({ min: 0, max: 1000 }),
            fc.integer({ min: 0, max: 1000 }),
          ),
          (costs) => {
            const [a1, a2, b1] = costs;
            const b2 = b1 + 1000; // Ensure b2 > b1

            // Cost is monotonic: increasing tokens never lowers cost
            const cost1 = estimateCostNanoUsd(a1, b1, intakeConfig.prices);
            const cost2 = estimateCostNanoUsd(a1 + a2, b1, intakeConfig.prices);
            expect(cost2).toBeGreaterThanOrEqual(cost1);

            const cost3 = estimateCostNanoUsd(a1, b1, intakeConfig.prices);
            const cost4 = estimateCostNanoUsd(a1, b2, intakeConfig.prices);
            expect(cost4).toBeGreaterThanOrEqual(cost3);

            // Zero tokens cost 0
            expect(estimateCostNanoUsd(0, 0, intakeConfig.prices)).toBe(0);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe("Property 12: Cost Estimate Additive (10.3)", () => {
    it("Feature: document-intake, Property 12: Cost Estimate Additive", () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: 0, max: 50000 }),
            fc.integer({ min: 0, max: 50000 }),
            fc.integer({ min: 0, max: 50000 }),
            fc.integer({ min: 0, max: 50000 }),
          ),
          (tokens) => {
            const [a1, a2, b1, b2] = tokens;

            // Only test when a1 + a2 <= upToPromptTokens (same price tier)
            if (a1 + a2 > intakeConfig.prices.upToPromptTokens) {
              return true;
            }

            const cost1 = estimateCostNanoUsd(a1, b1, intakeConfig.prices);
            const cost2 = estimateCostNanoUsd(a2, b2, intakeConfig.prices);
            const costSum = estimateCostNanoUsd(a1 + a2, b1 + b2, intakeConfig.prices);

            expect(costSum).toBe(cost1 + cost2);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe("Property 46: The Answer Room Stays Under the Line (Validates: Requirements 29.1, 29.2, 29.4)", () => {
    it("Feature: document-intake, Property 46: The Answer Room Stays Under the Line", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 200_000 }),
          (targetInputTokens) => {
            // Build input that roughly hits the target token count
            const baseTokens = 10_000; // promptOverheadTokens
            const remainingTokens = Math.max(0, targetInputTokens - baseTokens);
            const textPerPage = Math.max(0, remainingTokens - 500);

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
                      text: "x".repeat(textPerPage),
                      image: null,
                    },
                  ],
                },
              ],
            };

            const estimate = estimateReaderCall(input);

            // Property 1: Output room is between 8,000 and 16,000
            expect(estimate.outputTokens).toBeGreaterThanOrEqual(8000);
            expect(estimate.outputTokens).toBeLessThanOrEqual(16000);

            // Property 2: When input <= 68,000, worst case <= 10,800,000; when > 68,000, worst case > 10,800,000
            if (estimate.inputTokens <= 68_000) {
              expect(estimate.worstCaseCostNanoUsd).toBeLessThanOrEqual(10_800_000);
            } else {
              expect(estimate.worstCaseCostNanoUsd).toBeGreaterThan(10_800_000);
            }

            // Property 3: When room < 16,000, adding one more output token would exceed the line
            const outputRoom = estimate.outputTokens;
            if (outputRoom < 16_000) {
              const costIfOneMore = estimateCostNanoUsd(estimate.inputTokens, outputRoom + 1, intakeConfig.prices);
              expect(costIfOneMore).toBeGreaterThan(intakeConfig.perCall.maxCallCostNanoUsd);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
