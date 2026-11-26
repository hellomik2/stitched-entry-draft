import { describe, it, expect, vi, afterEach } from "vitest";
import fc from "fast-check";
import { getStore } from "@netlify/blobs";
import { emptyUsageState, estimateCostNanoUsd, estimateReaderCall } from "../core/budget";
import type { ReaderInput } from "../core/readerContract";
import { handleReadRequest } from "./intakeService";
import type { ReaderSetup } from "./readerEnv";
import { ReaderError, type IntakeReader } from "./readerTypes";
import { createMemoryUsageStore, type UsageStore } from "./usageStore";
import { createBlobsUsageStore, dropEtagOnError, type BlobsLike } from "./usageStoreBlobs";

// Requirements 41 and 42 (agy cross-check 2: R6, R7, R8, R12). No network and no AI: the reader is a spy, the store is in memory
// or the real @netlify/blobs Store with a fake fetch (vitest sets NODE_ENV=test, so the library waits 1 ms between its retries).

const body: ReaderInput = { bundle: "b", documents: [{ docId: "inv", kind: "invoice", fileName: "a.pdf", fileSha256: "a".repeat(64), pages: [{ page: 1, width: 612, height: 792, text: "Invoice total USD 10.00", image: null }] }] };
const validOutput = { reader: "x", fields: [], transcripts: [], invoiceLineCount: null };
const invalidOutput = { reader: "x" };
const setup = (total: number): ReaderSetup => ({ mode: "claude", reason: null, caps: { total, daily: 30, perVisitorDaily: 30 }, costCapNanoUsd: 6_666_666_666, store: "netlify-blobs", storeDir: "logs", visitorSalt: "s", apiKey: "test-key-not-real" });
const worst = estimateReaderCall(body).worstCaseCostNanoUsd;
const BIG = { inputTokens: 200_000, outputTokens: 16_000 };
const actual = estimateCostNanoUsd(BIG.inputTokens, BIG.outputTokens);
const RECORD_KEYS = ["estimatedCostNanoUsd", "inputTokens", "key", "model", "outcome", "outputTokens", "timestamp"];
const EDGE = { siteID: "site", token: "tok", edgeURL: "http://edge.invalid", uncachedEdgeURL: "http://uncached.invalid" };
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

type Outcome = "valid" | "invalid" | "errorWithUsage" | "errorNoUsage";
function reader(outcome: Outcome, usage: unknown): IntakeReader & { calls: number } {
  const r = {
    name: "spy",
    calls: 0,
    async read() {
      r.calls++;
      if (outcome === "errorWithUsage") throw new ReaderError("reader failed", usage as never);
      if (outcome === "errorNoUsage") throw new ReaderError("reader failed", null);
      return { output: (outcome === "valid" ? validOutput : invalidOutput) as never, usage: usage as never };
    },
  };
  return r;
}

// An in-memory BlobsLike with the library's answer shapes. refuseRecords: a "usage/" write throws, as the library does for a PUT without a condition (Requirement 54.1), and
// is not saved. conflicts: after the first "caps-state" write (the reservation), the next writes answer { modified: false }.
// topUpStoreError: the second "caps-state" write answers { modified: true, etag: "" } (a store error, not a changed state).
type Knobs = { refuseRecords?: boolean; conflicts?: number; topUpStoreError?: boolean; initial?: unknown };
function fakeBlobs(k: Knobs = {}) {
  let n = 0;
  let state: { data: unknown; etag: string } | null = k.initial === undefined ? null : { data: k.initial, etag: "s0" };
  let conflictsLeft = k.conflicts ?? 0;
  const records: Record<string, unknown>[] = [];
  const counts = { capsWrites: 0 };
  const blobs: BlobsLike = {
    async getWithMetadata(key) {
      if (key !== "caps-state" || state === null) return null;
      return { data: structuredClone(state.data), etag: state.etag };
    },
    async setJSON(key, data, o) {
      if (key.startsWith("usage/")) {
        if (k.refuseRecords) throw new Error("store refused the record");
        records.push(structuredClone(data) as Record<string, unknown>);
        return { modified: true, etag: `r${++n}` };
      }
      counts.capsWrites++;
      if (counts.capsWrites > 1 && conflictsLeft > 0) {
        conflictsLeft--;
        return { modified: false };
      }
      if (k.topUpStoreError && counts.capsWrites === 2) return { modified: true, etag: "" };
      if (o?.onlyIfNew && state !== null) return { modified: false };
      if (o?.onlyIfMatch && (state === null || state.etag !== o.onlyIfMatch)) return { modified: false };
      state = { data: structuredClone(data), etag: `s${++n}` };
      return { modified: true, etag: state.etag };
    },
  };
  return { blobs, records, counts, ledger: () => state?.data as { totalCalls: number; reservedCostNanoUsd?: number } };
}

// A fake Blobs edge for the real library: GET answers the saved body with its etag or 404; PUT honours if-none-match and if-match
// (412). usagePutStatus: a PUT of a "usage/" key answers that status. capsPut503WithEtag: a PUT of "caps-state" answers 503 with an ETag.
function edge(k: { usagePutStatus?: number; capsPut503WithEtag?: boolean }) {
  const saved = new Map<string, { body: string; etag: string }>();
  let n = 0;
  const seen = { usageSaved: 0 };
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const key = decodeURIComponent(new URL(String(url)).pathname);
    const method = (init?.method ?? "get").toLowerCase();
    const h = new Headers(init?.headers);
    const isCaps = key.endsWith("/caps-state");
    const cur = saved.get(key);
    if (method === "get") return cur ? new Response(cur.body, { status: 200, headers: { etag: cur.etag } }) : new Response("not found", { status: 404 });
    if (method !== "put") return new Response("", { status: 405 });
    if (isCaps && k.capsPut503WithEtag) return new Response("unavailable", { status: 503, headers: { etag: '"proxy-etag"' } });
    if (!isCaps && k.usagePutStatus) return new Response("refused", { status: k.usagePutStatus });
    if (h.get("if-none-match") === "*" && cur) return new Response("", { status: 412 });
    if (h.has("if-match") && (!cur || cur.etag !== h.get("if-match"))) return new Response("", { status: 412 });
    const etag = `"e${++n}"`;
    saved.set(key, { body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""), etag });
    if (!isCaps) seen.usageSaved++;
    return new Response("", { status: 200, headers: { etag } });
  };
  return { fetch, seen };
}

// The same adapter as openNetlifyBlobs, over the real library with the given fetch.
function blobsOver(fetch: unknown): BlobsLike {
  const store = getStore({ name: "document-intake-usage", consistency: "strong", ...EDGE, fetch } as never);
  return {
    getWithMetadata: (key) => store.getWithMetadata(key, { type: "json" }),
    setJSON: (key, data, o) => store.setJSON(key, data, o?.onlyIfMatch ? { onlyIfMatch: o.onlyIfMatch } : o?.onlyIfNew ? { onlyIfNew: true } : {}),
  };
}

async function call(store: UsageStore, r: IntakeReader, opts: { total?: number; i?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const logs: string[] = [];
  const res = await handleReadRequest({
    setup: setup(opts.total ?? 5), store, fakeStore: createMemoryUsageStore(), readers: { claude: r },
    nowIso: "2026-12-10T03:00:00.000Z", ip: `203.0.113.${opts.i ?? 1}`, bodyBytes: 500, body, log: (m) => logs.push(m), sleep: opts.sleep,
  });
  return { res, logs };
}
const recordLines = (logs: string[]) => logs.filter((l) => l.startsWith("usage record not written: ")).map((l) => JSON.parse(l.slice("usage record not written: ".length)));
const sleeper = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
};

describe("Feature: document-intake, Property 57: A Paid Call Leaves a Record or a Log Line (Validates: Requirements 41.1, 41.2, 41.3)", () => {
  it("41.1 appendRecord throws unless the store saves the write (Requirement 54.1)", async () => {
    const rec = { timestamp: "2026-12-10T03:00:00.000Z", model: "m", inputTokens: 1, outputTokens: 1, estimatedCostNanoUsd: 600, filesSha256: [], readerMode: "claude" as const, outcome: "success" as const, errorMessage: null };
    for (const answer of [{ modified: false }]) {
      const store = createBlobsUsageStore({ blobs: { getWithMetadata: async () => null, setJSON: async () => answer } });
      await expect(store.appendRecord(rec)).rejects.toThrow("usage record write was not confirmed by the store; not written");
    }
    const ok = createBlobsUsageStore({ blobs: { getWithMetadata: async () => null, setJSON: async () => ({ modified: true, etag: "e1" }) } });
    await expect(ok.appendRecord(rec)).resolves.toBeUndefined();
  });

  it("41.1, 41.2 a record PUT answered 403 by the real library: 200 for the person and one log line with the record per call", async () => {
    const e = edge({ usagePutStatus: 403 });
    const r = reader("valid", { inputTokens: 100, outputTokens: 100 });
    const all: string[] = [];
    for (const i of [1, 2]) {
      const { res, logs } = await call(createBlobsUsageStore({ blobs: blobsOver(e.fetch) }), r, { i });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      all.push(...logs);
    }
    expect(r.calls).toBe(2);
    expect(e.seen.usageSaved).toBe(0);
    const lines = recordLines(all);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(RECORD_KEYS);
      expect([l.outcome, l.inputTokens, l.outputTokens, l.estimatedCostNanoUsd]).toEqual(["success", 100, 100, estimateCostNanoUsd(100, 100)]);
    }
    expect(all.some((l) => l.includes("a".repeat(64)) || l.includes("Invoice"))).toBe(false);
  });

  it("41.2 refused records of a reader error and of a cap refusal are logged with their outcome", async () => {
    const f1 = fakeBlobs({ refuseRecords: true });
    const a = await call(createBlobsUsageStore({ blobs: f1.blobs }), reader("errorWithUsage", { inputTokens: 100, outputTokens: 100 }));
    expect(a.res.status).toBe(502);
    expect(recordLines(a.logs).map((l) => l.outcome)).toEqual(["error"]);
    const f2 = fakeBlobs({ refuseRecords: true, initial: { ...emptyUsageState(), totalCalls: 1 } });
    const b = await call(createBlobsUsageStore({ blobs: f2.blobs }), reader("valid", { inputTokens: 100, outputTokens: 100 }), { total: 1 });
    expect(b.res.status).toBe(429);
    expect(recordLines(b.logs).map((l) => l.outcome)).toEqual(["cap-exceeded"]);
  });

  it("41.3 token counts that are not non-negative safe integers: no throw, one record at the reserved worst case, no top-up", async () => {
    const bad = [{ inputTokens: 1.5, outputTokens: 10 }, { inputTokens: undefined, outputTokens: 10 }, { inputTokens: -1, outputTokens: 10 }, { inputTokens: 100, outputTokens: 2 ** 53 }];
    for (const usage of bad) {
      for (const [outcome, status] of [["valid", 200], ["invalid", 502], ["errorWithUsage", 502]] as const) {
        const f = fakeBlobs();
        const { res } = await call(createBlobsUsageStore({ blobs: f.blobs }), reader(outcome, usage));
        expect(res.status).toBe(status);
        expect(f.records).toHaveLength(1);
        expect([f.records[0].inputTokens, f.records[0].outputTokens, f.records[0].estimatedCostNanoUsd]).toEqual([null, null, worst]);
        expect(f.ledger().reservedCostNanoUsd).toBe(worst);
      }
    }
  });

  it("Property 57: for any outcome, token counts and record store, the answer is unchanged and exactly one record or one log line is left", async () => {
    const tokens = fc.oneof(fc.integer({ min: 0, max: 50_000 }), fc.constantFrom(1.5, -1, undefined, 2 ** 53));
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Outcome>("valid", "invalid", "errorWithUsage", "errorNoUsage"), tokens, tokens, fc.boolean(), async (outcome, inputTokens, outputTokens, refuse) => {
        const f = fakeBlobs({ refuseRecords: refuse });
        const { res, logs } = await call(createBlobsUsageStore({ blobs: f.blobs }), reader(outcome, { inputTokens, outputTokens }));
        const ref = await call(createBlobsUsageStore({ blobs: fakeBlobs().blobs }), reader(outcome, { inputTokens: 100, outputTokens: 100 }));
        expect(res.status).toBe(outcome === "valid" ? 200 : 502);
        expect(res).toEqual(ref.res);
        const lines = recordLines(logs);
        expect(f.records.length + lines.length).toBe(1);
        const rec = f.records[0] ?? lines[0];
        // Requirement 56.1: counts the call can have (output within the call's max_tokens, input + output within the 1,000,000-token context window)
        const expected = outcome === "errorNoUsage" ? null : isCount(inputTokens) && isCount(outputTokens) && outputTokens <= estimateReaderCall(body).outputTokens && inputTokens + outputTokens <= 1_000_000 ? estimateCostNanoUsd(inputTokens, outputTokens) : worst;
        expect(rec.estimatedCostNanoUsd).toBe(expected);
      }),
      { numRuns: 40 },
    );
  });
});

async function topUpRun(k: number, extra: Knobs = {}) {
  const f = fakeBlobs({ conflicts: k, ...extra });
  const s = sleeper();
  const { res, logs } = await call(createBlobsUsageStore({ blobs: f.blobs }), reader("valid", BIG), { sleep: s.sleep });
  return { f, s, res, logs };
}
function expectTopUp(k: number, run: Awaited<ReturnType<typeof topUpRun>>) {
  expect(run.res.status).toBe(200);
  const notWritten = run.logs.filter((l) => l.startsWith("usage cost top-up not written: ")).length;
  if (k <= 5) {
    expect([run.f.ledger().reservedCostNanoUsd, run.s.waits.length, run.f.counts.capsWrites, notWritten]).toEqual([actual, k, 1 + (k + 1), 0]);
  } else {
    expect([run.f.ledger().reservedCostNanoUsd, run.s.waits.length, run.f.counts.capsWrites, notWritten]).toEqual([worst, 5, 7, 1]);
  }
  run.s.waits.forEach((ms, j) => {
    const n = j + 2; // the wait before try n
    expect(ms).toBeGreaterThanOrEqual(50 * (n - 1));
    expect(ms).toBeLessThan(100 * (n - 1));
  });
}

describe("Feature: document-intake, Property 58: The Ledger Keeps the Actual Cost After Conflicts (Validates: Requirements 42.1)", () => {
  it("42.1 after k = 0 to 6 changed states the top-up waits and tries again, up to 6 tries", async () => {
    for (let k = 0; k <= 6; k++) expectTopUp(k, await topUpRun(k));
  });

  it("42.1 a store error that is not a changed state ends the top-up after one try", async () => {
    const run = await topUpRun(0, { topUpStoreError: true });
    expect(run.res.status).toBe(200);
    expect([run.f.counts.capsWrites, run.s.waits.length, run.logs.filter((l) => l.startsWith("usage cost top-up not written: ")).length]).toEqual([2, 0, 1]);
  });

  it("Property 58: for any k from 0 to 8 changed states, the ledger ends at the actual cost (k <= 5) or at the reservation with one log line", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 8 }), async (k) => expectTopUp(k, await topUpRun(k))), { numRuns: 30 });
  });
});

describe("Feature: document-intake, Requirement 42.2: a store error is judged by its status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { netlifyBlobsContext?: string }).netlifyBlobsContext;
  });

  it("42.2 dropEtagOnError drops the etag of an answer that is not 2xx and keeps everything else", async () => {
    const base = (status: number) => async () => new Response("err", { status, headers: { etag: '"proxy"', "x-other": "1" } });
    const a = await dropEtagOnError(base(503))("http://edge.invalid/x");
    expect([a.status, a.headers.get("etag"), a.headers.get("x-other"), await a.text()]).toEqual([503, null, "1", "err"]);
    expect((await dropEtagOnError(base(412))("http://edge.invalid/x")).headers.get("etag")).toBeNull();
    expect((await dropEtagOnError(base(200))("http://edge.invalid/x")).headers.get("etag")).toBe('"proxy"');
  });

  it("42.2 the real library with dropEtagOnError: a 503 with an ETag on the cap state write never reaches the reader", async () => {
    const e = edge({ capsPut503WithEtag: true });
    const r = reader("valid", { inputTokens: 100, outputTokens: 100 });
    for (const i of [1, 2, 3, 4]) {
      const { res } = await call(createBlobsUsageStore({ blobs: blobsOver(dropEtagOnError(e.fetch)) }), r, { total: 1, i });
      expect(res.status).toBe(503);
    }
    expect(r.calls).toBe(0);
  });

  it("42.2 createBlobsUsageStore() opens the store with dropEtagOnError, as on Netlify", async () => {
    (globalThis as { netlifyBlobsContext?: string }).netlifyBlobsContext = Buffer.from(JSON.stringify(EDGE)).toString("base64");
    const e = edge({ capsPut503WithEtag: true });
    vi.stubGlobal("fetch", e.fetch);
    const r = reader("valid", { inputTokens: 100, outputTokens: 100 });
    for (const i of [1, 2, 3, 4]) {
      const { res } = await call(createBlobsUsageStore(), r, { total: 1, i });
      expect(res.status).toBe(503);
    }
    expect(r.calls).toBe(0);
  });
});
