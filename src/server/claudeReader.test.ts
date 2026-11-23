import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClaudeClientLike, ClaudeResponseLike } from "./claudeReader";
import {
  createClaudeReader,
  createAnthropicClient,
  ANTHROPIC_API_BASE_URL,
  READER_SYSTEM_PROMPT,
  READER_OUTPUT_SCHEMA,
  buildReaderRequest,
  mapSdkError,
  SDK_ERRORS,
} from "./claudeReader";
import type { ReaderInput, ReaderOutput } from "../core/readerContract";
import { ReaderError } from "./readerTypes";
import { FIELD_CATALOG } from "../core/fieldCatalog";
import { estimateReaderCall } from "../core/budget";

type RequestParams = Parameters<ClaudeClientLike["messages"]["create"]>[0];

function makeClient(
  respond: (params: RequestParams) => Promise<ClaudeResponseLike>,
): { client: ClaudeClientLike; calls: RequestParams[] } {
  const calls: RequestParams[] = [];

  return {
    client: {
      messages: {
        async create(params: RequestParams): Promise<ClaudeResponseLike> {
          calls.push(params);
          return respond(params);
        },
      },
    },
    calls,
  };
}

// Helper: convert ReaderOutput (with { text, box: { x, y, w, h } } lines) to wire format ({ t, b: [x, y, w, h] })
// Works on a copy, never mutates the argument.
function toModelJson(output: any): any {
  const copy = structuredClone(output);
  const { reader, ...modelJson } = copy;
  if (Array.isArray(modelJson.transcripts)) {
    for (const transcript of modelJson.transcripts) {
      if (Array.isArray(transcript.lines)) {
        for (const line of transcript.lines) {
          if (line.text !== undefined && line.box !== undefined) {
            const { x, y, w, h } = line.box;
            line.t = line.text;
            line.b = [
              Math.round(x * 1000),
              Math.round(y * 1000),
              Math.round(w * 1000),
              Math.round(h * 1000),
            ];
            delete line.text;
            delete line.box;
          }
        }
      }
    }
  }
  return modelJson;
}

describe("Claude Reader", () => {
  it("loads the fixture from upload-test-hollowmere.json", async () => {
    const recordingPath = path.join(
      process.cwd(),
      "samples",
      "upload-test",
      "recordings",
      "upload-test-hollowmere.json",
    );
    const content = await fs.readFile(recordingPath, "utf-8");
    const recording = JSON.parse(content);

    // The model JSON is the output without the reader key
    const modelJson = recording.output;
    expect(modelJson.fields).toBeDefined();
    expect(modelJson.transcripts).toBeDefined();
  });

  it("Success: returns output with fields and usage", async () => {
    const recordingPath = path.join(
      process.cwd(),
      "samples",
      "upload-test",
      "recordings",
      "upload-test-hollowmere.json",
    );
    const content = await fs.readFile(recordingPath, "utf-8");
    const recording = JSON.parse(content);

    // Build the input as the spec describes
    const testInput: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "invoice",
          kind: "invoice",
          fileName: "invoice.pdf",
          fileSha256: "a".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: "x",
              image: null,
            },
          ],
        },
        {
          docId: "packingList",
          kind: "packingList",
          fileName: "packing-list-photo.jpg",
          fileSha256: "b".repeat(64),
          pages: [
            {
              page: 1,
              width: 1200,
              height: 1600,
              text: null,
              image: { mediaType: "image/jpeg" as const, base64: "QUJD" },
            },
          ],
        },
        {
          docId: "billOfLading",
          kind: "billOfLading",
          fileName: "bill-of-lading-scan.pdf",
          fileSha256: "c".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: null,
              image: { mediaType: "image/jpeg" as const, base64: "QUJD" },
            },
          ],
        },
      ],
    };

    const { client, calls } = makeClient(async () => ({
      stop_reason: "end_turn",
      content: [
        { type: "thinking" },
        { type: "text", text: JSON.stringify(toModelJson(recording.output)) },
      ],
      usage: { input_tokens: 1200, output_tokens: 300 },
    }));

    const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
    const result = await reader.read(testInput);

    expect(result.output.fields).toEqual(recording.output.fields);
    expect(result.output.reader).toBe("claude-haiku-5-5");
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(calls).toHaveLength(1);

    // Compare transcript lines: the reader converts wire format { t, b: [...] } back to { text, box: { x, y, w, h } }
    // so verify by converting recording's shape through the wire format and back.
    expect(result.output.transcripts).toHaveLength(recording.output.transcripts.length);
    for (let i = 0; i < recording.output.transcripts.length; i++) {
      const recordingTranscript = recording.output.transcripts[i];
      const resultTranscript = result.output.transcripts[i];
      expect(resultTranscript!.lines).toHaveLength(recordingTranscript.lines.length);
      for (let j = 0; j < recordingTranscript.lines.length; j++) {
        const recordingLine = recordingTranscript.lines[j];
        const resultLine = resultTranscript!.lines[j];
        expect(resultLine!.text).toBe(recordingLine.text);
        expect(resultLine!.box!.x).toBe(Math.round(recordingLine.box.x * 1000) / 1000);
        expect(resultLine!.box!.y).toBe(Math.round(recordingLine.box.y * 1000) / 1000);
        expect(resultLine!.box!.w).toBe(Math.round(recordingLine.box.w * 1000) / 1000);
        expect(resultLine!.box!.h).toBe(Math.round(recordingLine.box.h * 1000) / 1000);
      }
    }
  });

  describe("Feature: document-intake, Property 21: Claude Reader Stop Reason Check", () => {
    it('stop reason "refusal" rejects with message containing "declined"', async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x",
                image: null,
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "refusal",
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 1200, output_tokens: 300 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

      try {
        await reader.read(testInput);
        expect.fail("should have thrown");
      } catch (e) {
        if (!(e instanceof ReaderError)) throw e;
        expect(e.message).toContain("declined");
        expect(e.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
      }
    });

    it('stop reason "max_tokens" rejects with appropriate message', async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x",
                image: null,
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 1200, output_tokens: 300 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

      try {
        await reader.read(testInput);
        expect.fail("should have thrown");
      } catch (e) {
        if (!(e instanceof ReaderError)) throw e;
        expect(e.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
      }
    });

    it('stop reason "pause_turn" rejects with appropriate message', async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x",
                image: null,
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "pause_turn",
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 1200, output_tokens: 300 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

      try {
        await reader.read(testInput);
        expect.fail("should have thrown");
      } catch (e) {
        if (!(e instanceof ReaderError)) throw e;
        expect(e.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
      }
    });
  });

  it("No text block: rejects with appropriate message", async () => {
    const testInput: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "invoice",
          kind: "invoice",
          fileName: "invoice.pdf",
          fileSha256: "a".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: "x",
              image: null,
            },
          ],
        },
      ],
    };

    const { client } = makeClient(async () => ({
      stop_reason: "end_turn",
      content: [{ type: "thinking" }],
      usage: { input_tokens: 1200, output_tokens: 300 },
    }));

    const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

    try {
      await reader.read(testInput);
      expect.fail("should have thrown");
    } catch (e) {
      if (!(e instanceof ReaderError)) throw e;
      expect(e.message).toContain("returned no answer");
    }
  });

  it("Invalid JSON in text block: rejects appropriately", async () => {
    const testInput: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "invoice",
          kind: "invoice",
          fileName: "invoice.pdf",
          fileSha256: "a".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: "x",
              image: null,
            },
          ],
        },
      ],
    };

    const { client } = makeClient(async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not json" }],
      usage: { input_tokens: 1200, output_tokens: 300 },
    }));

    const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

    try {
      await reader.read(testInput);
      expect.fail("should have thrown");
    } catch (e) {
      if (!(e instanceof ReaderError)) throw e;
      expect(e.message).toContain("not valid JSON");
      expect(e.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    }
  });

  it("Invalid reader output schema: rejects with appropriate message", async () => {
    const testInput: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "invoice",
          kind: "invoice",
          fileName: "invoice.pdf",
          fileSha256: "a".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: "x",
              image: null,
            },
          ],
        },
      ],
    };

    const { client } = makeClient(async () => ({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            fields: [{ field: "invoice.notAField", value: "test", quote: "q", doc: "invoice", page: 1, confidence: "high" }],
            transcripts: [],
          }),
        },
      ],
      usage: { input_tokens: 1200, output_tokens: 300 },
    }));

    const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

    try {
      await reader.read(testInput);
      expect.fail("should have thrown");
    } catch (e) {
      if (!(e instanceof ReaderError)) throw e;
      expect(e.message).toContain("not valid");
    }
  });

  it("Client throws Error with key string: does not leak key", async () => {
    const testInput: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "invoice",
          kind: "invoice",
          fileName: "invoice.pdf",
          fileSha256: "a".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: "x",
              image: null,
            },
          ],
        },
      ],
    };

    const { client } = makeClient(async () => {
      throw new Error("boom test-key-not-real");
    });

    const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

    try {
      await reader.read(testInput);
      expect.fail("should have thrown");
    } catch (e) {
      if (!(e instanceof ReaderError)) throw e;
      expect(e.message).toBe("The AI reader failed.");
      expect(e.usage).toBeNull();
      expect(e.message).not.toContain("test-key-not-real");
    }
  });

  describe("Feature: document-intake, Property 22: Claude Reader Request Shape", () => {
    it("request has correct model, max_tokens, output_config, and no temperature etc.", async () => {
      const recordingPath = path.join(
        process.cwd(),
        "samples",
        "upload-test",
        "recordings",
        "upload-test-hollowmere.json",
      );
      const content = await fs.readFile(recordingPath, "utf-8");
      const recording = JSON.parse(content);

      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x",
                image: null,
              },
            ],
          },
          {
            docId: "packingList",
            kind: "packingList",
            fileName: "packing-list-photo.jpg",
            fileSha256: "b".repeat(64),
            pages: [
              {
                page: 1,
                width: 1200,
                height: 1600,
                text: null,
                image: { mediaType: "image/jpeg" as const, base64: "QUJD" },
              },
            ],
          },
          {
            docId: "billOfLading",
            kind: "billOfLading",
            fileName: "bill-of-lading-scan.pdf",
            fileSha256: "c".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: null,
                image: { mediaType: "image/jpeg" as const, base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client, calls } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(toModelJson(recording.output)) }],
        usage: { input_tokens: 1200, output_tokens: 300 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      await reader.read(testInput);

      expect(calls).toHaveLength(1);
      const params = calls[0]!;

      // Check model and max_tokens
      expect(params.model).toBe("claude-haiku-5-5");
      // Output tokens are calculated based on input (Requirement 29.4)
      const estimate = estimateReaderCall(testInput);
      expect(params.max_tokens).toBe(estimate.outputTokens);

      // Check output_config
      expect(params.output_config).toBeDefined();
      expect((params.output_config as any).effort).toBe("low");
      expect((params.output_config as any).format.type).toBe("json_schema");

      // Check no temperature, top_p, top_k
      expect((params as any).temperature).toBeUndefined();
      expect((params as any).top_p).toBeUndefined();
      expect((params as any).top_k).toBeUndefined();

      // Check thinking is disabled (Requirement 29.1)
      expect((params as any).thinking).toEqual({ type: "disabled" });

      // Check exactly one message with role "user"
      expect(params.messages).toHaveLength(1);
      expect(params.messages[0]!.role).toBe("user");

      // Check image blocks
      const blocks = (params.messages[0]! as any).content as any[];
      const imageBlocks = blocks.filter(
        (b: any) => b.type === "image" && b.source?.type === "base64",
      );
      expect(imageBlocks).toHaveLength(2);
      for (const block of imageBlocks) {
        expect(block.source.media_type).toBe("image/jpeg");
        expect(block.source.data).toBe("QUJD");
      }

      // Check some text block contains <page_text>
      const textBlocks = blocks.filter((b: any) => b.type === "text");
      const hasPageText = textBlocks.some((b: any) => b.text.includes("<page_text>"));
      expect(hasPageText).toBe(true);

      // Check schema validity
      function validateSchema(schema: any, path: string[]): void {
        if (schema && typeof schema === "object" && schema.type === "object") {
          expect(schema.additionalProperties).toBe(false);
          expect(Array.isArray(schema.required)).toBe(true);
          expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties || {})));

          for (const [key, prop] of Object.entries(schema.properties || {})) {
            validateSchema(prop, [...path, key]);
          }
        }

        if (schema && typeof schema === "object" && schema.items) {
          validateSchema(schema.items, [...path, "items"]);
        }
      }

      validateSchema((params.output_config as any).format.schema, []);

      // Check field enum
      const fieldEnum = (params.output_config as any).format.schema.properties.fields.items.properties
        .field.enum;
      const catalogNames = FIELD_CATALOG.map((f) => f.name);
      expect(fieldEnum).toEqual(catalogNames);
    });

    it("schema lists invoiceLineCount in required and with type [integer, null]", () => {
      const schema = READER_OUTPUT_SCHEMA;
      expect(schema.required).toContain("invoiceLineCount");
      expect(schema.properties.invoiceLineCount).toBeDefined();
      expect((schema.properties.invoiceLineCount as any).type).toEqual(["integer", "null"]);
    });
  });

  describe("Feature: document-intake, Property 20: Claude Reader No Retries", () => {
    it("source code contains maxRetries: 0 and does not contain process.env", async () => {
      const sourceFile = path.join(process.cwd(), "src", "server", "claudeReader.ts");
      const source = await fs.readFile(sourceFile, "utf-8");

      expect(source).toContain("maxRetries: 0");
      expect(source).not.toContain("process.env");
    });

    it("system prompt contains invoiceLineCount", async () => {
      expect(READER_SYSTEM_PROMPT).toContain("invoiceLineCount");
    });
  });

  it("stop_reason null with valid text block rejects with message containing stopped early", async () => {
    const testInput: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "invoice",
          kind: "invoice",
          fileName: "invoice.pdf",
          fileSha256: "a".repeat(64),
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: "x",
              image: null,
            },
          ],
        },
      ],
    };

    const { client } = makeClient(async () => ({
      stop_reason: null,
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 1200, output_tokens: 300 },
    }));

    const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

    try {
      await reader.read(testInput);
      expect.fail("should have thrown");
    } catch (e) {
      if (!(e instanceof ReaderError)) throw e;
      expect(e.message).toContain("stopped early");
      expect(e.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    }
  });

  describe("Feature: document-intake, Property 38: Reader Call Limits and No Document Text in Errors (Validates: Requirements 21, 22)", () => {
    it("with an injected client that records (params, options): options.timeout is 45000 and params.max_tokens matches estimateReaderCall", async () => {
      let recordedOptions: { timeout?: number } | undefined;
      let recordedParams: any;

      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x",
                image: null,
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async (params) => {
        recordedParams = params;
        return {
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify({ fields: [], transcripts: [], invoiceLineCount: null }) }],
          usage: { input_tokens: 100, output_tokens: 10 },
        };
      });

      // Wrap to capture options
      const wrappedClient: ClaudeClientLike = {
        messages: {
          async create(params, options) {
            recordedOptions = options;
            return client.messages.create(params, options);
          },
        },
      };

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client: wrappedClient });
      await reader.read(testInput);

      expect(recordedOptions?.timeout).toBe(45000);
      // Output tokens are calculated based on input (Requirement 29.4)
      const estimate = estimateReaderCall(testInput);
      expect(recordedParams.max_tokens).toBe(estimate.outputTokens);
    });

    it("an injected client whose create rejects with APIConnectionTimeoutError makes read reject with timeout message", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x",
                image: null,
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => {
        throw new SDK_ERRORS.APIConnectionTimeoutError({ message: "timeout" });
      });

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

      try {
        await reader.read(testInput);
        expect.fail("should have thrown");
      } catch (e) {
        if (!(e instanceof ReaderError)) throw e;
        expect(e.message).toBe("The AI reader took longer than 45 seconds and was stopped. Try fewer pages.");
        expect(e.usage).toBeNull();
      }
    });

    it("mapSdkError(APIConnectionError) still gives 'Could not reach the AI service.'", () => {
      const error = new SDK_ERRORS.APIConnectionError({ message: "x" });
      const result = mapSdkError(error);
      expect(result.message).toBe("Could not reach the AI service.");
    });

    it("buildReaderRequest with documents 'invoice' and 'packingList' has schema doc enum matching request docs", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x",
                image: null,
              },
            ],
          },
          {
            docId: "packingList",
            kind: "packingList",
            fileName: "packing.pdf",
            fileSha256: "b".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: null,
                image: { mediaType: "image/jpeg" as const, base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const request = buildReaderRequest(testInput);
      const schema = (request.output_config as any).format.schema;

      const fieldsDocEnum = schema.properties.fields.items.properties.doc.enum;
      const transcriptsDocEnum = schema.properties.transcripts.items.properties.doc.enum;

      expect(fieldsDocEnum).toEqual(["invoice", "packingList"]);
      expect(transcriptsDocEnum).toEqual(["invoice", "packingList"]);

      // Check that READER_OUTPUT_SCHEMA is unchanged
      expect(READER_OUTPUT_SCHEMA.properties.fields.items.properties.doc).toEqual({ type: "string" });
    });
  });

  describe("Feature: document-intake, Property 42: Platform Variables Cannot Turn the Reader On (client) (Validates: Requirements 25.2)", () => {
    it("createAnthropicClient ignores environment variables for baseURL, logLevel, and openTelemetry", () => {
      const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
      const originalLogLevel = process.env.ANTHROPIC_LOG;

      try {
        process.env.ANTHROPIC_BASE_URL = "https://gateway.invalid/anthropic";
        process.env.ANTHROPIC_LOG = "debug";

        const client = createAnthropicClient("test-key-not-real");

        expect(client.baseURL).toBe(ANTHROPIC_API_BASE_URL);
        expect(client.maxRetries).toBe(0);
        expect(client.apiKey).toBe("test-key-not-real");
        expect(client.logLevel).toBe("off");
      } finally {
        if (originalBaseUrl === undefined) {
          delete process.env.ANTHROPIC_BASE_URL;
        } else {
          process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
        }
        if (originalLogLevel === undefined) {
          delete process.env.ANTHROPIC_LOG;
        } else {
          process.env.ANTHROPIC_LOG = originalLogLevel;
        }
      }
    });

    it("source code builds the client with the fixed address and the required settings", async () => {
      const sourceFile = path.join(process.cwd(), "src", "server", "claudeReader.ts");
      const source = await fs.readFile(sourceFile, "utf-8");

      expect(source).toContain("baseURL: ANTHROPIC_API_BASE_URL");
      expect(source).toContain('logLevel: "off"');
      expect(source).toContain("openTelemetry: false");
      expect(source).not.toContain("process.env");
    });
  });

  describe("Feature: document-intake, Property 46: The Answer Room Stays Under the Line (Validates: Requirements 29.1, 29.2, 29.3, 29.4, 37.1)", () => {
    it("buildReaderRequest sends thinking: { type: 'disabled' }", () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: "x",
                image: null,
              },
            ],
          },
        ],
      };

      const request = buildReaderRequest(testInput);
      expect((request as any).thinking).toEqual({ type: "disabled" });
      expect((request.output_config as any).effort).toBe("low");
    });

    it("READER_SYSTEM_PROMPT describes transcript lines as 't' and 'b' in thousandths", () => {
      expect(READER_SYSTEM_PROMPT).toContain('"t": the line text');
      expect(READER_SYSTEM_PROMPT).toContain('"b": [x, y, w, h]');
      expect(READER_SYSTEM_PROMPT).toContain("thousandths of the page width and height");
      expect(READER_SYSTEM_PROMPT).toContain("Write the JSON on one line, with no indentation.");
      expect(READER_SYSTEM_PROMPT).not.toContain("fractions 0..1");
    });

    it("READER_OUTPUT_SCHEMA transcript line items have exactly t and b (no text, box, minimum, maximum, minItems, maxItems)", () => {
      const lineSchema = (READER_OUTPUT_SCHEMA.properties.transcripts as any).items.properties.lines.items;
      expect(lineSchema.required).toEqual(["t", "b"]);
      expect(Object.keys(lineSchema.properties)).toEqual(["t", "b"]);
      expect(lineSchema.properties.t.type).toBe("string");
      expect(lineSchema.properties.b.type).toBe("array");
      expect(lineSchema.properties.b.items.type).toBe("integer");
      expect(lineSchema.properties.b.minimum).toBeUndefined();
      expect(lineSchema.properties.b.maximum).toBeUndefined();
      expect(lineSchema.properties.b.minItems).toBeUndefined();
      expect(lineSchema.properties.b.maxItems).toBeUndefined();
    });

    it("transforms wire format line { t, b: [716, 88, 172, 16] } to output format { text, box: { x: 0.716, y: 0.088, w: 0.172, h: 0.016 } }", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 1200,
                height: 1600,
                text: null,
                image: { mediaType: "image/jpeg", base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fields: [],
              transcripts: [
                {
                  doc: "invoice",
                  page: 1,
                  lines: [{ t: "Total 10", b: [716, 88, 172, 16] }],
                },
              ],
              invoiceLineCount: null,
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      const result = await reader.read(testInput);

      expect(result.output.transcripts).toHaveLength(1);
      expect(result.output.transcripts[0]!.lines).toHaveLength(1);
      const line = result.output.transcripts[0]!.lines[0]!;
      expect(line.text).toBe("Total 10");
      expect(line.box).toEqual({ x: 0.716, y: 0.088, w: 0.172, h: 0.016 });
    });

    it("b = [1, 2, 3] (not 4 elements) becomes box: null on that line; good line stays", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: null,
                image: { mediaType: "image/jpeg", base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fields: [],
              transcripts: [
                {
                  doc: "invoice",
                  page: 1,
                  lines: [{ t: "text", b: [1, 2, 3] }, { t: "Total 10", b: [100, 100, 200, 20] }],
                },
              ],
              invoiceLineCount: null,
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      const result = await reader.read(testInput);

      expect(result.output.transcripts).toHaveLength(1);
      expect(result.output.transcripts[0]!.lines).toHaveLength(2);
      
      // Bad line becomes box: null
      expect(result.output.transcripts[0]!.lines[0]!.text).toBe("text");
      expect(result.output.transcripts[0]!.lines[0]!.box).toBe(null);
      
      // Good line stays
      expect(result.output.transcripts[0]!.lines[1]!.text).toBe("Total 10");
      expect(result.output.transcripts[0]!.lines[1]!.box!).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.02 });
    });

    it("b = [0, 0, 0, 1001] (1001 out of range) becomes box: null on that line; good line stays", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: null,
                image: { mediaType: "image/jpeg", base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fields: [],
              transcripts: [
                {
                  doc: "invoice",
                  page: 1,
                  lines: [{ t: "text", b: [0, 0, 0, 1001] }, { t: "Total 10", b: [100, 100, 200, 20] }],
                },
              ],
              invoiceLineCount: null,
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      const result = await reader.read(testInput);

      expect(result.output.transcripts).toHaveLength(1);
      expect(result.output.transcripts[0]!.lines).toHaveLength(2);
      
      // Bad line becomes box: null
      expect(result.output.transcripts[0]!.lines[0]!.text).toBe("text");
      expect(result.output.transcripts[0]!.lines[0]!.box).toBe(null);
      
      // Good line stays
      expect(result.output.transcripts[0]!.lines[1]!.text).toBe("Total 10");
      expect(result.output.transcripts[0]!.lines[1]!.box!).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.02 });
    });

    it("b = [-1, 0, 0, 0] (negative) becomes box: null on that line; good line stays", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: null,
                image: { mediaType: "image/jpeg", base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fields: [],
              transcripts: [
                {
                  doc: "invoice",
                  page: 1,
                  lines: [{ t: "text", b: [-1, 0, 0, 0] }, { t: "Total 10", b: [100, 100, 200, 20] }],
                },
              ],
              invoiceLineCount: null,
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      const result = await reader.read(testInput);

      expect(result.output.transcripts).toHaveLength(1);
      expect(result.output.transcripts[0]!.lines).toHaveLength(2);
      
      // Bad line becomes box: null
      expect(result.output.transcripts[0]!.lines[0]!.text).toBe("text");
      expect(result.output.transcripts[0]!.lines[0]!.box).toBe(null);
      
      // Good line stays
      expect(result.output.transcripts[0]!.lines[1]!.text).toBe("Total 10");
      expect(result.output.transcripts[0]!.lines[1]!.box!).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.02 });
    });

    it("b = [0.5, 0, 0, 0] (not integer) becomes box: null on that line; good line stays", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: null,
                image: { mediaType: "image/jpeg", base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fields: [],
              transcripts: [
                {
                  doc: "invoice",
                  page: 1,
                  lines: [{ t: "text", b: [0.5, 0, 0, 0] }, { t: "Total 10", b: [100, 100, 200, 20] }],
                },
              ],
              invoiceLineCount: null,
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      const result = await reader.read(testInput);

      expect(result.output.transcripts).toHaveLength(1);
      expect(result.output.transcripts[0]!.lines).toHaveLength(2);
      
      // Bad line becomes box: null
      expect(result.output.transcripts[0]!.lines[0]!.text).toBe("text");
      expect(result.output.transcripts[0]!.lines[0]!.box).toBe(null);
      
      // Good line stays
      expect(result.output.transcripts[0]!.lines[1]!.text).toBe("Total 10");
      expect(result.output.transcripts[0]!.lines[1]!.box!).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.02 });
    });

    it("b = '1,2,3,4' (string instead of array) becomes box: null on that line; good line stays", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: null,
                image: { mediaType: "image/jpeg", base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fields: [],
              transcripts: [
                {
                  doc: "invoice",
                  page: 1,
                  lines: [{ t: "text", b: "1,2,3,4" }, { t: "Total 10", b: [100, 100, 200, 20] }],
                },
              ],
              invoiceLineCount: null,
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      const result = await reader.read(testInput);

      expect(result.output.transcripts).toHaveLength(1);
      expect(result.output.transcripts[0]!.lines).toHaveLength(2);
      
      // Bad line becomes box: null
      expect(result.output.transcripts[0]!.lines[0]!.text).toBe("text");
      expect(result.output.transcripts[0]!.lines[0]!.box).toBe(null);
      
      // Good line stays
      expect(result.output.transcripts[0]!.lines[1]!.text).toBe("Total 10");
      expect(result.output.transcripts[0]!.lines[1]!.box!).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.02 });
    });

    it("old shape { text: 'Total 10', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.02 } } is left out; good line stays", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 1200,
                height: 1600,
                text: null,
                image: { mediaType: "image/jpeg" as const, base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fields: [],
              transcripts: [
                {
                  doc: "invoice",
                  page: 1,
                  lines: [{ text: "Total 10", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.02 } }, { t: "Line 2", b: [100, 100, 200, 20] }],
                },
              ],
              invoiceLineCount: null,
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      const result = await reader.read(testInput);

      expect(result.output.transcripts).toHaveLength(1);
      // Old shape line is left out, only good line stays
      expect(result.output.transcripts[0]!.lines).toHaveLength(1);
      expect(result.output.transcripts[0]!.lines[0]!.text).toBe("Line 2");
      expect(result.output.transcripts[0]!.lines[0]!.box).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.02 });
    });

    it("b = [900, 0, 200, 10] (x + w = 1100, past page) becomes box: null; good line stays", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 612,
                height: 792,
                text: null,
                image: { mediaType: "image/jpeg", base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fields: [],
              transcripts: [
                {
                  doc: "invoice",
                  page: 1,
                  lines: [{ t: "text", b: [900, 0, 200, 10] }, { t: "Total 10", b: [100, 100, 200, 20] }],
                },
              ],
              invoiceLineCount: null,
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      const result = await reader.read(testInput);

      expect(result.output.transcripts).toHaveLength(1);
      expect(result.output.transcripts[0]!.lines).toHaveLength(2);
      
      // Bad line becomes box: null
      expect(result.output.transcripts[0]!.lines[0]!.text).toBe("text");
      expect(result.output.transcripts[0]!.lines[0]!.box).toBe(null);
      
      // Good line stays
      expect(result.output.transcripts[0]!.lines[1]!.text).toBe("Total 10");
      expect(result.output.transcripts[0]!.lines[1]!.box!).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.02 });
    });

    it("image page without a transcript rejects the whole answer with 'missing transcript' message", async () => {
      const testInput: ReaderInput = {
        bundle: "test",
        documents: [
          {
            docId: "invoice",
            kind: "invoice",
            fileName: "invoice.pdf",
            fileSha256: "a".repeat(64),
            pages: [
              {
                page: 1,
                width: 1200,
                height: 1600,
                text: null,
                image: { mediaType: "image/jpeg", base64: "QUJD" },
              },
            ],
          },
        ],
      };

      const { client } = makeClient(async () => ({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fields: [],
              transcripts: [], // Missing transcript for the image page
              invoiceLineCount: null,
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

      try {
        await reader.read(testInput);
        expect.fail("should have thrown");
      } catch (e) {
        if (!(e instanceof ReaderError)) throw e;
        expect(e.message).toContain("missing transcript");
        expect(e.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
      }
    });
  });
});
