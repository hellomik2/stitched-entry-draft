import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { UsageState, Caps } from "../core/budget";
import { emptyUsageState } from "../core/budget";
import type { UsageRecord } from "./readerTypes";

export class UsageStateConflictError extends Error {
  constructor() {
    super("usage state changed by another request; not written");
    this.name = "UsageStateConflictError";
  }
}

export interface UsageStore {
  readState(): Promise<UsageState>;
  writeState(s: UsageState): Promise<void>;
  appendRecord(r: UsageRecord): Promise<void>;
}

export function parseUsageState(value: unknown): UsageState {
  const parsed = value;

  // Validate structure
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Number.isInteger((parsed as Record<string, unknown>).totalCalls) ||
    typeof (parsed as Record<string, unknown>).days !== "object"
  ) {
    throw new Error("invalid usage state");
  }

  // Validate days structure
  for (const [, day] of Object.entries((parsed as Record<string, unknown>).days as Record<string, unknown>)) {
    if (
      !day ||
      typeof day !== "object" ||
      !Number.isInteger((day as Record<string, unknown>).calls) ||
      typeof (day as Record<string, unknown>).visitors !== "object"
    ) {
      throw new Error("invalid usage state");
    }
  }

  // Validate optional reservedCostNanoUsd
  const reservedCost = (parsed as Record<string, unknown>).reservedCostNanoUsd;
  if (reservedCost !== undefined) {
    if (!Number.isInteger(reservedCost) || (reservedCost as number) < 0 || !(Number.isSafeInteger(reservedCost as number))) {
      throw new Error("invalid usage state");
    }
  }

  return parsed as UsageState;
}

export function createFileUsageStore(dir: string): UsageStore {
  const capsPath = path.join(dir, "caps.json");
  const usagePath = path.join(dir, "usage.jsonl");

  return {
    async readState(): Promise<UsageState> {
      try {
        const content = await fs.readFile(capsPath, "utf-8");
        return parseUsageState(JSON.parse(content));
      } catch (error) {
        // If file doesn't exist, return empty state
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return emptyUsageState();
        }
        // Re-throw for any other error (including JSON parse errors)
        throw error;
      }
    },

    async writeState(s: UsageState): Promise<void> {
      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });

      const tmpPath = capsPath + ".tmp";
      const content = JSON.stringify(s);

      await fs.writeFile(tmpPath, content, "utf-8");
      await fs.rename(tmpPath, capsPath);
    },

    async appendRecord(r: UsageRecord): Promise<void> {
      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });

      const line = JSON.stringify(r) + "\n";
      await fs.appendFile(usagePath, line, "utf-8");
    },
  };
}

export function createMemoryUsageStore(
  initial?: UsageState,
): UsageStore & { records: UsageRecord[]; state(): UsageState } {
  let state: UsageState = initial ? structuredClone(initial) : emptyUsageState();
  const records: UsageRecord[] = [];

  return {
    records,

    state(): UsageState {
      return structuredClone(state);
    },

    async readState(): Promise<UsageState> {
      return structuredClone(state);
    },

    async writeState(s: UsageState): Promise<void> {
      state = structuredClone(s);
    },

    async appendRecord(r: UsageRecord): Promise<void> {
      records.push(structuredClone(r));
    },
  };
}
