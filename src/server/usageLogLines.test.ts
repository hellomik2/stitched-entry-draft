import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { estimateCostNanoUsd, estimateReaderCall } from "../core/budget";
import type { ReaderInput } from "../core/readerContract";
import { handleReadRequest } from "./intakeService";
import type { ReaderSetup } from "./readerEnv";
import type { IntakeReader, UsageRecord } from "./readerTypes";
import { createMemoryUsageStore, newUsageRecordKey, UsageStateConflictError, type UsageStore } from "./usageStore";
import { createBlobsUsageStore, type BlobsLike } from "./usageStoreBlobs";

// Feature: document-intake, Requirement 62 and Property 83 (task 79.1): the line of a record that was not written names its key,
// and the line of a top-up that was not written names the missing amount. No network and no AI: the reader is a spy and the
// store is a memory store wrapped to fail.

const RECORD_LINE = "usage record not written: ";
const TOPUP_LINE = "usage cost top-up not written: ";
const KEY = /^usage\/\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_FIELDS = ["estimatedCostNanoUsd", "inputTokens", "key", "model", "outcome", "outputTokens", "timestamp"];
const NOW = "2026-12-10T03:00:00.000Z";
const validOutput = { reader: "x", fields: [], transcripts: [], invoiceLineCount: null };
const ERROR_TEXT = "store refused ERR-7Q2";

const bodyOf = (sha: string, text: string): ReaderInput => ({ bundle: "b", documents: [{ docId: "inv", kind: "invoice", fileName: "a.pdf", fileSha256: sha, pages: [{ page: 1, width: 612, height: 792, text, image: null }] }] });
const setupOf = (apiKey: string): ReaderSetup => ({ mode: "claude", reason: null, caps: { total: 5, daily: 30, perVisitorDaily: 30 }, costCapNanoUsd: 6_666_666_666, store: "netlify-blobs", storeDir: "logs", visitorSalt: "s", apiKey });

function spy(usage: { inputTokens: number; outputTokens: number }): IntakeReader {
  return { name: "spy", async read() { return { output: validOutput as never, usage: usage as never }; } };
}

type Fail = { record: "ok" | "throws" | "hangs"; topUp: "ok" | "throws" | "conflicts" };
/** A memory store that fails as asked. The first state write is the reservation; the later ones are the top-up. */
function failing(f: Fail) {
  const inner = createMemoryUsageStore();
  const keys: (string | undefined)[] = [];
  let stateWrites = 0;
  const store: UsageStore = {
    readState: () => inner.readState(),
    async writeState(s) {
      stateWrites++;
      if (stateWrites > 1 && f.topUp === "throws") throw new Error(ERROR_TEXT);
      if (stateWrites > 1 && f.topUp === "conflicts") throw new UsageStateConflictError();
      return inner.writeState(s);
    },
    async appendRecord(r: UsageRecord, key?: string) {
      keys.push(key);
      if (f.record === "throws") throw new Error(ERROR_TEXT);
      if (f.record === "hangs") return new Promise<void>(() => {});
      return inner.appendRecord(r);
    },
  };
  return { store, inner, keys };
}

async function call(store: UsageStore, body: ReaderInput, apiKey: string, usage: { inputTokens: number; outputTokens: number }) {
  const logs: string[] = [];
  const res = await handleReadRequest({
    setup: setupOf(apiKey), store, fakeStore: createMemoryUsageStore(), readers: { claude: spy(usage) },
    nowIso: NOW, ip: "203.0.113.9", bodyBytes: 500, body, log: (m: string) => logs.push(m), sleep: async () => {}, postReadStoreMs: 30,
  });
  return { res, logs };
}

const BODY = bodyOf("a".repeat(64), "Invoice total USD 10.00");
const WORST = estimateReaderCall(BODY).worstCaseCostNanoUsd;
const BIG = { inputTokens: 200_000, outputTokens: 16_000 };

describe("Feature: document-intake, Requirement 62: The Lines for a Record or a Top-Up Not Written Name the Record Key and the Missing Amount", () => {
  it("62.1: newUsageRecordKey gives usage/<the digits of the timestamp>-<a random UUID>, new each time", () => {
    const a = newUsageRecordKey(NOW);
    const b = newUsageRecordKey(NOW);
    expect(a).toMatch(KEY);
    expect(a.startsWith("usage/20261210030000000-")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("62.1: the Blobs store writes under the given key, and under a new key when none is given", async () => {
    const keys: string[] = [];
    const blobs: BlobsLike = { getWithMetadata: async () => null, setJSON: async (key) => { keys.push(key); return { modified: true, etag: "e1" }; } };
    const store = createBlobsUsageStore({ blobs });
    const rec: UsageRecord = { timestamp: NOW, model: "m", inputTokens: 1, outputTokens: 1, estimatedCostNanoUsd: 600, filesSha256: [], readerMode: "claude", outcome: "success", errorMessage: null };
    await store.appendRecord(rec, "usage/20261210030000000-00000000-0000-4000-8000-000000000000");
    await store.appendRecord(rec);
    expect(keys[0]).toBe("usage/20261210030000000-00000000-0000-4000-8000-000000000000");
    expect(keys[1]).toMatch(KEY);
    expect(keys[1].startsWith("usage/20261210030000000-")).toBe(true);
  });

  it("62.2: the record line names the key the store was asked to write, when the write throws and when it runs out of time", async () => {
    for (const record of ["throws", "hangs"] as const) {
      const f = failing({ record, topUp: "ok" });
      const { res, logs } = await call(f.store, BODY, "test-key-not-real", { inputTokens: 10, outputTokens: 10 });
      expect(res.status, record).toBe(200);
      const lines = logs.filter((l) => l.startsWith(RECORD_LINE));
      expect(lines, record).toHaveLength(1);
      const j = JSON.parse(lines[0].slice(RECORD_LINE.length));
      expect(Object.keys(j).sort()).toEqual(RECORD_FIELDS);
      expect(f.keys).toHaveLength(1);
      expect(j.key).toBe(f.keys[0]);
      expect(j.key).toMatch(KEY);
      expect(j).toMatchObject({ timestamp: NOW, outcome: "success", inputTokens: 10, outputTokens: 10, estimatedCostNanoUsd: estimateCostNanoUsd(10, 10) });
    }
  });

  it("62.2: a record that is written leaves no line, and its key has the same form", async () => {
    const f = failing({ record: "ok", topUp: "ok" });
    const { logs } = await call(f.store, BODY, "test-key-not-real", { inputTokens: 10, outputTokens: 10 });
    expect(logs).toEqual([]);
    expect(f.keys[0]).toMatch(KEY);
    expect(f.inner.records).toHaveLength(1);
  });

  it("62.3: the top-up line names the actual cost minus the reserved cost, when the writes throw, conflict six times, or run out of time", async () => {
    const missing = estimateCostNanoUsd(BIG.inputTokens, BIG.outputTokens) - WORST;
    expect(missing).toBeGreaterThan(0);
    for (const fail of [{ record: "ok", topUp: "throws" }, { record: "ok", topUp: "conflicts" }, { record: "hangs", topUp: "ok" }] as Fail[]) {
      const f = failing(fail);
      const { res, logs } = await call(f.store, BODY, "test-key-not-real", BIG);
      expect(res.status, JSON.stringify(fail)).toBe(200);
      const lines = logs.filter((l) => l.startsWith("usage cost top-up not written"));
      expect(lines, JSON.stringify(fail)).toEqual([`${TOPUP_LINE}{"missingNanoUsd":${missing}}`]);
    }
  });

  it("62.3: no top-up line when the actual cost is not above the reserved cost or the top-up is written", async () => {
    const small = failing({ record: "ok", topUp: "throws" });
    expect((await call(small.store, BODY, "k", { inputTokens: 10, outputTokens: 10 })).logs).toEqual([]);
    const ok = failing({ record: "ok", topUp: "ok" });
    expect((await call(ok.store, BODY, "k", BIG)).logs).toEqual([]);
    expect(ok.inner.state().reservedCostNanoUsd).toBe(estimateCostNanoUsd(BIG.inputTokens, BIG.outputTokens));
  });
});

const hex = fc.array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: 64, maxLength: 64 }).map((a) => a.join(""));
const word = fc.array(fc.constantFrom(..."ABCDEFGHJKMNPQRSTUVWXYZ23456789".split("")), { minLength: 8, maxLength: 12 }).map((a) => `W${a.join("")}`);

describe("Feature: document-intake, Property 83: A Line Not Written Names Only the Key, the Counts and the Missing Amount (Validates: Requirements 62.1, 62.2, 62.3, 62.4)", () => {
  it("any hashes, page texts, provider key, usage and failing store: the lines carry only their fields, and the answer is the same as with a working store", async () => {
    await fc.assert(
      fc.asyncProperty(
        hex, word, word,
        fc.integer({ min: 0, max: 300_000 }), fc.integer({ min: 0, max: 16_000 }),
        fc.constantFrom<Fail["record"]>("ok", "throws", "hangs"), fc.constantFrom<Fail["topUp"]>("ok", "throws", "conflicts"),
        async (sha, pageWord, keyWord, inputTokens, outputTokens, record, topUp) => {
          const text = `Invoice ${pageWord} total USD 10.00`;
          const apiKey = `sk-test-${keyWord}`;
          const body = bodyOf(sha, text);
          const usage = { inputTokens, outputTokens };
          const f = failing({ record, topUp });
          const got = await call(f.store, body, apiKey, usage);
          const ref = await call(failing({ record: "ok", topUp: "ok" }).store, body, apiKey, usage);
          expect(got.res).toEqual(ref.res);
          const worst = estimateReaderCall(body).worstCaseCostNanoUsd;
          const actual = estimateCostNanoUsd(inputTokens, outputTokens);
          for (const l of got.logs) {
            expect(l.startsWith(RECORD_LINE) || l.startsWith(TOPUP_LINE), l).toBe(true);
            for (const secret of [sha, pageWord, apiKey, keyWord, ERROR_TEXT, "conflict", "changed by another request"]) expect(l.includes(secret), `${secret} in ${l}`).toBe(false);
            if (l.startsWith(RECORD_LINE)) {
              const j = JSON.parse(l.slice(RECORD_LINE.length));
              expect(Object.keys(j).sort()).toEqual(RECORD_FIELDS);
              expect(j.key).toBe(f.keys[0]);
              expect(j.key).toMatch(KEY);
            } else {
              const j = JSON.parse(l.slice(TOPUP_LINE.length));
              expect(Object.keys(j)).toEqual(["missingNanoUsd"]);
              expect(j.missingNanoUsd).toBe(actual - worst);
            }
          }
          expect(got.logs.filter((l) => l.startsWith(RECORD_LINE))).toHaveLength(record === "ok" ? 0 : 1);
          const topUpFails = actual > worst && (topUp !== "ok" || record === "hangs");
          expect(got.logs.filter((l) => l.startsWith(TOPUP_LINE))).toHaveLength(topUpFails ? 1 : 0);
        },
      ),
      { numRuns: 60 },
    );
  });
});
