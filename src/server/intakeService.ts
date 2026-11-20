import type { ReaderInput, ReaderOutput } from "../core/readerContract";
import { validateReaderInput, validateReaderOutput } from "../core/readerContract";
import { intakeConfig } from "../core/intakeConfig";
import { decideCall, remainingCalls, utcDay, estimateCostNanoUsd, estimateReaderCall, addReservedCost } from "../core/budget";
import { visitorKey } from "./visitorKey";
import type { ReaderSetup } from "./readerEnv";
import type { UsageRecord, IntakeReader } from "./readerTypes";
import { ReaderError } from "./readerTypes";
import type { UsageStore } from "./usageStore";

export type ServiceResponse = { status: number; json: Record<string, unknown> };

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
};

// Requirement 24.3: the ledger gets the actual cost when it is above the reserved worst case.
async function topUpCost(
  store: UsageStore,
  usage: { inputTokens: number; outputTokens: number } | null,
  reservedNanoUsd: number,
  log?: (message: string) => void,
): Promise<void> {
  if (usage === null) {
    return;
  }

  let actual: number;
  try {
    actual = estimateCostNanoUsd(usage.inputTokens, usage.outputTokens);
  } catch {
    log?.("usage cost top-up not written");
    return;
  }

  if (actual <= reservedNanoUsd) {
    return;
  }

  let attempts = 0;
  while (attempts < 3) {
    try {
      attempts++;
      const s = await store.readState();
      await store.writeState(addReservedCost(s, actual - reservedNanoUsd));
      return;
    } catch {
      // Continue to next attempt
    }
  }

  log?.("usage cost top-up not written");
}

export async function handleReadRequest(deps: ReadDeps): Promise<ServiceResponse> {
  const { setup, store, fakeStore, readers, nowIso, ip, bodyBytes, body, log } = deps;

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

      try {
        await fakeStore.appendRecord(record);
      } catch (e) {
        if (log) {
          log("usage record not written (fake mode)");
        }
      }

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

      try {
        await store.appendRecord(record);
      } catch (e) {
        if (log) {
          log("usage record not written (cap exceeded)");
        }
      }

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
    let usage: { inputTokens: number; outputTokens: number } | null = null;

    try {
      const result = await readers.claude.read(input);
      output = result.output;
      usage = result.usage;
    } catch (e) {
      const errorMessage = e instanceof ReaderError ? e.message : "The AI reader failed.";
      const errorUsage = e instanceof ReaderError ? e.usage : null;

      await topUpCost(store, errorUsage, estimate.worstCaseCostNanoUsd, log);

      const record: UsageRecord = {
        timestamp: nowIso,
        model: intakeConfig.readerModel,
        inputTokens: errorUsage?.inputTokens ?? null,
        outputTokens: errorUsage?.outputTokens ?? null,
        estimatedCostNanoUsd: errorUsage
          ? estimateCostNanoUsd(errorUsage.inputTokens, errorUsage.outputTokens)
          : null,
        filesSha256,
        readerMode: "claude",
        outcome: "error",
        errorMessage: e instanceof ReaderError ? e.message : "reader failed",
      };

      try {
        await store.appendRecord(record);
      } catch (recordErr) {
        if (log) {
          log("usage record not written (reader error)");
        }
      }

      return {
        status: 502,
        json: {
          ok: false,
          message: errorMessage,
        },
      };
    }

    // Validate output
    const outputValidation = validateReaderOutput(output, input);
    if (!outputValidation.ok) {
      await topUpCost(store, usage, estimate.worstCaseCostNanoUsd, log);

      const record: UsageRecord = {
        timestamp: nowIso,
        model: intakeConfig.readerModel,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        estimatedCostNanoUsd: usage
          ? estimateCostNanoUsd(usage.inputTokens, usage.outputTokens)
          : null,
        filesSha256,
        readerMode: "claude",
        outcome: "error",
        errorMessage: `The reader answer was not valid: ${outputValidation.reason}`,
      };

      try {
        await store.appendRecord(record);
      } catch (e) {
        if (log) {
          log("usage record not written (output validation error)");
        }
      }

      return {
        status: 502,
        json: {
          ok: false,
          message: `The reader answer was not valid: ${outputValidation.reason}`,
        },
      };
    }

    // Success: append record
    await topUpCost(store, usage, estimate.worstCaseCostNanoUsd, log);

    const cost = usage ? estimateCostNanoUsd(usage.inputTokens, usage.outputTokens) : null;
    const record: UsageRecord = {
      timestamp: nowIso,
      model: intakeConfig.readerModel,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      estimatedCostNanoUsd: cost,
      filesSha256,
      readerMode: "claude",
      outcome: "success",
      errorMessage: null,
    };

    try {
      await store.appendRecord(record);
    } catch (e) {
      if (log) {
        log("usage record not written");
      }
    }

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
