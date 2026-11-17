import { createRequire } from "node:module";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";
import type { PdfLike } from "../core/pdfText.js";
import type { DocKind } from "../core/index.js";
import { extractDocumentText, type DocumentText } from "../core/index.js";
import { validateReadingAnswer, type ReadingAnswer, type VerifiedReading } from "../core/index.js";
import { runPipeline } from "../core/index.js";
import type { HtsTable, Draft } from "../core/index.js";
import type { Override } from "../core/index.js";

export type BundleManifest = {
  bundle: string;
  title: string;
  documents: {
    docId: string;
    kind: DocKind;
    file: string;
    label: string;
  }[];
};

export async function openPdf(bytes: Uint8Array): Promise<PdfLike> {
  const require = createRequire(import.meta.url);
  const pdfJsDistPath = require.resolve("pdfjs-dist/package.json");
  const pdfJsDistDir = join(pdfJsDistPath, "..");
  const standardFontDataUrl = join(pdfJsDistDir, "standard_fonts").split("\\").join("/") + "/";

  const pdf = await getDocument({
    data: bytes,
    standardFontDataUrl,
    verbosity: 0,
  }).promise;

  return pdf;
}

export async function loadBundleFromDisk(
  root: string,
  bundle: string
): Promise<{
  manifest: BundleManifest;
  answer: ReadingAnswer;
  hts: HtsTable;
  documents: DocumentText[];
}> {
  // Read bundle.json
  const bundleJsonPath = join(root, "samples", bundle, "bundle.json");
  const bundleJson = JSON.parse(readFileSync(bundleJsonPath, "utf-8")) as BundleManifest;

  // Read reading.json
  const readingJsonPath = join(root, "samples", bundle, "reading.json");
  const readingJsonRaw = JSON.parse(readFileSync(readingJsonPath, "utf-8"));
  const readingValidation = validateReadingAnswer(readingJsonRaw);
  if (!readingValidation.ok) {
    throw new Error(`Invalid reading.json: ${readingValidation.reason}`);
  }
  const answer = readingValidation.value;

  // Read HTS data
  const htsJsonPath = join(root, "data", "hts", "2026HTSRev23-subset.json");
  const hts = JSON.parse(readFileSync(htsJsonPath, "utf-8")) as HtsTable;

  // Load PDFs and extract documents
  const documents: DocumentText[] = [];
  for (const doc of bundleJson.documents) {
    const pdfPath = join(root, "public", "samples", bundle, doc.file);
    const pdfBytes = readFileSync(pdfPath);
    const pdf = await openPdf(new Uint8Array(pdfBytes));
    const documentText = await extractDocumentText(pdf, doc.docId, doc.kind);
    documents.push(documentText);
  }

  return { manifest: bundleJson, answer, hts, documents };
}

export async function runBundleFromDisk(
  root: string,
  bundle: string,
  overrides?: Override[]
): Promise<{
  manifest: BundleManifest;
  answer: ReadingAnswer;
  verified: VerifiedReading[];
  draft: Draft;
  csv: string;
  documents: DocumentText[];
  hts: HtsTable;
}> {
  const { manifest, answer, hts, documents } = await loadBundleFromDisk(root, bundle);

  // Import frozenReader from core to get a reader that returns the pre-recorded answer
  const { frozenReader } = await import("../core/index.js");
  const reader = frozenReader(answer);

  const pipelineResult = await runPipeline({
    bundle,
    documents,
    reader,
    hts,
    overrides,
  });

  return {
    manifest,
    answer,
    verified: pipelineResult.verified,
    draft: pipelineResult.draft,
    csv: pipelineResult.csv,
    documents,
    hts,
  };
}
