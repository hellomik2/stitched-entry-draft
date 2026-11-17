import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { UsageState, Caps } from "../core/budget";
import { emptyUsageState } from "../core/budget";
import type { UsageRecord } from "./readerTypes";

export interface UsageStore {
  readState(): Promise<UsageState>;
  writeState(s: UsageState): Promise<void>;
  appendRecord(r: UsageRecord): Promise<void>;
}

export function createFileUsageStore(dir: string): UsageStore {
  const capsPath = path.join(dir, "caps.json");
  const usagePath = path.join(dir, "usage.jsonl");

  return {
    async readState(): Promise<UsageState> {
      try {
        const content = await fs.readFile(capsPath, "utf-8");
        const parsed = JSON.parse(content);

        // Validate structure
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !Number.isInteger(parsed.totalCalls) ||
          typeof parsed.days !== "object"
        ) {
          throw new Error("invalid caps.json structure");
        }

        // Validate days structure
        for (const [, day] of Object.entries(parsed.days)) {
          if (
            !day ||
            typeof day !== "object" ||
            !Number.isInteger((day as Record<string, unknown>).calls) ||
            typeof (day as Record<string, unknown>).visitors !== "object"
          ) {
            throw new Error("invalid day structure in caps.json");
          }
        }

        return parsed as UsageState;
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
