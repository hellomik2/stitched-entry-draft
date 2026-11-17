import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClaudeClientLike, ClaudeResponseLike } from "./claudeReader";
import {
  createClaudeReader,
  READER_SYSTEM_PROMPT,
  READER_OUTPUT_SCHEMA,
  buildReaderRequest,
  mapSdkError,
} from "./claudeReader";
import type { ReaderInput, ReaderOutput } from "../core/readerContract";
import { ReaderError } from "./readerTypes";
import { FIELD_CATALOG } from "../core/fieldCatalog";

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
    const modelJson = recording.output;

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
        { type: "text", text: JSON.stringify(modelJson) },
      ],
      usage: { input_tokens: 1200, output_tokens: 300 },
    }));

    const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
    const result = await reader.read(testInput);

    expect(result.output.fields).toEqual(modelJson.fields);
    expect(result.output.reader).toBe("claude-haiku-5-5");
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(calls).toHaveLength(1);
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
      const modelJson = recording.output;

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
        content: [{ type: "text", text: JSON.stringify(modelJson) }],
        usage: { input_tokens: 1200, output_tokens: 300 },
      }));

      const reader = createClaudeReader({ apiKey: "test-key-not-real", client });
      await reader.read(testInput);

      expect(calls).toHaveLength(1);
      const params = calls[0]!;

      // Check model and max_tokens
      expect(params.model).toBe("claude-haiku-5-5");
      expect(params.max_tokens).toBe(16000);

      // Check output_config
      expect(params.output_config).toBeDefined();
      expect((params.output_config as any).effort).toBe("low");
      expect((params.output_config as any).format.type).toBe("json_schema");

      // Check no temperature, top_p, top_k, thinking
      expect((params as any).temperature).toBeUndefined();
      expect((params as any).top_p).toBeUndefined();
      expect((params as any).top_k).toBeUndefined();
      expect((params as any).thinking).toBeUndefined();

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
  });

  describe("Feature: document-intake, Property 20: Claude Reader No Retries", () => {
    it("source code contains maxRetries: 0 and does not contain process.env", async () => {
      const sourceFile = path.join(process.cwd(), "src", "server", "claudeReader.ts");
      const source = await fs.readFile(sourceFile, "utf-8");

      expect(source).toContain("maxRetries: 0");
      expect(source).not.toContain("process.env");
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

  it('text "[]" with stop_reason end_turn rejects with message about output must be object', async () => {
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
      content: [{ type: "text", text: "[]" }],
      usage: { input_tokens: 1200, output_tokens: 300 },
    }));

    const reader = createClaudeReader({ apiKey: "test-key-not-real", client });

    try {
      await reader.read(testInput);
      expect.fail("should have thrown");
    } catch (e) {
      if (!(e instanceof ReaderError)) throw e;
      expect(e.message).toContain("The reader answer was not valid: output must be an object");
    }
  });
});