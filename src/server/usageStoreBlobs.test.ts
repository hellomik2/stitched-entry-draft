import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { UsageState } from "../core/budget";
import { emptyUsageState } from "../core/budget";
import type { UsageRecord, IntakeReader } from "./readerTypes";
import { createBlobsUsageStore, type BlobsLike } from "./usageStoreBlobs";
import { handleReadRequest } from "./intakeService";
import { resolveReaderSetup } from "./readerEnv";
import { createMemoryUsageStore } from "./usageStore";
import type { ReaderInput } from "../core/readerContract";
import { ReaderError } from "./readerTypes";

// Helper to create a fake Blobs store
function createFakeBlobs(): BlobsLike & { entries: Map<string, { data: unknown; etag: string }> } {
  const entries = new Map<string, { data: unknown; etag: string }>();
  let etagCounter = 0;

  return {
    entries,

    async getWithMetadata(key: string) {
      await Promise.resolve();
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      return {
        data: structuredClone(entry.data),
        etag: entry.etag,
      };
    },

    async setJSON(key: string, data: unknown, options?: { onlyIfMatch?: string; onlyIfNew?: boolean }) {
      await Promise.resolve();

      if (options?.onlyIfNew) {
        if (entries.has(key)) {
          return { modified: false };
        }
      } else if (options?.onlyIfMatch) {
        const existing = entries.get(key);
        if (!existing || existing.etag !== options.onlyIfMatch) {
          return { modified: false };
        }
      }

      etagCounter++;
      const etag = `e${etagCounter}`;
      entries.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
  };
}

describe("Feature: document-intake, Blobs Usage Store (Validates: Requirements 11.1, 11.5)", () => {
  it("empty store reads the empty state", async () => {
    const blobs = createFakeBlobs();
    const store = createBlobsUsageStore({ blobs });

    const state = await store.readState();

    expect(state).toEqual(emptyUsageState());
  });

  it("write then new instance reads the same state", async () => {
    const blobs = createFakeBlobs();
    const store1 = createBlobsUsageStore({ blobs });
    const initial = await store1.readState();

    const updated: UsageState = {
      totalCalls: 5,
      days: {
        "2026-01-01": { calls: 3, visitors: { visitor1: 2 } },
      },
    };

    await store1.writeState(updated);

    const store2 = createBlobsUsageStore({ blobs });
    const state = await store2.readState();

    expect(state).toEqual(updated);
  });

  it("write without read rejects with 'must be read'", async () => {
    const blobs = createFakeBlobs();
    const store = createBlobsUsageStore({ blobs });

    const newState: UsageState = {
      totalCalls: 1,
      days: {},
    };

    await expect(store.writeState(newState)).rejects.toThrow("usage state must be read before it is written");
  });

  it("two instances read same state, first write succeeds, second rejects with 'changed by another request'", async () => {
    const blobs = createFakeBlobs();

    const store1 = createBlobsUsageStore({ blobs });
    const store2 = createBlobsUsageStore({ blobs });

    const state1 = await store1.readState();
    const state2 = await store2.readState();

    const updated1: UsageState = { totalCalls: 1, days: {} };
    await store1.writeState(updated1);

    const updated2: UsageState = { totalCalls: 2, days: {} };
    await expect(store2.writeState(updated2)).rejects.toThrow("usage state changed by another request; not written");

    // Verify stored state is from first write
    const store3 = createBlobsUsageStore({ blobs });
    const final = await store3.readState();
    expect(final.totalCalls).toBe(1);
  });

  it("stored value with invalid shape makes readState reject", async () => {
    const blobs = createFakeBlobs();
    const store = createBlobsUsageStore({ blobs });

    // Manually set an invalid state
    await blobs.setJSON("caps-state", { totalCalls: "x" }, { onlyIfNew: true });

    await expect(store.readState()).rejects.toThrow("invalid usage state");
  });

  it("two appended records give distinct keys starting with 'usage/' and holding the records", async () => {
    const blobs = createFakeBlobs();
    const store = createBlobsUsageStore({ blobs });

    const record1: UsageRecord = {
      timestamp: "2026-01-01T10:00:00Z",
      model: "test-1",
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostNanoUsd: 10000,
      filesSha256: [],
      readerMode: "claude",
      outcome: "success",
      errorMessage: null,
    };

    const record2: UsageRecord = {
      timestamp: "2026-01-01T10:00:01Z",
      model: "test-2",
      inputTokens: 200,
      outputTokens: 100,
      estimatedCostNanoUsd: 20000,
      filesSha256: [],
      readerMode: "claude",
      outcome: "success",
      errorMessage: null,
    };

    await store.appendRecord(record1);
    await store.appendRecord(record2);

    const keys = Array.from(blobs.entries.keys());
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.startsWith("usage/"))).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);

    const data1 = blobs.entries.get(keys[0])!.data;
    const data2 = blobs.entries.get(keys[1])!.data;
    expect(data1).toEqual(record1);
    expect(data2).toEqual(record2);
  });
});

// Helper to create minimal test input
function createTestInput(): ReaderInput {
  return {
    bundle: "test-bundle",
    documents: [
      {
        docId: "doc1",
        kind: "invoice",
        fileName: "invoice.pdf",
        fileSha256: "a".repeat(64),
        pages: [
          {
            page: 1,
            width: 612,
            height: 792,
            text: "Invoice",
            image: null,
          },
        ],
      },
    ],
  };
}

describe("Feature: document-intake, Property 29: Blobs Store Never Lets Concurrent Requests Exceed A Cap (Validates: Requirements 11.1, 11.5)", () => {
  it("concurrent requests respect total cap with blobs store", async () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 8 }),
        async (total, numRequests) => {
          const sharedBlobs = createFakeBlobs();
          let readerCalls = 0;

          const stubReader = {
            name: "stub",
            read: async () => {
              readerCalls++;
              throw new ReaderError("stub error", null);
            },
          };

          // Create test setup
          const setup = resolveReaderSetup({
            ANTHROPIC_API_KEY: "test-key-not-real",
            DOCUMENT_INTAKE_STORE: "netlify-blobs",
            DOCUMENT_INTAKE_TOTAL_CAP: String(total),
            DOCUMENT_INTAKE_DAILY_CAP: "0",
            DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "0",
          });

          // First round: concurrent requests
          const round1 = await Promise.all(
            Array.from({ length: numRequests }, async () => {
              const store = createBlobsUsageStore({ blobs: sharedBlobs });
              return handleReadRequest({
                setup,
                store,
                fakeStore: createMemoryUsageStore(),
                readers: { claude: stubReader },
                nowIso: "2026-01-01T10:00:00Z",
                ip: "203.0.113.1",
                bodyBytes: 100,
                body: createTestInput(),
              });
            }),
          );

          // Second round: sequential requests
          const round2: Array<{ status: number }> = [];
          for (let i = 0; i < numRequests; i++) {
            const store = createBlobsUsageStore({ blobs: sharedBlobs });
            const result = await handleReadRequest({
              setup,
              store,
              fakeStore: createMemoryUsageStore(),
              readers: { claude: stubReader },
              nowIso: "2026-01-01T10:00:00Z",
              ip: "203.0.113.1",
              bodyBytes: 100,
              body: createTestInput(),
            });
            round2.push(result);
          }

          const allResults = [...round1, ...round2];

          // Count outcomes
          const reader502 = allResults.filter((r) => r.status === 502).length; // reader ran (error)
          const cap429 = allResults.filter((r) => r.status === 429).length; // cap exceeded
          const lost503 = allResults.filter((r) => r.status === 503).length; // lost the race

          // Verify constraints
          expect(readerCalls).toBeLessThanOrEqual(total);
          expect(readerCalls).toBeGreaterThanOrEqual(1);

          // Status codes should be valid
          allResults.forEach((r) => {
            expect([429, 502, 503]).toContain(r.status);
          });

          // At least some should be 429 (cap) or 503 (lost race) once we hit limit
          if (numRequests * 2 > total) {
            expect(cap429 + lost503).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("Feature: document-intake, Property 39: Unconfirmed Cap Writes Stop the Call (Validates: Requirements 23.1, 23.2)", () => {
  it("blobs mock returning empty etag: writeState rejects", async () => {
    const blobs: BlobsLike = {
      async getWithMetadata() {
        return null;
      },
      async setJSON() {
        return { modified: true, etag: "" };
      },
    };

    const store = createBlobsUsageStore({ blobs });
    await store.readState();

    const newState: any = { totalCalls: 1, days: {} };
    await expect(store.writeState(newState)).rejects.toThrow(
      "usage state write was not confirmed by the store; not written",
    );
  });

  it("blobs mock returning no etag property: writeState rejects", async () => {
    const blobs: BlobsLike = {
      async getWithMetadata() {
        return null;
      },
      async setJSON() {
        return { modified: true };
      },
    };

    const store = createBlobsUsageStore({ blobs });
    await store.readState();

    const newState: any = { totalCalls: 1, days: {} };
    await expect(store.writeState(newState)).rejects.toThrow(
      "usage state write was not confirmed by the store; not written",
    );
  });

  it("five consecutive handleReadRequest calls with unconfirmed writes: all return 503, reader never called", async () => {
    const blobs: BlobsLike = {
      async getWithMetadata() {
        return null;
      },
      async setJSON() {
        return { modified: true, etag: "" };
      },
    };

    const setup = resolveReaderSetup({
      ANTHROPIC_API_KEY: "test-key-not-real",
      DOCUMENT_INTAKE_STORE: "netlify-blobs",
      DOCUMENT_INTAKE_TOTAL_CAP: "1",
      DOCUMENT_INTAKE_DAILY_CAP: "0",
      DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "0",
    });

    let readerCallCount = 0;
    const stubReader: IntakeReader = {
      name: "stub",
      read: async () => {
        readerCallCount++;
        throw new Error("should not be called");
      },
    };

    const results = [];
    for (let i = 0; i < 5; i++) {
      const store = createBlobsUsageStore({ blobs });
      const result = await handleReadRequest({
        setup,
        store,
        fakeStore: createMemoryUsageStore(),
        readers: { claude: stubReader },
        nowIso: "2026-01-01T10:00:00Z",
        ip: "203.0.113.1",
        bodyBytes: 100,
        body: createTestInput(),
      });
      results.push(result);
    }

    expect(readerCallCount).toBe(0);
    expect(results.every((r) => r.status === 503)).toBe(true);
    expect(results.every((r) => r.json.message === "Usage store unavailable; the AI reader was not called.")).toBe(true);
  });

  it("property: with etag-returning blobs, reader called exactly min(total, requests) times", async () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 10 }),
        async (total, numRequests) => {
          const blobs = createFakeBlobs();

          const setup = resolveReaderSetup({
            ANTHROPIC_API_KEY: "test-key-not-real",
            DOCUMENT_INTAKE_STORE: "netlify-blobs",
            DOCUMENT_INTAKE_TOTAL_CAP: String(total),
            DOCUMENT_INTAKE_DAILY_CAP: "0",
            DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "0",
          });

          let readerCallCount = 0;
          const countingReader: IntakeReader = {
            name: "counting",
            read: async () => {
              readerCallCount++;
              throw new ReaderError("counting", null);
            },
          };

          for (let i = 0; i < numRequests; i++) {
            const store = createBlobsUsageStore({ blobs });
            await handleReadRequest({
              setup,
              store,
              fakeStore: createMemoryUsageStore(),
              readers: { claude: countingReader },
              nowIso: "2026-01-01T10:00:00Z",
              ip: `203.0.113.${i}`, // Different IP per request to avoid visitor cap
              bodyBytes: 100,
              body: createTestInput(),
            });
          }

          expect(readerCallCount).toBe(Math.min(total, numRequests));
        },
      ),
      { numRuns: 50 },
    );
  });
});
