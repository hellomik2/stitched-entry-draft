import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFileUsageStore, createMemoryUsageStore } from "./usageStore";
import { emptyUsageState } from "../core/budget";
import type { UsageRecord } from "./readerTypes";

describe("usageStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-store-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("file store", () => {
    it("missing file gives the empty state", async () => {
      const store = createFileUsageStore(tempDir);
      const state = await store.readState();

      expect(state).toEqual(emptyUsageState());
    });

    it("write then read gives the same state", async () => {
      const store = createFileUsageStore(tempDir);

      const state = {
        totalCalls: 5,
        days: {
          "2026-01-15": { calls: 3, visitors: { "key1": 1, "key2": 2 } },
        },
      };

      await store.writeState(state);
      const read = await store.readState();

      expect(read).toEqual(state);
    });

    it("two appended records give two JSON lines", async () => {
      const store = createFileUsageStore(tempDir);

      const record1: UsageRecord = {
        timestamp: "2026-01-15T10:00:00Z",
        model: "claude-3-5-sonnet-20241022",
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostNanoUsd: 1000000,
        filesSha256: ["abc123"],
        readerMode: "claude",
        outcome: "success",
        errorMessage: null,
      };

      const record2: UsageRecord = {
        timestamp: "2026-01-15T10:01:00Z",
        model: "claude-3-5-sonnet-20241022",
        inputTokens: 200,
        outputTokens: 100,
        estimatedCostNanoUsd: 2000000,
        filesSha256: ["def456"],
        readerMode: "claude",
        outcome: "success",
        errorMessage: null,
      };

      await store.appendRecord(record1);
      await store.appendRecord(record2);

      const content = await fs.readFile(path.join(tempDir, "usage.jsonl"), "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(record1);
      expect(JSON.parse(lines[1])).toEqual(record2);
    });

    it("a caps.json containing invalid JSON makes readState reject", async () => {
      const store = createFileUsageStore(tempDir);
      await fs.writeFile(path.join(tempDir, "caps.json"), "{not json", "utf-8");

      await expect(store.readState()).rejects.toThrow();
    });

    it("memory store keeps records", async () => {
      const store = createMemoryUsageStore();

      const record1: UsageRecord = {
        timestamp: "2026-01-15T10:00:00Z",
        model: "claude-3-5-sonnet-20241022",
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostNanoUsd: 1000000,
        filesSha256: ["abc123"],
        readerMode: "claude",
        outcome: "success",
        errorMessage: null,
      };

      await store.appendRecord(record1);

      expect(store.records).toHaveLength(1);
      expect(store.records[0]).toEqual(record1);
    });
  });

  describe("memory store", () => {
    it("keeps a deep copy of the state", async () => {
      const initial = {
        totalCalls: 1,
        days: {
          "2026-01-15": { calls: 1, visitors: { key1: 1 } },
        },
      };

      const store = createMemoryUsageStore(initial);

      // Mutate the original
      (initial.days["2026-01-15"].visitors as Record<string, number>).key1 = 999;

      // Store should have the original value
      const state = await store.readState();
      expect(state.days["2026-01-15"].visitors.key1).toBe(1);
    });

    it("state() returns a deep copy", async () => {
      const store = createMemoryUsageStore();
      const stateObj = store.state();

      // Mutate returned object
      stateObj.totalCalls = 999;

      // Store should not be affected
      const nextState = store.state();
      expect(nextState.totalCalls).toBe(0);
    });
  });
});
