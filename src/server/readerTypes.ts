import type { ReaderOutput } from "../core/readerContract";

// Requirement 56.2: a count the SDK answer does not give is null.
export type ReaderUsage = { inputTokens: number | null; outputTokens: number | null };
export type ReaderResult = { output: ReaderOutput; usage: ReaderUsage };

export interface IntakeReader {
  readonly name: string;
  read(input: unknown): Promise<ReaderResult>;
}

export class ReaderError extends Error {
  constructor(message: string, readonly usage: ReaderUsage | null = null) {
    super(message);
    this.name = "ReaderError";
  }
}

export type UsageRecord = {
  timestamp: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostNanoUsd: number | null;
  filesSha256: string[];
  readerMode: "claude" | "fake" | "off";
  outcome: "success" | "error" | "cap-exceeded" | "kill-switch";
  errorMessage: string | null;
};
