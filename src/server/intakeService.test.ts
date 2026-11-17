import { describe, it, expect, beforeEach } from "vitest";
import type { UsageState, Caps } from "../core/budget";
import { emptyUsageState, estimateCostNanoUsd } from "../core/budget";
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

describe("intakeService: handleStatusRequest", () => {
  it("off mode returns status 200 with mode off and reason", async () => {
    const setup: ReaderSetup = {
      mode: "off",
      reason: "no API key",
      caps: { total: 0, daily: 0, perVisitorDaily: 0 },
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
