import type { PDFDocumentProxy } from "pdfjs-dist";
import { RuleResult } from "../../rules/types";
import { DocKind, DocumentText, extractDocumentText, PdfLike } from "../../core/pdfText";
import { ReaderInput, ReaderDocument, ReaderPage, validateReaderInput } from "../../core/readerContract";
import { intakeConfig } from "../../core/intakeConfig";

export type UploadChoice = { file: File; kind: DocKind };

export type UploadedView = {
  docId: string;
  kind: DocKind;
  fileName: string;
  pdf: PDFDocumentProxy | null;
  imageUrl: string | null;
  pages: { page: number; width: number; height: number; source: "text" | "image" }[];
};

export type PreparedUpload = {
  input: ReaderInput;
  textDocs: DocumentText[];
  views: UploadedView[];
};

function getMbString(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) : "< 1";
}

async function sha256HexFromFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  return Array.from(view).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function prepareUpload(
  choices: UploadChoice[],
  limits = intakeConfig,
  onProgress?: (message: string) => void,
): Promise<RuleResult<PreparedUpload>> {
  // Check count
  if (choices.length < 1 || choices.length > limits.maxFiles) {
    return {
      ok: false,
      reason: `Choose between 1 and ${limits.maxFiles} files.`,
    };
  }

  const documents: ReaderDocument[] = [];
  const textDocs: DocumentText[] = [];
  const views: UploadedView[] = [];

  // Track kinds for docId assignment
  const kindCounters = new Map<DocKind, number>();

  let totalImagePages = 0;

  for (const choice of choices) {
    const file = choice.file;
    const kind = choice.kind;

    // Check file size
    if (file.size > limits.maxFileBytes) {
      const mb = getMbString(file.size);
      return {
        ok: false,
        reason: `${file.name}: ${mb} MB is over the ${getMbString(limits.maxFileBytes)} MB limit.`,
      };
    }

    // Determine if PDF or image
    const isPdf =
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf");

    const isImage =
      ["image/jpeg", "image/png"].includes(file.type) ||
      /\.(jpg|jpeg|png)$/i.test(file.name);

    if (!isPdf && !isImage) {
      return {
        ok: false,
        reason: `${file.name}: only PDF, JPEG and PNG files are accepted.`,
      };
    }

    // Generate docId
    const counter = (kindCounters.get(kind) || 0) + 1;
    kindCounters.set(kind, counter);
    const docId = counter === 1 ? kind : `${kind}${counter}`;

    // Get SHA256
    const fileSha256 = await sha256HexFromFile(file);

    // Process file
    if (isPdf) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

      let pdf: PDFDocumentProxy;
      try {
        const doc = pdfjs.getDocument({
          data: bytes.slice(),
          standardFontDataUrl: "/standard_fonts/",
        });
        pdf = await doc.promise;
      } catch (err) {
        return {
          ok: false,
          reason: `${file.name}: could not read PDF.`,
        };
      }

      // Check page count
      if (pdf.numPages > limits.maxPdfPages) {
        return {
          ok: false,
          reason: `${file.name}: ${pdf.numPages} pages is over the ${limits.maxPdfPages} page limit.`,
        };
      }

      // Extract text
      const documentText = await extractDocumentText(pdf as unknown as PdfLike, docId, kind);

      const pages: ReaderPage[] = [];

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        onProgress?.(`Reading ${file.name} page ${pageNum} of ${pdf.numPages}`);

        const pdfPage = await pdf.getPage(pageNum);
        const viewport = pdfPage.getViewport({ scale: 1 });
        const pageTextData = documentText.pages.find((p) => p.page === pageNum);

        if (!pageTextData) {
          return {
            ok: false,
            reason: `${file.name}: internal error extracting page ${pageNum}.`,
          };
        }

        // Count non-space characters
        const textLength = pageTextData.text.replace(/\s/g, "").length;

        if (textLength >= limits.minTextChars) {
          // Text page
          pages.push({
            page: pageNum,
            width: viewport.width,
            height: viewport.height,
            text: pageTextData.text,
            image: null,
          });
        } else {
          // Image page: render PDF page to image
          const scale = limits.maxImageLongSide / Math.max(viewport.width, viewport.height);
          const scaledViewport = pdfPage.getViewport({ scale });

          // Create canvas with scaled dimensions
          const canvasElement = document.createElement("canvas");
          canvasElement.width = scaledViewport.width;
          canvasElement.height = scaledViewport.height;

          const ctx = canvasElement.getContext("2d");
          if (!ctx) {
            return {
              ok: false,
              reason: `${file.name}: could not render page ${pageNum}.`,
            };
          }

          // Fill with white background
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);

          // Render PDF page to canvas
          await pdfPage.render({
            canvas: canvasElement,
            canvasContext: ctx,
            viewport: scaledViewport,
          }).promise;

          // Convert canvas to JPEG
          const dataUrl = canvasElement.toDataURL("image/jpeg", limits.jpegQuality);
          const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

          pages.push({
            page: pageNum,
            width: viewport.width,
            height: viewport.height,
            text: null,
            image: { mediaType: "image/jpeg", base64 },
          });

          totalImagePages++;
        }
      }

      documents.push({
        docId,
        kind,
        fileName: file.name,
        fileSha256,
        pages,
      });

      textDocs.push(documentText);

      views.push({
        docId,
        kind,
        fileName: file.name,
        pdf,
        imageUrl: null,
        pages: pages.map((p) => ({
          page: p.page,
          width: p.width,
          height: p.height,
          source: p.text !== null ? "text" : "image",
        })),
      });
    } else {
      // Image file (photo)
      onProgress?.(`Reading ${file.name}`);

      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, limits.maxImageLongSide / Math.max(bitmap.width, bitmap.height));
      const canvasWidth = Math.round(bitmap.width * scale);
      const canvasHeight = Math.round(bitmap.height * scale);

      const canvasElement = document.createElement("canvas");
      canvasElement.width = canvasWidth;
      canvasElement.height = canvasHeight;

      const ctx = canvasElement.getContext("2d");
      if (!ctx) {
        return {
          ok: false,
          reason: `${file.name}: could not render image.`,
        };
      }

      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);
      ctx.drawImage(bitmap, 0, 0, canvasElement.width, canvasElement.height);
      bitmap.close();

      const dataUrl = canvasElement.toDataURL("image/jpeg", limits.jpegQuality);
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

      const readerPage: ReaderPage = {
        page: 1,
        width: canvasWidth,
        height: canvasHeight,
        text: null,
        image: { mediaType: "image/jpeg", base64 },
      };

      documents.push({
        docId,
        kind,
        fileName: file.name,
        fileSha256,
        pages: [readerPage],
      });

      views.push({
        docId,
        kind,
        fileName: file.name,
        pdf: null,
        imageUrl: dataUrl,
        pages: [{ page: 1, width: canvasWidth, height: canvasHeight, source: "image" }],
      });

      totalImagePages++;
    }
  }

  // Check total image pages
  if (totalImagePages > limits.maxImagePages) {
    return {
      ok: false,
      reason: `The documents have ${totalImagePages} image pages; at most ${limits.maxImagePages} are read in one go.`,
    };
  }

  // Build input
  const input: ReaderInput = {
    bundle: "upload",
    documents,
  };

  // Check request size
  const requestBytes = new TextEncoder().encode(JSON.stringify(input)).length;
  if (requestBytes > limits.maxRequestBytes) {
    const mb = (requestBytes / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: `The documents are too large to send (${mb} MB, at most ${getMbString(limits.maxRequestBytes)} MB). Use fewer pages or smaller photos.`,
    };
  }

  // Validate input
  const validation = validateReaderInput(input, limits, requestBytes);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    value: {
      input,
      textDocs,
      views,
    },
  };
}
