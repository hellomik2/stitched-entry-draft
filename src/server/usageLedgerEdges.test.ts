import { describe, it, expect, vi, afterEach } from "vitest";
import fc from "fast-check";
import { estimateCostNanoUsd, estimateReaderCall } from "../core/budget";
import type { ReaderInput } from "../core/readerContract";
import { handleReadRequest } from "./intakeService";
import type { ReaderSetup } from "./readerEnv";
import { ReaderError, type IntakeReader, type UsageRecord } from "./readerTypes";
import { createMemoryUsageStore, type UsageStore } from "./usageStore";
import { createBlobsUsageStore, type BlobsLike } from "./usageStoreBlobs";
import { createClaudeReader } from "./claudeReader";

// Requirements 54, 55 and 56 (agy cross-check 3: R14, R16, R17, R18). No network and no AI: the readers are spies or the real
// createClaudeReader with a fake SDK client; the store is in memory, or the real @netlify/blobs Store opened by
// createBlobsUsageStore() with a fake Blobs context and fetch, as on Netlify (vitest sets NODE_ENV=test, so the library waits
// 1 ms between its retries).

const body: ReaderInput = { bundle: "b", documents: [{ docId: "inv", kind: "invoice", fileName: "a.pdf", fileSha256: "a".repeat(64), pages: [{ page: 1, width: 612, height: 792, text: "Invoice total USD 10.00", image: null }] }] };
const validOutput = { reader: "x", fields: [], transcripts: [], invoiceLineCount: null };
const invalidOutput = { reader: "x" };
const setup = (total = 5): ReaderSetup => ({ mode: "claude", reason: null, caps: { total, daily: 30, perVisitorDaily: 30 }, costCapNanoUsd: 6_666_666_666, store: "netlify-blobs", storeDir: "logs", visitorSalt: "s", apiKey: "test-key-not-real" });
const estimate = estimateReaderCall(body);
const worst = estimate.worstCaseCostNanoUsd;
const ROOM = estimate.outputTokens; // the max_tokens of the call (16,000 for this body)
const CONTEXT = 1_000_000; // Requirement 56.1: the context window of Claude Haiku 5.5
const BIG = { inputTokens: 200_000, outputTokens: 16_000 }; // a usage the call can have, above the reserved worst case
const RECORD_LINE = "usage record not written: ";
const TOPUP_LINE = "usage cost top-up not written";
const EDGE = { siteID: "site", token: "tok", edgeURL: "http://edge.invalid", uncachedEdgeURL: "http://uncached.invalid" };
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const canHave = (i: unknown, o: unknown) => isCount(i) && isCount(o) && o <= ROOM && i + o <= CONTEXT;

type Outcome = "valid" | "invalid" | "errorWithUsage";
function spy(outcome: Outcome, usage: unknown, onEnd?: () => void): IntakeReader & { calls: number } {
  const r = {
    name: "spy",
    calls: 0,
    async read() {
      r.calls++;
      onEnd?.();
      if (outcome === "errorWithUsage") throw new ReaderError("reader failed", usage as never);
      return { output: (outcome === "valid" ? validOutput : invalidOutput) as never, usage: usage as never };
    },
  };
  return r;
}

async function call(store: UsageStore, r: IntakeReader, extra: Record<string, unknown> = {}, i = 1) {
  const logs: string[] = [];
  const res = await handleReadRequest({
    setup: setup(), store, fakeStore: createMemoryUsageStore(), readers: { claude: r },
    nowIso: "2026-12-10T03:00:00.000Z", ip: `203.0.113.${i}`, bodyBytes: 500, body, log: (m: string) => logs.push(m), sleep: async () => {},
    ...extra,
  } as never);
  return { res, logs };
}
const recordLines = (logs: string[]) => logs.filter((l) => l.startsWith(RECORD_LINE));

// ---------------- Requirement 54 (R14): the record is written without a condition ----------------

// A fake Blobs edge for the real library. GET answers the saved body with its etag or 404; PUT honours if-none-match: * and
// if-match (412). mode(n) decides the n-th record PUT: "normal" (saved, 200 with an ETag), "commit-503" (saved, answered 503),
// "commit-cut" (saved, the connection is lost), "200-no-etag" (saved, 200 without an ETag), "403" and "503" (not saved),
// "503-etag" (not saved, 503 with an ETag).
type PutMode = "normal" | "commit-503" | "commit-cut" | "200-no-etag" | "403" | "503" | "503-etag";
function edge(mode: (n: number) => PutMode) {
  const saved = new Map<string, { body: string; etag: string }>();
  let v = 0;
  // recordsSaved: the number of different record keys the store holds (a PUT sent again lands on the same key)
  const seen = {
    recordPuts: 0,
    recordConditions: [] as string[],
    get recordsSaved() {
      return [...saved.keys()].filter((k) => !k.endsWith("/caps-state")).length;
    },
  };
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const key = decodeURIComponent(new URL(String(url)).pathname);
    const method = (init?.method ?? "get").toLowerCase();
    const h = new Headers(init?.headers);
    const isCaps = key.endsWith("/caps-state");
    const cur = saved.get(key);
    if (method === "get") return cur ? new Response(cur.body, { status: 200, headers: { etag: cur.etag } }) : new Response("not found", { status: 404 });
    if (method !== "put") return new Response("", { status: 405 });
    let m: PutMode = "normal";
    if (!isCaps) {
      seen.recordPuts++;
      m = mode(seen.recordPuts);
      for (const name of ["if-none-match", "if-match"]) if (h.has(name)) seen.recordConditions.push(name);
      if (m === "403") return new Response("refused", { status: 403 });
      if (m === "503") return new Response("unavailable", { status: 503 });
      if (m === "503-etag") return new Response("unavailable", { status: 503, headers: { etag: '"proxy-etag"' } });
    }
    if (h.get("if-none-match") === "*" && cur) return new Response("", { status: 412, headers: { etag: cur.etag } });
    if (h.has("if-match") && (!cur || cur.etag !== h.get("if-match"))) return new Response("", { status: 412 });
    const etag = `"v${++v}"`;
    saved.set(key, { body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""), etag });
    if (m === "commit-503") return new Response("unavailable", { status: 503 });
    if (m === "commit-cut") throw new TypeError("fetch failed: socket hang up (after the store saved the record)");
    if (m === "200-no-etag") return new Response("", { status: 200 });
    return new Response("", { status: 200, headers: { etag } });
  };
  return { fetch, seen };
}

function onNetlify(e: ReturnType<typeof edge>) {
  (globalThis as { netlifyBlobsContext?: string }).netlifyBlobsContext = Buffer.from(JSON.stringify(EDGE)).toString("base64");
  vi.stubGlobal("fetch", e.fetch);
}

describe("Feature: document-intake, Property 73: A Saved Record Is Counted Once (Validates: Requirements 54.1, 54.2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { netlifyBlobsContext?: string }).netlifyBlobsContext;
  });

  const rec: UsageRecord = { timestamp: "2026-12-10T03:00:00.000Z", model: "m", inputTokens: 1, outputTokens: 1, estimatedCostNanoUsd: 600, filesSha256: [], readerMode: "claude", outcome: "success", errorMessage: null };

  it("54.1 appendRecord writes the record without a condition and counts modified: true as saved, with or without an etag", async () => {
    const calls: unknown[] = [];
    for (const answer of [{ modified: true, etag: "e1" }, { modified: true, etag: "" }, { modified: true }]) {
      const blobs: BlobsLike = { getWithMetadata: async () => null, setJSON: async (key, _data, options) => { calls.push([key.startsWith("usage/"), options ?? null]); return answer; } };
      await expect(createBlobsUsageStore({ blobs }).appendRecord(rec)).resolves.toBeUndefined();
    }
    for (const [key, options] of calls as [boolean, { onlyIfNew?: boolean; onlyIfMatch?: string } | null][]) {
      expect(key).toBe(true);
      expect(options?.onlyIfNew ?? false).toBe(false);
      expect(options?.onlyIfMatch ?? null).toBeNull();
    }
  });

  it("54.1 appendRecord throws when the store answers modified: false or the write throws", async () => {
    const answers: BlobsLike["setJSON"][] = [async () => ({ modified: false }), async () => { throw new Error("BlobsInternalError: 403"); }];
    for (const setJSON of answers) {
      await expect(createBlobsUsageStore({ blobs: { getWithMetadata: async () => null, setJSON } }).appendRecord(rec)).rejects.toThrow("usage record write was not confirmed by the store; not written");
    }
  });

  const table: [PutMode, number, number][] = [
    // first record PUT, records saved, "usage record not written" lines
    ["normal", 1, 0],
    ["commit-503", 1, 0],
    ["commit-cut", 1, 0],
    ["200-no-etag", 1, 0],
    ["403", 0, 1],
    ["503", 0, 1],
    ["503-etag", 0, 1],
  ];
  for (const [mode, records, lines] of table) {
    it(`54.2 through createBlobsUsageStore() as on Netlify, a record PUT "${mode}": ${records} record and ${lines} line, no condition on the record PUT`, async () => {
      const always = mode === "403" || mode === "503" || mode === "503-etag";
      const e = edge((n) => (always || n === 1 ? mode : "normal"));
      onNetlify(e);
      const r = spy("valid", { inputTokens: 100, outputTokens: 100 });
      const { res, logs } = await call(createBlobsUsageStore(), r);
      expect([res.status, r.calls]).toEqual([200, 1]);
      expect([e.seen.recordsSaved, recordLines(logs).length]).toEqual([records, lines]);
      expect(e.seen.recordConditions).toEqual([]);
    });
  }

  it("54.2 a cap-exceeded record answered 403 still gives one line", async () => {
    const e = edge((n) => (n === 2 ? "403" : "normal"));
    onNetlify(e);
    const r = spy("valid", { inputTokens: 100, outputTokens: 100 });
    const store = () => createBlobsUsageStore();
    const first = await call(store(), r, { setup: setup(1) });
    const second = await call(store(), r, { setup: setup(1) }, 2);
    expect([first.res.status, second.res.status, r.calls, e.seen.recordsSaved]).toEqual([200, 429, 1, 1]);
    expect(recordLines(second.logs).map((l) => JSON.parse(l.slice(RECORD_LINE.length)).outcome)).toEqual(["cap-exceeded"]);
  });

  it("Property 73: for any calls and record PUT answers, each call leaves one saved record and no line, or no record and one line", async () => {
    const modes = fc.constantFrom<PutMode>("normal", "commit-503", "commit-cut", "200-no-etag", "403", "503", "503-etag");
    await fc.assert(
      fc.asyncProperty(fc.array(modes, { minLength: 1, maxLength: 4 }), async (perCall) => {
        let current: PutMode = "normal";
        let putsInCall = 0;
        const e = edge(() => {
          putsInCall++;
          const always = current === "403" || current === "503" || current === "503-etag";
          return always || putsInCall === 1 ? current : "normal";
        });
        onNetlify(e);
        const r = spy("valid", { inputTokens: 100, outputTokens: 100 });
        let lines = 0;
        for (let i = 0; i < perCall.length; i++) {
          current = perCall[i];
          putsInCall = 0;
          const { res, logs } = await call(createBlobsUsageStore(), r, {}, i + 1);
          expect(res.status).toBe(200);
          lines += recordLines(logs).length;
        }
        const refused = perCall.filter((m) => m === "403" || m === "503" || m === "503-etag").length;
        expect([e.seen.recordsSaved, lines]).toEqual([perCall.length - refused, refused]);
        expect(e.seen.recordConditions).toEqual([]);
      }),
      { numRuns: 25 },
    );
  });
});

// ---------------- Requirement 55 (R16): the store writes after the reader stop in time ----------------

// A memory store whose calls after the reader answer after `after` ms, or never. The reservation (the calls before the reader)
// answers at once. events: the order of the calls.
function slowStore(after: number | "never") {
  const inner = createMemoryUsageStore();
  const events: string[] = [];
  const state = { readerDone: false };
  const later = <T>(f: () => Promise<T>): Promise<T> => {
    if (!state.readerDone) return f();
    if (after === "never") return new Promise<T>(() => {});
    return new Promise<T>((resolve, reject) => setTimeout(() => f().then(resolve, reject), after));
  };
  const store: UsageStore = {
    readState: () => { events.push("readState"); return later(() => inner.readState()); },
    writeState: (s) => { events.push("writeState"); return later(() => inner.writeState(s)); },
    appendRecord: (r) => { events.push("appendRecord"); return later(() => inner.appendRecord(r)); },
  };
  return { store, events, inner, end: () => { state.readerDone = true; } };
}

async function timed(after: number | "never", usage: unknown, outcome: Outcome, postReadStoreMs: number) {
  const s = slowStore(after);
  let readerEnd = 0;
  const r = spy(outcome, usage, () => { s.end(); readerEnd = Date.now(); });
  const guard = new Promise<"no answer">((resolve) => setTimeout(() => resolve("no answer"), 3000));
  const got = await Promise.race([call(s.store, r, { postReadStoreMs }), guard]);
  return { s, got, afterReaderMs: Date.now() - readerEnd };
}

describe("Feature: document-intake, Property 74: The Store Writes After the Reader End in Time (Validates: Requirements 55.1, 55.2)", () => {
  it("55.1 after the reader the record is written before the top-up", async () => {
    for (const outcome of ["valid", "invalid", "errorWithUsage"] as const) {
      const { s, got } = await timed(0, BIG, outcome, 1000);
      expect(got).not.toBe("no answer");
      // events: readState, writeState (the reservation), then appendRecord, then the top-up's readState and writeState
      expect(s.events).toEqual(["readState", "writeState", "appendRecord", "readState", "writeState"]);
      expect(s.inner.records).toHaveLength(1);
      expect(s.inner.state().reservedCostNanoUsd).toBe(estimateCostNanoUsd(BIG.inputTokens, BIG.outputTokens));
    }
  });

  it("55.2 a store that does not answer after the reader: the answer comes within the post-read time, with both lines", { timeout: 10000 }, async () => {
    const { s, got, afterReaderMs } = await timed("never", BIG, "valid", 60);
    expect(got).not.toBe("no answer");
    if (got === "no answer") return;
    expect(got.res.status).toBe(200);
    expect(afterReaderMs).toBeLessThan(60 + 500);
    expect(recordLines(got.logs)).toHaveLength(1);
    expect(got.logs.filter((l) => l.startsWith(TOPUP_LINE))).toHaveLength(1);
    // the record went first; no time was left for the top-up, so it never wrote the state
    expect(s.events.slice(0, 3)).toEqual(["readState", "writeState", "appendRecord"]);
    expect(s.events.filter((e) => e === "writeState")).toHaveLength(1);
  });

  it("55.2 a store that does not answer after the reader, no top-up needed: the answer comes in time with the record line", { timeout: 10000 }, async () => {
    for (const outcome of ["valid", "invalid", "errorWithUsage"] as const) {
      const { got, afterReaderMs } = await timed("never", { inputTokens: 100, outputTokens: 100 }, outcome, 60);
      expect(got).not.toBe("no answer");
      if (got === "no answer") return;
      expect(got.res.status).toBe(outcome === "valid" ? 200 : 502);
      expect(afterReaderMs).toBeLessThan(60 + 500);
      expect(recordLines(got.logs)).toHaveLength(1);
      expect(got.logs.filter((l) => l.startsWith(TOPUP_LINE))).toHaveLength(0);
    }
  });

  it("55.2 a store that answers in time is not cut", async () => {
    const { s, got } = await timed(5, BIG, "valid", 1000);
    expect(got).not.toBe("no answer");
    if (got === "no answer") return;
    expect(got.logs).toEqual([]);
    expect(s.inner.records).toHaveLength(1);
    expect(s.inner.state().reservedCostNanoUsd).toBe(estimateCostNanoUsd(BIG.inputTokens, BIG.outputTokens));
  });

  it("Property 74: for any store delay after the reader, the answer comes in time and the record and the top-up are each saved or logged", { timeout: 30000 }, async () => {
    const P = 40;
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<number | "never">(0, 5, 15, 30, 60, 120, "never"), fc.boolean(), fc.constantFrom<Outcome>("valid", "invalid", "errorWithUsage"), async (after, big, outcome) => {
        const usage = big ? BIG : { inputTokens: 100, outputTokens: 100 };
        const { s, got, afterReaderMs } = await timed(after, usage, outcome, P);
        expect(got).not.toBe("no answer");
        if (got === "no answer") return;
        expect(afterReaderMs).toBeLessThan(P + 300);
        const lines = recordLines(got.logs).length;
        expect(lines).toBeLessThanOrEqual(1);
        if (lines === 0) expect(s.inner.records).toHaveLength(1);
        const firstTopUpRead = s.events.indexOf("readState", 2);
        if (firstTopUpRead !== -1) expect(s.events.indexOf("appendRecord")).toBeLessThan(firstTopUpRead);
        if (big && !got.logs.some((l) => l.startsWith(TOPUP_LINE))) expect(s.inner.state().reservedCostNanoUsd).toBe(estimateCostNanoUsd(BIG.inputTokens, BIG.outputTokens));
        if (!big) expect(got.logs.filter((l) => l.startsWith(TOPUP_LINE))).toHaveLength(0);
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------- Requirement 56 (R17, R18): a usage the call cannot have, and an answer without usage ----------------

function recordingStore() {
  const s = createMemoryUsageStore();
  return s;
}

describe("Feature: document-intake, Property 75: A Usage the Call Cannot Have Does Not Move the Ledger (Validates: Requirements 56.1, 41.3, 24.3)", () => {
  const cannot: [string, { inputTokens: number; outputTokens: number }][] = [
    ["1e12 input tokens", { inputTokens: 1_000_000_000_000, outputTokens: 0 }],
    ["9e15 input tokens", { inputTokens: 9_000_000_000_000_000, outputTokens: 0 }],
    ["2^53 - 1 output tokens", { inputTokens: 100, outputTokens: Number.MAX_SAFE_INTEGER }],
    ["one output token over the room", { inputTokens: 100, outputTokens: ROOM + 1 }],
    ["input and output over the context window", { inputTokens: CONTEXT - 100, outputTokens: 101 }],
  ];
  for (const [label, usage] of cannot) {
    it(`56.1 ${label}: no throw, the record at the reserved worst case, no top-up, the next request is answered`, async () => {
      for (const [outcome, status] of [["valid", 200], ["invalid", 502], ["errorWithUsage", 502]] as const) {
        const s = recordingStore();
        const { res, logs } = await call(s, spy(outcome, usage));
        expect(res.status).toBe(status);
        expect(s.records).toHaveLength(1);
        expect([s.records[0].inputTokens, s.records[0].outputTokens, s.records[0].estimatedCostNanoUsd]).toEqual([null, null, worst]);
        expect(s.state().reservedCostNanoUsd).toBe(worst);
        expect(logs).toEqual([]);
        const next = await call(s, spy("valid", { inputTokens: 100, outputTokens: 100 }), {}, 2);
        expect(next.res.status).toBe(200);
        expect(s.state().reservedCostNanoUsd).toBe(2 * worst);
      }
    });
  }

  it("56.1 the largest usage the call can have is recorded and topped up as today", async () => {
    const usage = { inputTokens: CONTEXT - ROOM, outputTokens: ROOM };
    const s = recordingStore();
    const { res } = await call(s, spy("valid", usage));
    expect(res.status).toBe(200);
    const actual = estimateCostNanoUsd(usage.inputTokens, usage.outputTokens);
    expect([s.records[0].inputTokens, s.records[0].outputTokens, s.records[0].estimatedCostNanoUsd]).toEqual([usage.inputTokens, usage.outputTokens, actual]);
    expect(s.state().reservedCostNanoUsd).toBe(actual);
  });

  it("Property 75: for any usage and outcome, the record and the ledger follow Requirement 56.1", async () => {
    const count = (max: number) => fc.oneof(fc.integer({ min: 0, max }), fc.constantFrom<unknown>(1_000_000_000_000, 9_000_000_000_000_000, Number.MAX_SAFE_INTEGER, 1.5, -1, undefined));
    await fc.assert(
      fc.asyncProperty(count(1_200_000), count(40_000), fc.constantFrom<Outcome>("valid", "invalid", "errorWithUsage"), async (inputTokens, outputTokens, outcome) => {
        const s = recordingStore();
        const { res } = await call(s, spy(outcome, { inputTokens, outputTokens }));
        expect(res.status).toBe(outcome === "valid" ? 200 : 502);
        expect(s.records).toHaveLength(1);
        const ok = canHave(inputTokens, outputTokens);
        const actual = ok ? estimateCostNanoUsd(inputTokens as number, outputTokens as number) : worst;
        expect(s.records[0].estimatedCostNanoUsd).toBe(actual);
        expect([s.records[0].inputTokens, s.records[0].outputTokens]).toEqual(ok ? [inputTokens, outputTokens] : [null, null]);
        expect(s.state().reservedCostNanoUsd).toBe(Math.max(worst, actual));
      }),
      { numRuns: 80 },
    );
  });
});

describe("Feature: document-intake, Requirement 56.2: an SDK answer without usage, or without a content list", () => {
  const VALID_TEXT = JSON.stringify({ transcripts: [], fields: [], invoiceLineCount: null, packingListLineCount: null });
  const reader = (answer: unknown) => createClaudeReader({ apiKey: "test-key-not-real", client: { messages: { create: async () => answer as never } } });
  const cases: [string, unknown, number, string, (number | null)[]][] = [
    // label, SDK answer, status, message, [record inputTokens, outputTokens, cost]
    ["no usage", { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }, 502, "The reader answer was not valid", [null, null, worst]],
    ["usage null", { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: null }, 502, "The reader answer was not valid", [null, null, worst]],
    ["usage not an object", { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: "x" }, 502, "The reader answer was not valid", [null, null, worst]],
    ["content not a list", { stop_reason: "end_turn", content: null, usage: { input_tokens: 1000, output_tokens: 200 } }, 502, "The AI reader returned no answer.", [1000, 200, estimateCostNanoUsd(1000, 200)]],
    ["the answer is null", null, 502, "The AI reader returned no answer.", [null, null, worst]],
    ["a valid answer without usage", { stop_reason: "end_turn", content: [{ type: "text", text: VALID_TEXT }] }, 200, "", [null, null, worst]],
  ];
  for (const [label, answer, status, message, recordCounts] of cases) {
    it(`56.2 ${label}: answered ${status}, the record has a cost, the ledger stays at the reservation`, async () => {
      const s = recordingStore();
      const { res, logs } = await call(s, reader(answer));
      expect(res.status).toBe(status);
      if (message) expect(String(res.json.message)).toContain(message);
      expect(s.records).toHaveLength(1);
      expect([s.records[0].inputTokens, s.records[0].outputTokens, s.records[0].estimatedCostNanoUsd]).toEqual(recordCounts);
      expect(s.state().totalCalls).toBe(1);
      expect(s.state().reservedCostNanoUsd).toBe(worst);
      expect(logs).toEqual([]);
    });
  }

  it("56.2 the reader throws only a ReaderError after the SDK answered, with null counts when usage is missing", async () => {
    for (const answer of [
      { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: null },
      { stop_reason: "end_turn", content: null, usage: { input_tokens: 1000, output_tokens: 200 } },
      { stop_reason: "end_turn", content: "x", usage: {} },
      null,
    ]) {
      const e = await reader(answer).read(body).then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(ReaderError);
      const u = (e as ReaderError).usage;
      expect(u).not.toBeNull();
      const raw = (answer as { usage?: unknown } | null)?.usage;
      const hasCounts = typeof raw === "object" && raw !== null && "input_tokens" in raw;
      expect([u?.inputTokens, u?.outputTokens]).toEqual(hasCounts ? [1000, 200] : [null, null]);
    }
  });
});
