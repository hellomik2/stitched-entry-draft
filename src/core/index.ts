export * from "./pdfText";
export * from "./reading";
export * from "./hts";
export * from "./parse";
export * from "./draft";
export * from "./csv";

import type { DocumentText, DocumentReader } from "./index.js";
import { verifyReadings, validateReadingAnswer, frozenReader } from "./reading.js";
import type { ReadingAnswer, VerifiedReading } from "./reading.js";
import { buildDraft } from "./draft.js";
import { draftToCsv } from "./csv.js";
import type { HtsTable } from "./hts.js";
import type { Draft, Override } from "./draft.js";

export async function runPipeline(args: {
  bundle: string;
  documents: DocumentText[];
  reader: DocumentReader;
  hts: HtsTable;
  overrides?: Override[];
}): Promise<{
  answer: ReadingAnswer;
  verified: VerifiedReading[];
  draft: Draft;
  csv: string;
}> {
  const answer = await args.reader.read({ bundle: args.bundle, documents: args.documents });
  const verified = verifyReadings(answer, args.documents);
  const draft = buildDraft({
    bundle: args.bundle,
    reader: answer.reader,
    readings: verified,
    hts: args.hts,
    overrides: args.overrides,
  });
  const csv = draftToCsv(draft);
  return { answer, verified, draft, csv };
}
