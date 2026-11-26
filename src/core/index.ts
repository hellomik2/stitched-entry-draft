export * from "./pdfText";
export * from "./reading";
export * from "./hts";
export * from "./parse";
export * from "./draft";
export * from "./csv";
export * from "./sheet";
export * from "./intakeConfig";
export * from "./fieldCatalog";
export * from "./transcript";
export * from "./readerContract";
export * from "./budget";
export * from "./partsList";
export * from "./codeTables";
export * from "./mid";
export * from "./exchangeRate";

import type { DocumentText } from "./pdfText";
import type { DocumentReader } from "./reading";
import { verifyReadings } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import { buildDraft } from "./draft";
import { draftToCsv } from "./csv";
import type { HtsTable } from "./hts";
import type { Draft, Override } from "./draft";

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
