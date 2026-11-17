import { intakeConfig } from "./intakeConfig";

export type UsageState = {
  totalCalls: number;
  days: Record<string, { calls: number; visitors: Record<string, number> }>;
};

export type Caps = {
  total: number;
  daily: number;
  perVisitorDaily: number;
};

export type CallDecision =
  | { allowed: true; next: UsageState; remaining: number }
  | { allowed: false; reason: "total_cap" | "daily_cap" | "visitor_cap" };

export function emptyUsageState(): UsageState {
  return {
    totalCalls: 0,
    days: {},
  };
}

export function utcDay(nowIso: string): string {
  // Parse ISO 8601 string and extract the UTC date in YYYY-MM-DD format
  const date = new Date(nowIso);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function decideCall(
  state: UsageState,
  caps: Caps,
  nowIso: string,
  visitorKey: string,
): CallDecision {
  const day = utcDay(nowIso);
  const today = state.days[day] ?? { calls: 0, visitors: {} };

  // Check total cap
  if (state.totalCalls >= caps.total) {
    return { allowed: false, reason: "total_cap" };
  }

  // Check daily cap
  if (caps.daily > 0 && today.calls >= caps.daily) {
    return { allowed: false, reason: "daily_cap" };
  }

  // Check per-visitor daily cap
  if (caps.perVisitorDaily > 0 && (today.visitors[visitorKey] ?? 0) >= caps.perVisitorDaily) {
    return { allowed: false, reason: "visitor_cap" };
  }

  // Build new state (never mutate input or nested objects)
  const newTodayVisitors = { ...today.visitors };
  newTodayVisitors[visitorKey] = (newTodayVisitors[visitorKey] ?? 0) + 1;

  const newDays: Record<string, { calls: number; visitors: Record<string, number> }> = {};

  // Keep only the current day and the previous UTC day
  const prevDate = new Date(nowIso);
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDay = utcDay(prevDate.toISOString());

  // Copy previous day if it exists
  if (prevDay in state.days && prevDay !== day) {
    newDays[prevDay] = {
      calls: state.days[prevDay].calls,
      visitors: { ...state.days[prevDay].visitors },
    };
  }

  // Add new day state
  newDays[day] = {
    calls: today.calls + 1,
    visitors: newTodayVisitors,
  };

  const next: UsageState = {
    totalCalls: state.totalCalls + 1,
    days: newDays,
  };

  const remaining = remainingCalls(next, caps, nowIso, visitorKey);

  return {
    allowed: true,
    next,
    remaining,
  };
}

export function remainingCalls(
  state: UsageState,
  caps: Caps,
  nowIso: string,
  visitorKey: string | null,
): number {
  let min = caps.total - state.totalCalls;

  const day = utcDay(nowIso);
  const today = state.days[day] ?? { calls: 0, visitors: {} };

  // Check daily cap
  if (caps.daily > 0) {
    min = Math.min(min, caps.daily - today.calls);
  }

  // Check per-visitor daily cap
  if (caps.perVisitorDaily > 0 && visitorKey !== null) {
    const visitorCount = today.visitors[visitorKey] ?? 0;
    min = Math.min(min, caps.perVisitorDaily - visitorCount);
  }

  return Math.max(0, min);
}

export function estimateCostNanoUsd(
  inputTokens: number,
  outputTokens: number,
  prices = intakeConfig.prices,
): number {
  // Validate inputs
  if (!Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new Error("inputTokens must be a non-negative safe integer");
  }
  if (!Number.isInteger(outputTokens) || outputTokens < 0) {
    throw new Error("outputTokens must be a non-negative safe integer");
  }

  // Determine which rates to use based on inputTokens
  let inputRate: number;
  let outputRate: number;

  if (inputTokens > prices.upToPromptTokens) {
    inputRate = prices.inputNanoUsdPerTokenOver;
    outputRate = prices.outputNanoUsdPerTokenOver;
  } else {
    inputRate = prices.inputNanoUsdPerToken;
    outputRate = prices.outputNanoUsdPerToken;
  }

  // Calculate cost: exact integer, no rounding
  const cost = inputTokens * inputRate + outputTokens * outputRate;

  return cost;
}

export function formatUsd(nanoUsd: number): string {
  // Convert nano-USD (1 billionth of a dollar) to USD with 6 decimals
  // Truncate below one micro-dollar (1 millionth of a dollar)

  // nanoUsd / 1_000_000_000 = dollars
  // We want exactly 6 decimal places, truncated

  // Get the number of microdollars (millionths of a dollar)
  const microUsd = Math.floor(nanoUsd / 1000);

  // Get dollars and remaining microdollars
  const dollars = Math.floor(microUsd / 1_000_000);
  const remainingMicroUsd = microUsd % 1_000_000;

  // Format with exactly 6 decimals
  const decimalPart = String(remainingMicroUsd).padStart(6, "0");

  return `${dollars}.${decimalPart}`;
}
