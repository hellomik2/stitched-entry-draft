import { describe, it, expect, beforeEach } from "vitest";
import type { UsageState, Caps } from "../core/budget";
import { emptyUsageState, estimateCostNanoUsd, estimateReaderCall } from "../core/budget";
import type { ReaderInput, ReaderOutput } from "../core/readerContract";
import { intakeConfig } from "../core/intakeConfig";
import {
  handleReadRequest,
  handleStatusRequest,
  type ReadDeps,
} from "./intakeService";
import type { UsageRecord, IntakeReader } from "./readerTypes";
import { ReaderError } from "./readerTypes";
import type { ReaderSetup } from "./readerEnv";
import type { UsageStore } from "./usageStore";
import { createMemoryUsageStore } from "./usageStore";
import { visitorKey } from "./visitorKey";

// Create a spy store that tracks events
function createSpyStore(
  initial?: UsageState,
): UsageStore & { events: string[]; getRecords: () => UsageRecord[] } {
  const innerStore = createMemoryUsageStore(initial);
  const events: string[] = [];

  return {
    events,
    getRecords: () => innerStore.records,

    async readState() {
      events.push("readState");
      return innerStore.readState();
    },

    async writeState(s: UsageState) {
      events.push("writeState");
      return innerStore.writeState(s);
    },

    async appendRecord(r: UsageRecord) {
      events.push("appendRecord");
      return innerStore.appendRecord(r);
    },
  };
}

// Create a valid test input (two documents: one text, one image)
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
            text: "Invoice number: INV-123",
            image: null,
          },
        ],
      },
      {
        docId: "doc2",
        kind: "packingList",
        fileName: "packing.pdf",
        fileSha256: "b".repeat(64),
        pages: [
          {
            page: 1,
            width: 612,
            height: 792,
            text: null,
            image: {
              mediaType: "image/jpeg",
              base64: "QUJD", // "ABC" in base64
            },
          },
        ],
      },
    ],
  };
}

// Create a valid test output
function createTestOutput(): ReaderOutput {
  return {
    reader: "test-reader",
    fields: [
      {
        field: "invoice.number",
        value: "INV-123",
        quote: "Invoice number: INV-123",
        doc: "doc1",
        page: 1,
        confidence: "high",
      },
    ],
    transcripts: [
      {
        doc: "doc2",
        page: 1,
        lines: [
          {
            text: "Packing list line 1",
            box: { x: 0.1, y: 0.1, w: 0.8, h: 0.05 },
          },
        ],
      },
    ],
  };
}

describe("intakeService: handleReadRequest", () => {
  it("off mode returns 503 with the reason", async () => {
    const setup: ReaderSetup = {
      mode: "off",
      reason: "no API key",
      caps: { total: 0, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 0,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };

    const result = await handleReadRequest({
      setup,
      store: null,
      fakeStore: createMemoryUsageStore(),
      readers: {},
      nowIso: "2026-01-01T00:00:00Z",
      ip: null,
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(503);
    expect(result.json.ok).toBe(false);
    expect(result.json.message).toContain("The AI reader is off");
    expect(result.json.message).toContain("no API key");
  });

  it("invalid input returns 400", async () => {
    const setup: ReaderSetup = {
      mode: "fake",
      reason: null,
      caps: { total: 10, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 1_000_000_000,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };

    const result = await handleReadRequest({
      setup,
      store: null,
      fakeStore: createMemoryUsageStore(),
      readers: { fake: { name: "fake", read: async () => ({ output: createTestOutput(), usage: { inputTokens: 0, outputTokens: 0 } }) } },
      nowIso: "2026-01-01T00:00:00Z",
      ip: null,
      bodyBytes: 100,
      body: { invalid: "input" },
    });

    expect(result.status).toBe(400);
    expect(result.json.ok).toBe(false);
  });

  it("fake mode with no reader returns 503", async () => {
    const setup: ReaderSetup = {
      mode: "fake",
      reason: null,
      caps: { total: 10, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 1_000_000_000,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };

    const result = await handleReadRequest({
      setup,
      store: null,
      fakeStore: createMemoryUsageStore(),
      readers: {}, // no fake reader
      nowIso: "2026-01-01T00:00:00Z",
      ip: null,
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(503);
    expect(result.json.message).toContain("Test mode has no recordings loaded");
  });

  it("fake mode with recorded answer returns 200 with output and mode 'fake'", async () => {
    const setup: ReaderSetup = {
      mode: "fake",
      reason: null,
      caps: { total: 10, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 1_000_000_000,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };

    const fakeStore = createMemoryUsageStore();
    const fakeReader: IntakeReader = {
      name: "fake",
      read: async () => ({
        output: createTestOutput(),
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };

    const result = await handleReadRequest({
      setup,
      store: null,
      fakeStore,
      readers: { fake: fakeReader },
      nowIso: "2026-01-01T00:00:00Z",
      ip: null,
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(result.json.mode).toBe("fake");
    expect(result.json.output).toBeDefined();
    expect(result.json.remaining).toBe(null);

    // Check that a record was appended to fake store
    const records = (fakeStore as any).records as UsageRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      readerMode: "fake",
      outcome: "success",
      model: "fake",
    });
  });

  it("fake mode reader error returns 422", async () => {
    const setup: ReaderSetup = {
      mode: "fake",
      reason: null,
      caps: { total: 10, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 1_000_000_000,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };

    const fakeReader: IntakeReader = {
      name: "fake",
      read: async () => {
        throw new ReaderError("no recorded answer for these files");
      },
    };

    const result = await handleReadRequest({
      setup,
      store: null,
      fakeStore: createMemoryUsageStore(),
      readers: { fake: fakeReader },
      nowIso: "2026-01-01T00:00:00Z",
      ip: null,
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(422);
    expect(result.json.ok).toBe(false);
    expect(result.json.message).toBe("no recorded answer for these files");
  });

  it("fake mode with invalid output returns 502", async () => {
    const setup: ReaderSetup = {
      mode: "fake",
      reason: null,
      caps: { total: 10, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 1_000_000_000,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };

    const invalidOutput: ReaderOutput = {
      reader: "test",
      fields: [
        {
          field: "unknownField", // This field doesn't exist in the catalog
          value: "value",
          quote: "quote",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [
        {
          doc: "doc2",
          page: 1,
          lines: [{ text: "line", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.05 } }],
        },
      ],
    };

    const fakeReader: IntakeReader = {
      name: "fake",
      read: async () => ({
        output: invalidOutput,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };

    const result = await handleReadRequest({
      setup,
      store: null,
      fakeStore: createMemoryUsageStore(),
      readers: { fake: fakeReader },
      nowIso: "2026-01-01T00:00:00Z",
      ip: null,
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(502);
    expect(result.json.ok).toBe(false);
    expect(result.json.message).toContain("The reader answer was not valid");
  });

  it("Property 23: Handle Read Request Reserves Before Call (writeState before read)", async () => {
    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 10, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const store = createSpyStore();

    const claudeReader: IntakeReader = {
      name: "claude",
      read: async () => ({
        output: createTestOutput(),
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
    };

    const result = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: claudeReader },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(200);

    // Check that writeState was called before read
    const writeStateIdx = store.events.indexOf("writeState");
    const appendRecordIdx = store.events.indexOf("appendRecord");
    expect(writeStateIdx).toBeGreaterThanOrEqual(0);
    expect(writeStateIdx).toBeLessThan(appendRecordIdx);
  });

  it("claude mode writeState throws returns 503 and doesn't call reader", async () => {
    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 10, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    let readerCalled = false;
    const claudeReader: IntakeReader = {
      name: "claude",
      read: async () => {
        readerCalled = true;
        return {
          output: createTestOutput(),
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      },
    };

    const throwingStore: UsageStore = {
      readState: async () => emptyUsageState(),
      writeState: async () => {
        throw new Error("write failed");
      },
      appendRecord: async () => {},
    };

    const result = await handleReadRequest({
      setup,
      store: throwingStore,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: claudeReader },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(503);
    expect(readerCalled).toBe(false);
  });

  it("caps reached (total_cap) returns 429 with appropriate message", async () => {
    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 0, daily: 10, perVisitorDaily: 10 }, // total cap is 0
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const store = createSpyStore();

    const result = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: { name: "claude", read: async () => ({ output: createTestOutput(), usage: { inputTokens: 0, outputTokens: 0 } }) } },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(429);
    expect(result.json.message).toBe("This demo has used all of its AI reads.");
  });

  it("caps reached (daily_cap) returns 429 with appropriate message", async () => {
    const state: UsageState = {
      totalCalls: 0,
      days: {
        "2026-01-01": {
          calls: 5,
          visitors: {},
        },
      },
    };

    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 100, daily: 5, perVisitorDaily: 10 }, // daily cap is reached
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const store = createSpyStore(state);

    const result = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: { name: "claude", read: async () => ({ output: createTestOutput(), usage: { inputTokens: 0, outputTokens: 0 } }) } },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(429);
    expect(result.json.message).toBe("This demo has used today's AI reads. Try again after midnight UTC.");
  });

  it("caps reached (visitor_cap) returns 429 with appropriate message", async () => {
    const ip = "127.0.0.1";
    const salt = "salt";
    const day = "2026-01-01";
    const computedKey = visitorKey(ip, salt, day);

    const state: UsageState = {
      totalCalls: 0,
      days: {
        "2026-01-01": {
          calls: 0,
          visitors: {
            [computedKey]: 3, // visitor cap is reached
          },
        },
      },
    };

    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 100, daily: 100, perVisitorDaily: 3 },
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: salt,
      apiKey: "key",
    };

    // Create a mock store that returns our state
    const store: UsageStore = {
      readState: async () => state,
      writeState: async () => {},
      appendRecord: async () => {},
    };

    const result = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: { name: "claude", read: async () => ({ output: createTestOutput(), usage: { inputTokens: 0, outputTokens: 0 } }) } },
      nowIso: "2026-01-01T00:00:00Z",
      ip,
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(429);
    expect(result.json.message).toBe("You have used your AI reads for today. Try again after midnight UTC.");
  });

  it("reader throws ReaderError with usage returns 502 with tokens recorded", async () => {
    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 100, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const store = createSpyStore();

    const claudeReader: IntakeReader = {
      name: "claude",
      read: async () => {
        throw new ReaderError("model stopped: refusal", {
          inputTokens: 1000,
          outputTokens: 10,
        });
      },
    };

    const result = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: claudeReader },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(502);
    expect(result.json.ok).toBe(false);
    expect(result.json.message).toBe("model stopped: refusal");

    // Check record
    const records = (store as any).getRecords() as UsageRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 10,
      outcome: "error",
      readerMode: "claude",
    });
    expect(records[0]?.estimatedCostNanoUsd).toBe(estimateCostNanoUsd(1000, 10));
  });

  it("success returns 200 with output and remaining calls", async () => {
    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 10, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const store = createSpyStore();

    const claudeReader: IntakeReader = {
      name: "claude",
      read: async () => ({
        output: createTestOutput(),
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
    };

    const result = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: claudeReader },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: createTestInput(),
    });

    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(result.json.mode).toBe("claude");
    expect(result.json.output).toBeDefined();
    expect(result.json.remaining).toBe(9); // 10 - 1 used

    // Check record
    const records = (store as any).getRecords() as UsageRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      outcome: "success",
      readerMode: "claude",
      model: intakeConfig.readerModel,
    });
  });

  it("Property 24: Handle Read Request No Echo - never echoes request body in response", async () => {
    const testInput: ReaderInput = {
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
              text: "SECRET-TEXT-123 this should not appear",
              image: null,
            },
          ],
        },
        {
          docId: "doc2",
          kind: "packingList",
          fileName: "packing.pdf",
          fileSha256: "b".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
          ],
        },
      ],
    };

    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 10, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: 100_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const store = createSpyStore();

    const claudeReader: IntakeReader = {
      name: "claude",
      read: async () => ({
        output: createTestOutput(),
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
    };

    const result = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: claudeReader },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 1000,
      body: testInput,
    });

    // Check response JSON doesn't contain secret text
    const responseJson = JSON.stringify(result.json);
    expect(responseJson).not.toContain("SECRET-TEXT-123");

    // Check records don't contain secret text
    const records = (store as any).getRecords() as UsageRecord[];
    const recordsJson = JSON.stringify(records);
    expect(recordsJson).not.toContain("SECRET-TEXT-123");
  });
});

describe("Per-call size and cost line (Requirement 17)", () => {
  it("input with large content (6 images + 4 text pages of 15000 chars) answers 413", async () => {
    // Create input with valid but large content to exceed per-call line
    const largeInput: ReaderInput = {
      bundle: "test",
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
              text: "A".repeat(15000),
              image: null,
            },
            {
              page: 2,
              width: 612,
              height: 792,
              text: "A".repeat(15000),
              image: null,
            },
            {
              page: 3,
              width: 612,
              height: 792,
              text: "A".repeat(15000),
              image: null,
            },
            {
              page: 4,
              width: 612,
              height: 792,
              text: "A".repeat(15000),
              image: null,
            },
          ],
        },
        {
          docId: "doc2",
          kind: "packingList",
          fileName: "packing.pdf",
          fileSha256: "b".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
            {
              page: 2,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
            {
              page: 3,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
            {
              page: 4,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
          ],
        },
        {
          docId: "doc3",
          kind: "billOfLading",
          fileName: "bol.pdf",
          fileSha256: "c".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
            {
              page: 2,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
          ],
        },
      ],
    };

    expect(estimateReaderCall(largeInput).worstCaseCostNanoUsd).toBeGreaterThan(intakeConfig.perCall.maxCallCostNanoUsd);

    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 100, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    let readerCalled = false;
    const store = createSpyStore();

    const result = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: {
        claude: {
          name: "claude",
          read: async () => {
            readerCalled = true;
            return { output: createTestOutput(), usage: { inputTokens: 0, outputTokens: 0 } };
          },
        },
      },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: largeInput,
    });

    expect(result.status).toBe(413);
    expect(result.json.message).toContain("too large to read in one go");
    expect(readerCalled).toBe(false);
    expect((store as any).events).not.toContain("writeState");
    expect((store as any).events).not.toContain("readState");
  });

  it("same large input in fake mode also answers 413 without calling fake reader", async () => {
    const largeInput: ReaderInput = {
      bundle: "test",
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
              text: "A".repeat(15000),
              image: null,
            },
            {
              page: 2,
              width: 612,
              height: 792,
              text: "A".repeat(15000),
              image: null,
            },
            {
              page: 3,
              width: 612,
              height: 792,
              text: "A".repeat(15000),
              image: null,
            },
            {
              page: 4,
              width: 612,
              height: 792,
              text: "A".repeat(15000),
              image: null,
            },
          ],
        },
        {
          docId: "doc2",
          kind: "packingList",
          fileName: "packing.pdf",
          fileSha256: "b".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
            {
              page: 2,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
            {
              page: 3,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
            {
              page: 4,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
          ],
        },
        {
          docId: "doc3",
          kind: "billOfLading",
          fileName: "bol.pdf",
          fileSha256: "c".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
            {
              page: 2,
              width: 612,
              height: 792,
              text: null,
              image: {
                mediaType: "image/jpeg",
                base64: "QUJD",
              },
            },
          ],
        },
      ],
    };

    expect(estimateReaderCall(largeInput).worstCaseCostNanoUsd).toBeGreaterThan(intakeConfig.perCall.maxCallCostNanoUsd);

    const setup: ReaderSetup = {
      mode: "fake",
      reason: null,
      caps: { total: 100, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: 1_000_000_000,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };

    let fakeReaderCalled = false;

    const result = await handleReadRequest({
      setup,
      store: null,
      fakeStore: createMemoryUsageStore(),
      readers: {
        fake: {
          name: "fake",
          read: async () => {
            fakeReaderCalled = true;
            return { output: createTestOutput(), usage: { inputTokens: 0, outputTokens: 0 } };
          },
        },
      },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: largeInput,
    });

    expect(result.status).toBe(413);
    expect(fakeReaderCalled).toBe(false);
  });

  it("text page of 15001 characters answers 400 with appropriate reason", async () => {
    const input: ReaderInput = {
      bundle: "test",
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
              text: "A".repeat(15001),
              image: null,
            },
          ],
        },
      ],
    };

    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 100, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const result = await handleReadRequest({
      setup,
      store: createSpyStore(),
      fakeStore: createMemoryUsageStore(),
      readers: { claude: { name: "claude", read: async () => ({ output: createTestOutput(), usage: { inputTokens: 0, outputTokens: 0 } }) } },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: input,
    });

    expect(result.status).toBe(400);
    expect(result.json.message).toContain("more than 15000 characters");
  });

  it("claude mode with costCapNanoUsd-(worstCaseEstimate-1) answers 429 with cost_cap message", async () => {
    const input = createTestInput();
    const estimate = estimateReaderCall(input);

    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 100, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: Math.max(0, estimate.worstCaseCostNanoUsd - 1),
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const store = createSpyStore();

    const result = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: { name: "claude", read: async () => ({ output: createTestOutput(), usage: { inputTokens: 0, outputTokens: 0 } }) } },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: input,
    });

    expect(result.status).toBe(429);
    expect(result.json.message).toBe("This demo has used its AI budget.");

    const records = (store as any).getRecords() as UsageRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "cap-exceeded",
      errorMessage: "cost_cap",
    });
  });

  it("two calls with cost tracking leaves reservedCostNanoUsd equal to twice the estimate", async () => {
    const input = createTestInput();
    const estimate = estimateReaderCall(input);

    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 100, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: estimate.worstCaseCostNanoUsd * 3,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const store = createMemoryUsageStore();

    // First call
    const result1 = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: { name: "claude", read: async () => ({ output: createTestOutput(), usage: { inputTokens: 100, outputTokens: 10 } }) } },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: input,
    });

    expect(result1.status).toBe(200);

    // Second call
    const result2 = await handleReadRequest({
      setup,
      store,
      fakeStore: createMemoryUsageStore(),
      readers: { claude: { name: "claude", read: async () => ({ output: createTestOutput(), usage: { inputTokens: 100, outputTokens: 10 } }) } },
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
      bodyBytes: 100,
      body: input,
    });

    expect(result2.status).toBe(200);

    // Check that reserved cost is tracked
    const finalState = await store.readState();
    expect(finalState.reservedCostNanoUsd).toBe(estimate.worstCaseCostNanoUsd * 2);
  });

  describe("Feature: document-intake, Property 38: Reader Call Limits and No Document Text in Errors (Validates: Requirements 21, 22)", () => {
    it("claude mode with a reader that rejects with APIConnectionTimeoutError: status 502 with timeout message", async () => {
      const { createClaudeReader, SDK_ERRORS } = await import("./claudeReader");

      const setup: ReaderSetup = {
        mode: "claude",
        reason: null,
        caps: { total: 100, daily: 100, perVisitorDaily: 100 },
        costCapNanoUsd: 1_000_000_000,
        store: "file",
        storeDir: "logs",
        visitorSalt: "salt",
        apiKey: "key",
      };

      const store = createMemoryUsageStore();

      const claudeReader = createClaudeReader({
        apiKey: "key",
        client: {
          messages: {
            async create() {
              throw new SDK_ERRORS.APIConnectionTimeoutError({ message: "timeout" });
            },
          },
        },
      });

      const result = await handleReadRequest({
        setup,
        store,
        fakeStore: createMemoryUsageStore(),
        readers: { claude: claudeReader },
        nowIso: "2026-01-01T00:00:00Z",
        ip: "127.0.0.1",
        bodyBytes: 100,
        body: createTestInput(),
      });

      expect(result.status).toBe(502);
      expect(result.json.ok).toBe(false);
      expect(result.json.message).toBe("The AI reader took longer than 45 seconds and was stopped. Try fewer pages.");

      // Check record
      const records = (store as any).records as UsageRecord[];
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        outcome: "error",
        errorMessage: "The AI reader took longer than 45 seconds and was stopped. Try fewer pages.",
        inputTokens: null,
        outputTokens: null,
      });

      // Check that reserved cost equals worst case estimate
      expect(records[0]?.estimatedCostNanoUsd).toBeNull();
      expect((await store.readState()).reservedCostNanoUsd).toBe(estimateReaderCall(createTestInput()).worstCaseCostNanoUsd);
    });

    it("injected client that answers with doc field containing confidential text: response and records contain no confidential text", async () => {
      const { createClaudeReader } = await import("./claudeReader");

      const setup: ReaderSetup = {
        mode: "claude",
        reason: null,
        caps: { total: 100, daily: 100, perVisitorDaily: 100 },
        costCapNanoUsd: 1_000_000_000,
        store: "file",
        storeDir: "logs",
        visitorSalt: "salt",
        apiKey: "key",
      };

      const store = createMemoryUsageStore();

      const claudeReader = createClaudeReader({
        apiKey: "key",
        client: {
          messages: {
            async create() {
              return {
                stop_reason: "end_turn",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      fields: [
                        {
                          field: "invoice.number",
                          value: "1",
                          quote: "1",
                          doc: "CONFIDENTIAL: Unit price 4.10 USD",
                          page: 1,
                          confidence: "high",
                        },
                      ],
                      transcripts: [],
                      invoiceLineCount: null,
                    }),
                  },
                ],
                usage: { input_tokens: 100, output_tokens: 10 },
              };
            },
          },
        },
      });

      const result = await handleReadRequest({
        setup,
        store,
        fakeStore: createMemoryUsageStore(),
        readers: { claude: claudeReader },
        nowIso: "2026-01-01T00:00:00Z",
        ip: "127.0.0.1",
        bodyBytes: 100,
        body: createTestInput(),
      });

      expect(result.status).toBe(502);

      // Check that response JSON doesn't contain confidential text
      const responseJson = JSON.stringify(result.json);
      expect(responseJson).not.toContain("CONFIDENTIAL");

      // Check that records don't contain confidential text
      const records = (store as any).records as UsageRecord[];
      const recordsJson = JSON.stringify(records);
      expect(recordsJson).not.toContain("CONFIDENTIAL");
    });
  });

  describe("Feature: document-intake, Property 41: The Ledger Holds the Actual Cost (service) (Validates: Requirements 24.3)", () => {
    it("reader returns 200_000 input, 8_000 output: stored reserved cost above worst case estimate", async () => {
      const input = createTestInput();

      const setup: ReaderSetup = {
        mode: "claude",
        reason: null,
        caps: { total: 100, daily: 100, perVisitorDaily: 100 },
        costCapNanoUsd: 10_000_000_000,
        store: "file",
        storeDir: "logs",
        visitorSalt: "salt",
        apiKey: "key",
      };

      const store = createSpyStore();

      const result = await handleReadRequest({
        setup,
        store,
        fakeStore: createMemoryUsageStore(),
        readers: {
          claude: {
            name: "claude",
            read: async () => ({
              output: createTestOutput(),
              usage: { inputTokens: 200_000, outputTokens: 8_000 },
            }),
          },
        },
        nowIso: "2026-01-01T00:00:00Z",
        ip: "127.0.0.1",
        bodyBytes: 100,
        body: input,
      });

      expect(result.status).toBe(200);

      const finalState = await store.readState();
      const actualCost = estimateCostNanoUsd(200_000, 8_000);
      const worstCase = estimateReaderCall(input).worstCaseCostNanoUsd;

      expect(actualCost).toBeGreaterThan(worstCase);
      expect(finalState.reservedCostNanoUsd).toBe(actualCost);
    });

    it("reader throws with 200_000 input, 8_000 output: stored reserved cost equals actual", async () => {
      const input = createTestInput();

      const setup: ReaderSetup = {
        mode: "claude",
        reason: null,
        caps: { total: 100, daily: 100, perVisitorDaily: 100 },
        costCapNanoUsd: 10_000_000_000,
        store: "file",
        storeDir: "logs",
        visitorSalt: "salt",
        apiKey: "key",
      };

      const store = createSpyStore();

      const result = await handleReadRequest({
        setup,
        store,
        fakeStore: createMemoryUsageStore(),
        readers: {
          claude: {
            name: "claude",
            read: async () => {
              throw new ReaderError("reader failed", {
                inputTokens: 200_000,
                outputTokens: 8_000,
              });
            },
          },
        },
        nowIso: "2026-01-01T00:00:00Z",
        ip: "127.0.0.1",
        bodyBytes: 100,
        body: input,
      });

      expect(result.status).toBe(502);

      const finalState = await store.readState();
      const actualCost = estimateCostNanoUsd(200_000, 8_000);

      expect(finalState.reservedCostNanoUsd).toBe(actualCost);
    });

    it("reader returns 10 input, 10 output: stored reserved cost equals worst case (no top-up)", async () => {
      const input = createTestInput();
      const worstCase = estimateReaderCall(input).worstCaseCostNanoUsd;

      const setup: ReaderSetup = {
        mode: "claude",
        reason: null,
        caps: { total: 100, daily: 100, perVisitorDaily: 100 },
        costCapNanoUsd: 10_000_000_000,
        store: "file",
        storeDir: "logs",
        visitorSalt: "salt",
        apiKey: "key",
      };

      const store = createSpyStore();

      const result = await handleReadRequest({
        setup,
        store,
        fakeStore: createMemoryUsageStore(),
        readers: {
          claude: {
            name: "claude",
            read: async () => ({
              output: createTestOutput(),
              usage: { inputTokens: 10, outputTokens: 10 },
            }),
          },
        },
        nowIso: "2026-01-01T00:00:00Z",
        ip: "127.0.0.1",
        bodyBytes: 100,
        body: input,
      });

      expect(result.status).toBe(200);

      const finalState = await store.readState();
      const actualCost = estimateCostNanoUsd(10, 10);

      expect(actualCost).toBeLessThanOrEqual(worstCase);
      expect(finalState.reservedCostNanoUsd).toBe(worstCase);
      
      // Check that there was only one writeState call (the reserve, not a top-up)
      const writeStateCount = store.events.filter((e) => e === "writeState").length;
      expect(writeStateCount).toBe(1);
    });

    it("top-up writes fail: status 200, log gets 'usage cost top-up not written' once, response same as with a working store", async () => {
      const input = createTestInput();

      const setup: ReaderSetup = {
        mode: "claude",
        reason: null,
        caps: { total: 100, daily: 100, perVisitorDaily: 100 },
        costCapNanoUsd: 10_000_000_000,
        store: "file",
        storeDir: "logs",
        visitorSalt: "salt",
        apiKey: "key",
      };

      let savedState: UsageState = emptyUsageState();
      let writeStateCallCount = 0;
      const faultyStore: UsageStore = {
        async readState() {
          return savedState;
        },
        async writeState(s: UsageState) {
          writeStateCallCount++;
          savedState = s;
          if (writeStateCallCount === 1) {
            // First call (reservation) succeeds
            return;
          }
          // All later calls (top-up attempts) fail
          throw new Error("write failed");
        },
        async appendRecord(r: UsageRecord) {
          // Do nothing
        },
      };

      const logMessages: string[] = [];

      const nowIso = "2026-01-01T00:00:00Z";
      const ip = "127.0.0.1";
      const reader = {
        name: "claude",
        read: async () => ({
          output: createTestOutput(),
          usage: { inputTokens: 200_000, outputTokens: 8_000 },
        }),
      };

      const result = await handleReadRequest({
        setup,
        store: faultyStore,
        fakeStore: createMemoryUsageStore(),
        readers: { claude: reader },
        nowIso,
        ip,
        bodyBytes: 100,
        body: input,
        log: (msg) => logMessages.push(msg),
      });

      // Expect status 200 despite top-up failures
      expect(result.status).toBe(200);

      // Expect exactly 1 log message about top-up not written
      expect(logMessages.filter((m) => m === "usage cost top-up not written").length).toBe(1);

      // Expect 4 writeState calls: 1 reserve + 3 top-up attempts
      expect(writeStateCallCount).toBe(4);

      // Run the same request with a working store to compare responses
      const workingLogMessages: string[] = [];
      const workingResult = await handleReadRequest({
        setup,
        store: createSpyStore(),
        fakeStore: createMemoryUsageStore(),
        readers: { claude: reader },
        nowIso,
        ip,
        bodyBytes: 100,
        body: input,
        log: (msg) => workingLogMessages.push(msg),
      });

      // Responses should be the same
      expect(result.json).toEqual(workingResult.json);
    });

    it("store writeState succeeds reserve, then fails all 3 top-up attempts: status 200, log receives 'not written', response same as success", async () => {
      const input = createTestInput();

      const setup: ReaderSetup = {
        mode: "claude",
        reason: null,
        caps: { total: 100, daily: 100, perVisitorDaily: 100 },
        costCapNanoUsd: 10_000_000_000,
        store: "file",
        storeDir: "logs",
        visitorSalt: "salt",
        apiKey: "key",
      };

      let writeAttempts = 0;
      const faultyStore: UsageStore & { events: string[] } = {
        events: [],
        async readState() {
          this.events.push("readState");
          return emptyUsageState();
        },
        async writeState(s: UsageState) {
          this.events.push("writeState");
          writeAttempts++;
          // First call succeeds (reserve), rest fail (top-up attempts)
          if (writeAttempts > 1) {
            throw new Error("top-up write fails");
          }
        },
        async appendRecord(r: UsageRecord) {
          this.events.push("appendRecord");
        },
      };

      const logMessages: string[] = [];

      const result = await handleReadRequest({
        setup,
        store: faultyStore,
        fakeStore: createMemoryUsageStore(),
        readers: {
          claude: {
            name: "claude",
            read: async () => ({
              output: createTestOutput(),
              usage: { inputTokens: 200_000, outputTokens: 8_000 },
            }),
          },
        },
        nowIso: "2026-01-01T00:00:00Z",
        ip: "127.0.0.1",
        bodyBytes: 100,
        body: input,
        log: (msg) => logMessages.push(msg),
      });

      // Reserve succeeds, reader is called, top-up fails 3 times
      expect(result.status).toBe(200);
      expect(result.json.ok).toBe(true);
      expect(logMessages).toContain("usage cost top-up not written");

      // writeState was called 4 times: 1 reserve + 3 top-up attempts
      expect(faultyStore.events.filter((e) => e === "writeState").length).toBe(4);
    });
  });
});

describe("intakeService: handleStatusRequest", () => {
  it("off mode returns status 200 with mode off and reason", async () => {
    const setup: ReaderSetup = {
      mode: "off",
      reason: "no API key",
      caps: { total: 0, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 0,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };

    const result = await handleStatusRequest({
      setup,
      store: null,
      nowIso: "2026-01-01T00:00:00Z",
      ip: null,
    });

    expect(result.status).toBe(200);
    expect(result.json.mode).toBe("off");
    expect(result.json.reason).toBe("no API key");
    expect(result.json.callsRemaining).toBe(null);
  });

  it("fake mode returns status 200 with mode fake and callsRemaining null", async () => {
    const setup: ReaderSetup = {
      mode: "fake",
      reason: null,
      caps: { total: 10, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 1_000_000_000,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };

    const result = await handleStatusRequest({
      setup,
      store: null,
      nowIso: "2026-01-01T00:00:00Z",
      ip: null,
    });

    expect(result.status).toBe(200);
    expect(result.json.mode).toBe("fake");
    expect(result.json.callsRemaining).toBe(null);
  });

  it("claude mode with memory store returns remaining calls", async () => {
    const state: UsageState = {
      totalCalls: 1,
      days: {
        "2026-01-01": {
          calls: 1,
          visitors: {},
        },
      },
    };

    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 5, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const store = createMemoryUsageStore(state);

    const result = await handleStatusRequest({
      setup,
      store,
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
    });

    expect(result.status).toBe(200);
    expect(result.json.mode).toBe("claude");
    expect(result.json.callsRemaining).toBe(4); // 5 - 1
  });

  it("claude mode with store that throws returns mode off", async () => {
    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 5, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: 1_000_000_000,
      store: "file",
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const throwingStore: UsageStore = {
      readState: async () => {
        throw new Error("read failed");
      },
      writeState: async () => {},
      appendRecord: async () => {},
    };

    const result = await handleStatusRequest({
      setup,
      store: throwingStore,
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
    });

    expect(result.status).toBe(200);
    expect(result.json.mode).toBe("off");
    expect(result.json.reason).toBe("usage store unavailable");
    expect(result.json.callsRemaining).toBe(null);
  });

  it("claude mode with no store returns mode off", async () => {
    const setup: ReaderSetup = {
      mode: "claude",
      reason: null,
      caps: { total: 5, daily: 100, perVisitorDaily: 100 },
      costCapNanoUsd: 1_000_000_000,
      store: null, // no store
      storeDir: "logs",
      visitorSalt: "salt",
      apiKey: "key",
    };

    const result = await handleStatusRequest({
      setup,
      store: null,
      nowIso: "2026-01-01T00:00:00Z",
      ip: "127.0.0.1",
    });

    expect(result.status).toBe(200);
    expect(result.json.mode).toBe("off");
    expect(result.json.reason).toBe("usage store unavailable");
    expect(result.json.callsRemaining).toBe(null);
  });
});
