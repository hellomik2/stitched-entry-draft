import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeReader, loadRecordings, type Recording } from "./fakeReader";
import { ReaderError } from "./readerTypes";
import type { ReaderInput, ReaderOutput } from "../core/readerContract";

describe("Property 19: Fake Reader SHA-256 Matching (9.1, 9.2)", () => {
  it("a recording for two SHA-256 values answers for an input with those two files in either order", async () => {
    const sha1 = "a".repeat(64);
    const sha2 = "b".repeat(64);

    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [],
    };

    const recording: Recording = {
      name: "test",
      filesSha256: [sha1, sha2],
      output,
    };

    const reader = createFakeReader([recording]);

    // Input with files in original order
    const input1: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "doc1",
          kind: "invoice",
          fileName: "inv.pdf",
          fileSha256: sha1,
          pages: [],
        },
        {
          docId: "doc2",
          kind: "packingList",
          fileName: "pack.pdf",
          fileSha256: sha2,
          pages: [],
        },
      ],
    };

    const result1 = await reader.read(input1);
    expect(result1.output.reader).toBe("fake:test");
    expect(result1.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    // Input with files in reversed order
    const input2: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "doc2",
          kind: "packingList",
          fileName: "pack.pdf",
          fileSha256: sha2,
          pages: [],
        },
        {
          docId: "doc1",
          kind: "invoice",
          fileName: "inv.pdf",
          fileSha256: sha1,
          pages: [],
        },
      ],
    };

    const result2 = await reader.read(input2);
    expect(result2.output.reader).toBe("fake:test");
  });

  it("an input with a different set rejects with a ReaderError", async () => {
    const sha1 = "a".repeat(64);

    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [],
    };

    const recording: Recording = {
      name: "test",
      filesSha256: [sha1],
      output,
    };

    const reader = createFakeReader([recording]);

    const input: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "doc1",
          kind: "invoice",
          fileName: "inv.pdf",
          fileSha256: "c".repeat(64),
          pages: [],
        },
      ],
    };

    await expect(reader.read(input)).rejects.toThrow(
      new ReaderError("no recorded answer for these files"),
    );
  });

  it("the returned output is a deep copy", async () => {
    const sha1 = "a".repeat(64);

    const originalOutput: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "invoiceNumber",
          value: "INV-123",
          quote: "Invoice #: INV-123",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [],
    };

    const recording: Recording = {
      name: "test",
      filesSha256: [sha1],
      output: originalOutput,
    };

    const reader = createFakeReader([recording]);

    const input: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "doc1",
          kind: "invoice",
          fileName: "inv.pdf",
          fileSha256: sha1,
          pages: [],
        },
      ],
    };

    const result1 = await reader.read(input);
    const result2 = await reader.read(input);

    // Mutate first result
    if (result1.output.fields[0]) {
      result1.output.fields[0].value = "MODIFIED";
    }

    // Second result should not be affected
    expect(result2.output.fields[0]?.value).toBe("INV-123");
  });

  it("pages with text never appear in the output", async () => {
    const sha1 = "a".repeat(64);

    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "invoiceNumber",
          value: "INV-123",
          quote: "Invoice #: INV-123",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [],
    };

    const recording: Recording = {
      name: "test",
      filesSha256: [sha1],
      output,
    };

    const reader = createFakeReader([recording]);

    // Try with various text content (including the string "SECRET-123")
    const input: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "doc1",
          kind: "invoice",
          fileName: "inv.pdf",
          fileSha256: sha1,
          pages: [
            {
              page: 1,
              width: 612,
              height: 792,
              text: "This is the SECRET-123 that should never appear in the output",
              image: null,
            },
          ],
        },
      ],
    };

    const result = await reader.read(input);

    // Output should still match the recording
    expect(result.output.fields[0]?.value).toBe("INV-123");
    expect(JSON.stringify(result.output)).not.toContain("SECRET-123");
  });
});

describe("fakeReader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-reader-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("loadRecordings on a temp dir with one good file", async () => {
    const sha1 = "a".repeat(64);
    const sha2 = "b".repeat(64);

    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [],
    };

    const recording: Recording = {
      name: "good",
      filesSha256: [sha1, sha2],
      output,
    };

    const filePath = path.join(tempDir, "recording.json");
    await fs.writeFile(filePath, JSON.stringify(recording), "utf-8");

    const recordings = await loadRecordings(tempDir);

    expect(recordings).toHaveLength(1);
    expect(recordings[0]?.name).toBe("good");
    expect(recordings[0]?.filesSha256).toEqual([sha1, sha2]);
  });

  it("loadRecordings on a missing dir gives an empty list", async () => {
    const missingDir = path.join(tempDir, "nonexistent");
    const recordings = await loadRecordings(missingDir);

    expect(recordings).toHaveLength(0);
  });

  it("loadRecordings throws on invalid file", async () => {
    const filePath = path.join(tempDir, "bad.json");
    await fs.writeFile(filePath, JSON.stringify({ name: "bad" }), "utf-8");

    await expect(loadRecordings(tempDir)).rejects.toThrow();
  });

  it("loadRecordings throws on non-hex filesSha256", async () => {
    const recording = {
      name: "bad",
      filesSha256: ["not-hex"],
      output: { reader: "test", fields: [], transcripts: [] },
    };

    const filePath = path.join(tempDir, "bad.json");
    await fs.writeFile(filePath, JSON.stringify(recording), "utf-8");

    await expect(loadRecordings(tempDir)).rejects.toThrow();
  });

  it("loadRecordings reads files in sorted order", async () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [],
    };

    // Create files in non-alphabetical order
    await fs.writeFile(
      path.join(tempDir, "z.json"),
      JSON.stringify({
        name: "z",
        filesSha256: ["a".repeat(64)],
        output,
      }),
      "utf-8",
    );

    await fs.writeFile(
      path.join(tempDir, "a.json"),
      JSON.stringify({
        name: "a",
        filesSha256: ["b".repeat(64)],
        output,
      }),
      "utf-8",
    );

    const recordings = await loadRecordings(tempDir);

    expect(recordings).toHaveLength(2);
    expect(recordings[0]?.name).toBe("a");
    expect(recordings[1]?.name).toBe("z");
  });
});
