import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ReaderInput, ReaderOutput } from "../core/readerContract";
import type { IntakeReader, ReaderResult } from "./readerTypes";
import { ReaderError } from "./readerTypes";

export type Recording = {
  name: string;
  filesSha256: string[];
  output: ReaderOutput;
};

function sortedFilesKey(fileSha256: string[]): string {
  return [...fileSha256].sort().join(",");
}

export function createFakeReader(recordings: Recording[]): IntakeReader {
  const recordingMap = new Map<string, Recording>();

  for (const recording of recordings) {
    const key = sortedFilesKey(recording.filesSha256);
    recordingMap.set(key, recording);
  }

  return {
    name: "fake:recordings",

    async read(input: unknown): Promise<ReaderResult> {
      // Input must be a ReaderInput object
      if (!input || typeof input !== "object") {
        throw new ReaderError("invalid input: not an object");
      }

      const obj = input as Record<string, unknown>;

      // Extract filesSha256 from documents
      if (!Array.isArray(obj.documents)) {
        throw new ReaderError("invalid input: documents is not an array");
      }

      const fileSha256: string[] = [];
      for (const doc of obj.documents) {
        if (!doc || typeof doc !== "object") {
          throw new ReaderError("invalid input: document is not an object");
        }
        const docObj = doc as Record<string, unknown>;
        if (typeof docObj.fileSha256 !== "string") {
          throw new ReaderError("invalid input: fileSha256 is not a string");
        }
        fileSha256.push(docObj.fileSha256);
      }

      const key = sortedFilesKey(fileSha256);
      const recording = recordingMap.get(key);

      if (!recording) {
        throw new ReaderError("no recorded answer for these files");
      }

      // Return a deep clone of the output with reader name updated
      const result: ReaderResult = {
        output: {
          ...structuredClone(recording.output),
          reader: `fake:${recording.name}`,
        },
        usage: { inputTokens: 0, outputTokens: 0 },
      };

      return result;
    },
  };
}

export async function loadRecordings(dir: string): Promise<Recording[]> {
  let entries: string[];

  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    // Missing directory gives an empty list
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
  const recordings: Recording[] = [];

  for (const file of jsonFiles) {
    const filePath = path.join(dir, file);
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);

    // Validate the recording structure
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Invalid recording in ${file}: not an object`);
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.name !== "string") {
      throw new Error(`Invalid recording in ${file}: name is not a string`);
    }

    if (!Array.isArray(obj.filesSha256)) {
      throw new Error(`Invalid recording in ${file}: filesSha256 is not an array`);
    }

    // Validate each file SHA256
    for (let i = 0; i < obj.filesSha256.length; i++) {
      const sha = obj.filesSha256[i];
      if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
        throw new Error(`Invalid recording in ${file}: filesSha256[${i}] is not a 64-char hex string`);
      }
    }

    if (!obj.output || typeof obj.output !== "object") {
      throw new Error(`Invalid recording in ${file}: output is not an object`);
    }

    const output = obj.output as Record<string, unknown>;

    if (!Array.isArray(output.fields)) {
      throw new Error(`Invalid recording in ${file}: output.fields is not an array`);
    }

    if (!Array.isArray(output.transcripts)) {
      throw new Error(`Invalid recording in ${file}: output.transcripts is not an array`);
    }

    recordings.push({
      name: obj.name,
      filesSha256: obj.filesSha256 as string[],
      output: parsed as ReaderOutput,
    });
  }

  return recordings;
}
