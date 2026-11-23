import { intakeConfig } from "./intakeConfig";
import type { ReaderInput } from "./readerContract";

export type UsageState = {
  totalCalls: number;
  days: Record<string, { calls: number; visitors: Record<string, number> }>;
  reservedCostNanoUsd?: number;
};

export type Caps = {
  total: number;
  daily: number;
  perVisitorDaily: number;
};

export type CostOption = { callNanoUsd: number; capNanoUsd: number };

export type CallDecision =
  | { allowed: true; next: UsageState; remaining: number }
  | { allowed: false; reason: "total_cap" | "daily_cap" | "visitor_cap" | "cost_cap" };

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

export function utf8Bytes(s: string): number {
  // Count exact UTF-8 bytes: every text the uploader controls is counted at one token per byte.
  // This bounds any text; also characters outside the Basic Multilingual Plane.
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      bytes += 1;
    } else if (cp < 0x800) {
      bytes += 2;
    } else if (cp < 0x10000) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

export function addReservedCost(state: UsageState, extraNanoUsd: number): UsageState {
  // The ledger gets the actual cost when it is above the reserved worst case (Requirement 24.3).
  if (!Number.isInteger(extraNanoUsd) || extraNanoUsd < 0) {
    throw new Error("extraNanoUsd must be a non-negative safe integer");
  }
  return {
    ...state,
    reservedCostNanoUsd: (state.reservedCostNanoUsd ?? 0) + extraNanoUsd,
  };
}

export function decideCall(
  state: UsageState,
  caps: Caps,
  nowIso: string,
  visitorKey: string,
  cost?: CostOption,
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

  // Check cost cap
  const reserved = state.reservedCostNanoUsd ?? 0;
  if (cost && reserved + cost.callNanoUsd > cost.capNanoUsd) {
    return { allowed: false, reason: "cost_cap" };
  }

  // Build new state (never mutate input or nested objects)
  const newTodayVisitors = { ...today.visitors };
  newTodayVisitors[visitorKey] = (newTodayVisitors[visitorKey] ?? 0) + 1;

  const newDays: Record<string, { calls: number; visitors: Record<string, number> }> = {};

  // Keep the previous, current and next UTC day (Requirement 28.3): a server whose clock is a little behind must not erase the count of a day another server has started.
  const prevDate = new Date(nowIso);
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDay = utcDay(prevDate.toISOString());

  const nextDate = new Date(nowIso);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextDay = utcDay(nextDate.toISOString());

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

  // Copy next day if it exists and differs from current day
  if (nextDay in state.days && nextDay !== day) {
    newDays[nextDay] = {
      calls: state.days[nextDay].calls,
      visitors: { ...state.days[nextDay].visitors },
    };
  }

  const next: UsageState = {
    totalCalls: state.totalCalls + 1,
    days: newDays,
  };

  // Track reserved cost if provided or if already tracking
  if (cost || state.reservedCostNanoUsd !== undefined) {
    next.reservedCostNanoUsd = reserved + (cost?.callNanoUsd ?? 0);
  }

  const remaining = remainingCalls(next, caps, nowIso, visitorKey, cost);

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
  cost?: CostOption,
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

  // Check cost cap
  if (cost && cost.callNanoUsd > 0) {
    const reserved = state.reservedCostNanoUsd ?? 0;
    const remainingCap = Math.floor((cost.capNanoUsd - reserved) / cost.callNanoUsd);
    min = Math.min(min, remainingCap);
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

export type CallEstimate = {
  inputTokens: number;
  outputTokens: number;
  worstCaseCostNanoUsd: number;
};

export function estimateReaderCall(
  input: ReaderInput,
  cfg = intakeConfig,
): CallEstimate {
  // Every text the uploader controls is counted at one token per UTF-8 byte (bounds any text).
  // The request repeats the file name and the document id on every page.
  // The fixed prompt text is in promptOverheadTokens.
  // Claude scales every image to at most about 4,800 tokens (we use 5,000).
  // Any input under the per-call line therefore has at most 68,000 input tokens,
  // below the 100,000-token price step (Requirement 24.1, 24.2).

  let inputTokens = cfg.perCall.promptOverheadTokens;

  for (const doc of input.documents) {
    for (const page of doc.pages) {
      inputTokens += cfg.perCall.perPageOverheadTokens + utf8Bytes(doc.fileName) + 4 * utf8Bytes(doc.docId);
      inputTokens += page.text !== null ? utf8Bytes(page.text) : cfg.perCall.imageTokensPerPage;
    }
  }

  // Output room under the per-call line: largest whole number of tokens o for which
  // estimateCostNanoUsd(inputTokens, o) <= perCall.maxCallCostNanoUsd (Requirement 29.4).
  // The output price depends on inputTokens: use the same rule as estimateCostNanoUsd.
  const outputPrice =
    inputTokens > cfg.prices.upToPromptTokens
      ? cfg.prices.outputNanoUsdPerTokenOver
      : cfg.prices.outputNanoUsdPerToken;

  // Cost of input alone
  const inputCostNanoUsd = estimateCostNanoUsd(inputTokens, 0, cfg.prices);

  // Room for output tokens under the per-call cost line
  const room = Math.floor((cfg.perCall.maxCallCostNanoUsd - inputCostNanoUsd) / outputPrice);

  // Output tokens capped at max, but never below min
  const outputTokens = Math.min(cfg.readerMaxOutputTokens, Math.max(cfg.readerMinOutputTokens, room));

  const worstCaseCostNanoUsd = estimateCostNanoUsd(inputTokens, outputTokens, cfg.prices);

  return {
    inputTokens,
    outputTokens,
    worstCaseCostNanoUsd,
  };
}
