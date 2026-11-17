import { describe, it, expect } from "vitest";
import {
  emptyUsageState,
  utcDay,
  decideCall,
  remainingCalls,
  estimateCostNanoUsd,
  formatUsd,
} from "./budget";
import { intakeConfig } from "./intakeConfig";

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
