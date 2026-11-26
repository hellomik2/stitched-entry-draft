import type { ReaderInput, ReaderOutput } from "../core/readerContract";
import { validateReaderInput, validateReaderOutput } from "../core/readerContract";
import { intakeConfig } from "../core/intakeConfig";
import { decideCall, remainingCalls, utcDay, estimateCostNanoUsd, estimateReaderCall, addReservedCost } from "../core/budget";
import { visitorKey } from "./visitorKey";
import type { ReaderSetup } from "./readerEnv";
import type { UsageRecord, IntakeReader } from "./readerTypes";
import { ReaderError } from "./readerTypes";
import type { UsageStore } from "./usageStore";
import { newUsageRecordKey, UsageStateConflictError } from "./usageStore";

export type ServiceResponse = { status: number; json: Record<string, unknown> };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isTokenCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

// Requirement 56.1: a usage the call can have. The output is at most the call's max_tokens (its output room) and input + output
// at most the model's context window; any other usage is handled as Requirement 41.3 says.
function isCallUsage(
  usage: { inputTokens: unknown; outputTokens: unknown },
  outputRoom: number,
): usage is { inputTokens: number; outputTokens: number } {
  return (
    isTokenCount(usage.inputTokens) &&
    isTokenCount(usage.outputTokens) &&
    usage.outputTokens <= outputRoom &&
    usage.inputTokens + usage.outputTokens <= intakeConfig.readerContextWindowTokens
  );
}

// Requirements 41.3 and 56.1: a usage the call cannot have gives null tokens and the reserved worst case.
function recordUsage(
  usage: { inputTokens: unknown; outputTokens: unknown } | null,
  reservedNanoUsd: number,
  outputRoom: number,
): { inputTokens: number | null; outputTokens: number | null; estimatedCostNanoUsd: number | null } {
  if (usage === null) {
    return { inputTokens: null, outputTokens: null, estimatedCostNanoUsd: null };
  }
  if (!isCallUsage(usage, outputRoom)) {
    return { inputTokens: null, outputTokens: null, estimatedCostNanoUsd: reservedNanoUsd };
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostNanoUsd: estimateCostNanoUsd(usage.inputTokens, usage.outputTokens) };
}

// Requirement 55.2: a store call after the reader waits at most until the deadline. A call that is still running then counts as
// failed and is not waited for; no call starts when no time is left.
class PostReadTimeoutError extends Error {
  constructor() {
    super("store call after the reader ran out of time");
    this.name = "PostReadTimeoutError";
  }
}

async function beforeDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) {
    throw new PostReadTimeoutError();
  }
  const call = run();
  call.catch(() => {}); // a call that ends after the deadline is not awaited
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PostReadTimeoutError()), left);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Requirement 41.2: a record the store did not confirm is logged with its counts (no file hashes, no error text, no document text).
// After the reader the write ends by the deadline of Requirement 55.2.
async function writeRecord(store: UsageStore, record: UsageRecord, log?: (message: string) => void, deadline?: number): Promise<void> {
  const key = newUsageRecordKey(record.timestamp); // Requirement 62.2: made before the write, so the line can name it
  try {
    if (deadline === undefined) {
      await store.appendRecord(record, key);
    } else {
      await beforeDeadline(deadline, () => store.appendRecord(record, key));
    }
  } catch {
    log?.(
      "usage record not written: " +
        JSON.stringify({ key, timestamp: record.timestamp, model: record.model, outcome: record.outcome, inputTokens: record.inputTokens, outputTokens: record.outputTokens, estimatedCostNanoUsd: record.estimatedCostNanoUsd }),
    );
  }
}

export type ReadDeps = {
  setup: ReaderSetup;
  store: UsageStore | null; // paid-call store, used only in "claude" mode
  fakeStore: UsageStore; // separate memory store, used only in "fake" mode
  readers: { fake?: IntakeReader; claude?: IntakeReader };
  nowIso: string;
  ip: string | null;
  bodyBytes: number;
  body: unknown;
  log?: (message: string) => void; // server log; never pass document text, images or the key
  sleep?: (ms: number) => Promise<void>; // Requirement 42.1; default waits with setTimeout
  postReadStoreMs?: number; // Requirement 55.2; default intakeConfig.postReadStoreMs
};

// Requirement 24.3: the ledger gets the actual cost when it is above the reserved worst case. Requirement 55.2: every store call
// ends by the deadline; a try that runs out of time ends the top-up.
async function topUpCost(
  store: UsageStore,
  usage: { inputTokens: unknown; outputTokens: unknown } | null,
  reservedNanoUsd: number,
  outputRoom: number,
  deadline: number,
  log?: (message: string) => void,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  if (usage === null) {
    return;
  }

  if (!isCallUsage(usage, outputRoom)) {
    return;
  }

  let actual: number;
  try {
    actual = estimateCostNanoUsd(usage.inputTokens, usage.outputTokens);
  } catch {
    log?.("usage cost top-up not written: " + JSON.stringify({ missingNanoUsd: null })); // Requirement 62.3
    return;
  }

  if (actual <= reservedNanoUsd) {
    return;
  }

  const extra = actual - reservedNanoUsd;
  for (let n = 1; n <= 6; n++) {
    if (n > 1) {
      const base = 50 * (n - 1);
      await sleep(base + Math.floor(Math.random() * base));
    }
    try {
      const s = await beforeDeadline(deadline, () => store.readState());
      await beforeDeadline(deadline, () => store.writeState(addReservedCost(s, extra)));
      return;
    } catch (e) {
      if (!(e instanceof UsageStateConflictError)) {
        break;
      }
    }
  }
  log?.("usage cost top-up not written: " + JSON.stringify({ missingNanoUsd: extra })); // Requirement 62.3
}

export async function handleReadRequest(deps: ReadDeps): Promise<ServiceResponse> {
  const { setup, store, fakeStore, readers, nowIso, ip, bodyBytes, body, log, sleep, postReadStoreMs } = deps;

  // 1. Check if mode is off
  if (setup.mode === "off") {
    return {
      status: 503,
      json: {
        ok: false,
        mode: "off",
        message: `The AI reader is off: ${setup.reason}.`,
      },
    };
  }

  // 2. Validate input
  const validationResult = validateReaderInput(body, intakeConfig, bodyBytes);
  if (!validationResult.ok) {
    return {
      status: 400,
      json: {
        ok: false,
        message: validationResult.reason,
      },
    };
  }

  const input: ReaderInput = validationResult.value;
  const filesSha256 = input.documents.map((d) => d.fileSha256).sort();

  // Per-call line (Requirement 17.2, 17.3, 17.7): checked before any store access or reader call, in fake mode too.
  const estimate = estimateReaderCall(input);
  if (estimate.worstCaseCostNanoUsd > intakeConfig.perCall.maxCallCostNanoUsd) {
    return { status: 413, json: { ok: false, message: "These documents are too large to read in one go. Split them and upload fewer pages at a time." } };
  }

  // 3. Handle fake mode
  if (setup.mode === "fake") {
    if (!readers.fake) {
      return {
        status: 503,
        json: {
          ok: false,
          message: "Test mode has no recordings loaded.",
        },
      };
    }

    try {
      const result = await readers.fake.read(input);
      const output = result.output;

      // Validate output
      const outputValidation = validateReaderOutput(output, input);
      if (!outputValidation.ok) {
        return {
          status: 502,
          json: {
            ok: false,
            message: `The reader answer was not valid: ${outputValidation.reason}`,
          },
        };
      }

      // Append record to fake store
      const record: UsageRecord = {
        timestamp: nowIso,
        model: "fake",
        inputTokens: null,
        outputTokens: null,
        estimatedCostNanoUsd: null,
        filesSha256,
        readerMode: "fake",
        outcome: "success",
        errorMessage: null,
      };

      await writeRecord(fakeStore, record, log);

      return {
        status: 200,
        json: {
          ok: true,
          mode: "fake",
          output,
          remaining: null,
        },
      };
    } catch (e) {
      if (e instanceof ReaderError) {
        return {
          status: 422,
          json: {
            ok: false,
            message: e.message,
          },
        };
      }
      throw e;
    }
  }

  // 4. Handle claude mode
  if (setup.mode === "claude") {
    if (!store || !readers.claude) {
      return {
        status: 503,
        json: {
          ok: false,
          message: "The AI reader is not available.",
        },
      };
    }

    // Read current state
    let state;
    try {
      state = await store.readState();
    } catch (e) {
      return {
        status: 503,
        json: {
          ok: false,
          message: "Usage store unavailable; the AI reader was not called.",
        },
      };
    }

    const day = utcDay(nowIso);
    const key = visitorKey(ip, setup.visitorSalt, day);
    const decision = decideCall(state, setup.caps, nowIso, key, { callNanoUsd: estimate.worstCaseCostNanoUsd, capNanoUsd: setup.costCapNanoUsd });

    // Handle cap refusal
    if (!decision.allowed) {
      // Try to append record, but don't fail if it doesn't work
      const record: UsageRecord = {
        timestamp: nowIso,
        model: intakeConfig.readerModel,
        inputTokens: null,
        outputTokens: null,
        estimatedCostNanoUsd: null,
        filesSha256,
        readerMode: "claude",
        outcome: "cap-exceeded",
        errorMessage: decision.reason,
      };

      await writeRecord(store, record, log);

      let message: string;
      if (decision.reason === "total_cap") {
        message = "This demo has used all of its AI reads.";
      } else if (decision.reason === "daily_cap") {
        message = "This demo has used today's AI reads. Try again after midnight UTC.";
      } else if (decision.reason === "cost_cap") {
        message = "This demo has used its AI budget.";
      } else {
        // visitor_cap
        message = "You have used your AI reads for today. Try again after midnight UTC.";
      }

      return {
        status: 429,
        json: {
          ok: false,
          message,
        },
      };
    }

    // Write new state BEFORE calling reader
    try {
      await store.writeState(decision.next);
    } catch (e) {
      return {
        status: 503,
        json: {
          ok: false,
          message: "Usage store unavailable; the AI reader was not called.",
        },
      };
    }

    // Call the reader
    let output: ReaderOutput;
    let usage: { inputTokens: unknown; outputTokens: unknown } | null = null;

    try {
      const result = await readers.claude.read(input);
      output = result.output;
      usage = result.usage;
    } catch (e) {
      const postReadDeadline = Date.now() + (postReadStoreMs ?? intakeConfig.postReadStoreMs);
      const errorMessage = e instanceof ReaderError ? e.message : "The AI reader failed.";
      const errorUsage = e instanceof ReaderError ? e.usage : null;

      // Requirement 55.1: the record first, then the top-up, both by the deadline of Requirement 55.2.
      const record: UsageRecord = {
        timestamp: nowIso,
        model: intakeConfig.readerModel,
        ...recordUsage(errorUsage, estimate.worstCaseCostNanoUsd, estimate.outputTokens),
        filesSha256,
        readerMode: "claude",
        outcome: "error",
        errorMessage: e instanceof ReaderError ? e.message : "reader failed",
      };

      await writeRecord(store, record, log, postReadDeadline);
      await topUpCost(store, errorUsage, estimate.worstCaseCostNanoUsd, estimate.outputTokens, postReadDeadline, log, sleep ?? defaultSleep);

      return {
        status: 502,
        json: {
          ok: false,
          message: errorMessage,
        },
      };
    }

    // Requirement 55.2: the store calls after the reader end by this time.
    const postReadDeadline = Date.now() + (postReadStoreMs ?? intakeConfig.postReadStoreMs);

    // Validate output
    const outputValidation = validateReaderOutput(output, input);
    if (!outputValidation.ok) {
      const record: UsageRecord = {
        timestamp: nowIso,
        model: intakeConfig.readerModel,
        ...recordUsage(usage, estimate.worstCaseCostNanoUsd, estimate.outputTokens),
        filesSha256,
        readerMode: "claude",
        outcome: "error",
        errorMessage: `The reader answer was not valid: ${outputValidation.reason}`,
      };

      await writeRecord(store, record, log, postReadDeadline);
      await topUpCost(store, usage, estimate.worstCaseCostNanoUsd, estimate.outputTokens, postReadDeadline, log, sleep ?? defaultSleep);

      return {
        status: 502,
        json: {
          ok: false,
          message: `The reader answer was not valid: ${outputValidation.reason}`,
        },
      };
    }

    // Success: the record first, then the top-up (Requirement 55.1)
    const record: UsageRecord = {
      timestamp: nowIso,
      model: intakeConfig.readerModel,
      ...recordUsage(usage, estimate.worstCaseCostNanoUsd, estimate.outputTokens),
      filesSha256,
      readerMode: "claude",
      outcome: "success",
      errorMessage: null,
    };

    await writeRecord(store, record, log, postReadDeadline);
    await topUpCost(store, usage, estimate.worstCaseCostNanoUsd, estimate.outputTokens, postReadDeadline, log, sleep ?? defaultSleep);

    return {
      status: 200,
      json: {
        ok: true,
        mode: "claude",
        output,
        remaining: decision.remaining,
      },
    };
  }

  // Should never reach here
  return {
    status: 503,
    json: {
      ok: false,
      message: "Unknown reader mode",
    },
  };
}

export type StatusDeps = {
  setup: ReaderSetup;
  store: UsageStore | null;
  nowIso: string;
  ip: string | null;
};

export async function handleStatusRequest(
  deps: StatusDeps,
): Promise<ServiceResponse> {
  const { setup, store, nowIso, ip } = deps;

  if (setup.mode === "off") {
    return {
      status: 200,
      json: {
        mode: "off",
        reason: setup.reason,
        callsRemaining: null,
      },
    };
  }

  if (setup.mode === "fake") {
    return {
      status: 200,
      json: {
        mode: "fake",
        reason: null,
        callsRemaining: null,
      },
    };
  }

  // Claude mode
  if (!store) {
    return {
      status: 200,
      json: {
        mode: "off",
        reason: "usage store unavailable",
        callsRemaining: null,
      },
    };
  }

  try {
    const state = await store.readState();
    const day = utcDay(nowIso);
    const key = visitorKey(ip, setup.visitorSalt, day);
    const callsRemaining = remainingCalls(state, setup.caps, nowIso, key, { callNanoUsd: intakeConfig.perCall.maxCallCostNanoUsd, capNanoUsd: setup.costCapNanoUsd });

    return {
      status: 200,
      json: {
        mode: "claude",
        reason: null,
        callsRemaining,
      },
    };
  } catch (e) {
    return {
      status: 200,
      json: {
        mode: "off",
        reason: "usage store unavailable",
        callsRemaining: null,
      },
    };
  }
}
