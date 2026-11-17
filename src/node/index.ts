import { createRequire } from "node:module";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfLike } from "../core/pdfText.js";

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
