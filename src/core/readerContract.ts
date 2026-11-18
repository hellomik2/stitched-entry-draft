import { RuleResult } from "../rules/types";
import { DocKind } from "./pdfText";
import { FieldReading, ReadingAnswer } from "./reading";
import { isCatalogField } from "./fieldCatalog";
import { intakeConfig } from "./intakeConfig";
import { transcriptToPageText, TranscriptLine } from "./transcript";
import { DocumentText } from "./pdfText";

export type ReaderPage = {
  page: number;
  width: number;
  height: number;
  text: string | null;
  image: { mediaType: "image/jpeg"; base64: string } | null;
};

export type ReaderDocument = {
  docId: string;
  kind: DocKind;
  fileName: string;
  fileSha256: string;
  pages: ReaderPage[];
};

export type ReaderInput = {
  bundle: string;
  documents: ReaderDocument[];
};

export type TranscriptPage = {
  doc: string;
  page: number;
  lines: TranscriptLine[];
};

export type ReaderOutput = {
  reader: string;
  fields: FieldReading[];
  transcripts: TranscriptPage[];
  invoiceLineCount?: number | null;
};

function isValidBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

function isValidSha256(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

function isValidDocId(s: string): boolean {
  return /^[A-Za-z0-9_-]{1,40}$/.test(s);
}

export function validateReaderInput(
  json: unknown,
  limits = intakeConfig,
  requestBytes?: number,
): RuleResult<ReaderInput> {
  // Check if it's an object
  if (!json || typeof json !== "object") {
    return { ok: false, reason: "input must be an object" };
  }

  const obj = json as Record<string, unknown>;

  // Check bundle
  if (typeof obj.bundle !== "string" || obj.bundle === "") {
    return { ok: false, reason: "bundle must be a non-empty string" };
  }

  // Check documents is an array
  if (!Array.isArray(obj.documents)) {
    return { ok: false, reason: "documents must be an array" };
  }

  // Check document count
  if (obj.documents.length < 1 || obj.documents.length > limits.maxFiles) {
    return {
      ok: false,
      reason: `documents must have 1..${limits.maxFiles} items`,
    };
  }

  // Check requestBytes if given
  if (requestBytes !== undefined && requestBytes > limits.maxRequestBytes) {
    return { ok: false, reason: "request is too large" };
  }

  // Track docIds for uniqueness
  const seenDocIds = new Set<string>();
  let totalImagePages = 0;

  // Validate each document
  for (let docIndex = 0; docIndex < obj.documents.length; docIndex++) {
    const doc = obj.documents[docIndex];

    if (!doc || typeof doc !== "object") {
      return { ok: false, reason: `documents[${docIndex}]: must be an object` };
    }

    const docObj = doc as Record<string, unknown>;

    // Check docId
    if (typeof docObj.docId !== "string" || !isValidDocId(docObj.docId)) {
      return {
        ok: false,
        reason: `documents[${docIndex}].docId: must match /^[A-Za-z0-9_-]{1,40}$/`,
      };
    }

    if (seenDocIds.has(docObj.docId)) {
      return {
        ok: false,
        reason: `documents[${docIndex}].docId: "${docObj.docId}" is not unique`,
      };
    }
    seenDocIds.add(docObj.docId);

    // Check kind
    if (!["invoice", "packingList", "billOfLading"].includes(docObj.kind as string)) {
      return {
        ok: false,
        reason: `documents[${docIndex}].kind: must be "invoice", "packingList", or "billOfLading"`,
      };
    }

    // Check fileName
    if (typeof docObj.fileName !== "string" || docObj.fileName.length < 1 || docObj.fileName.length > 200) {
      return {
        ok: false,
        reason: `documents[${docIndex}].fileName: must be a string of 1..200 chars`,
      };
    }

    // Check fileSha256
    if (typeof docObj.fileSha256 !== "string" || !isValidSha256(docObj.fileSha256)) {
      return {
        ok: false,
        reason: `documents[${docIndex}].fileSha256: must match /^[0-9a-f]{64}$/`,
      };
    }

    // Check pages is an array
    if (!Array.isArray(docObj.pages)) {
      return {
        ok: false,
        reason: `documents[${docIndex}].pages: must be an array`,
      };
    }

    // Check page count
    if (docObj.pages.length < 1 || docObj.pages.length > limits.maxPdfPages) {
      return {
        ok: false,
        reason: `documents[${docIndex}].pages: must have 1..${limits.maxPdfPages} items`,
      };
    }

    // Validate page numbers are 1..n in order
    for (let pageIndex = 0; pageIndex < docObj.pages.length; pageIndex++) {
      const expectedPageNum = pageIndex + 1;
      const page = docObj.pages[pageIndex];

      if (!page || typeof page !== "object") {
        return {
          ok: false,
          reason: `documents[${docIndex}].pages[${pageIndex}]: must be an object`,
        };
      }

      const pageObj = page as Record<string, unknown>;

      // Check page number
      if (pageObj.page !== expectedPageNum) {
        return {
          ok: false,
          reason: `documents[${docIndex}].pages[${pageIndex}].page: must be ${expectedPageNum}`,
        };
      }

      // Check width and height
      if (typeof pageObj.width !== "number" || !Number.isFinite(pageObj.width) || pageObj.width <= 0) {
        return {
          ok: false,
          reason: `documents[${docIndex}].pages[${pageIndex}].width: must be a positive finite number`,
        };
      }

      if (typeof pageObj.height !== "number" || !Number.isFinite(pageObj.height) || pageObj.height <= 0) {
        return {
          ok: false,
          reason: `documents[${docIndex}].pages[${pageIndex}].height: must be a positive finite number`,
        };
      }

      // Check text and image (exactly one must be non-null)
      const hasText = pageObj.text !== null;
      const hasImage = pageObj.image !== null;

      if (hasText && hasImage) {
        return {
          ok: false,
          reason: `documents[${docIndex}].pages[${pageIndex}]: give either text or image, not both`,
        };
      }

      if (!hasText && !hasImage) {
        return {
          ok: false,
          reason: `documents[${docIndex}].pages[${pageIndex}]: give either text or image, not neither`,
        };
      }

      // Validate text if present
      if (hasText) {
        if (typeof pageObj.text !== "string") {
          return {
            ok: false,
            reason: `documents[${docIndex}].pages[${pageIndex}].text: must be a string`,
          };
        }

        // Check text page length
        if ((pageObj.text as string).length > limits.perCall.maxPageTextChars) {
          return {
            ok: false,
            reason: `documents[${docIndex}].pages[${pageIndex}].text: more than ${limits.perCall.maxPageTextChars} characters; split the document and upload fewer pages`,
          };
        }
      }

      // Validate image if present
      if (hasImage) {
        const imageObj = pageObj.image as Record<string, unknown>;

        if (typeof imageObj.mediaType !== "string" || imageObj.mediaType !== "image/jpeg") {
          return {
            ok: false,
            reason: `documents[${docIndex}].pages[${pageIndex}].image.mediaType: must be "image/jpeg"`,
          };
        }

        if (typeof imageObj.base64 !== "string" || imageObj.base64 === "") {
          return {
            ok: false,
            reason: `documents[${docIndex}].pages[${pageIndex}].image.base64: must be a non-empty string`,
          };
        }

        if (!isValidBase64(imageObj.base64)) {
          return {
            ok: false,
            reason: `documents[${docIndex}].pages[${pageIndex}].image.base64: must match /^[A-Za-z0-9+/]+={0,2}$/`,
          };
        }

        // Check image base64 length
        if ((imageObj.base64 as string).length > limits.perCall.maxImageBase64Chars) {
          return {
            ok: false,
            reason: `documents[${docIndex}].pages[${pageIndex}].image: more than ${limits.perCall.maxImageBase64Chars} base64 characters; use a smaller image`,
          };
        }

        totalImagePages++;
      }
    }
  }

  // Check total image pages
  if (totalImagePages > limits.maxImagePages) {
    return {
      ok: false,
      reason: `total image pages (${totalImagePages}) exceeds limit (${limits.maxImagePages})`,
    };
  }

  // Check total text length
  let totalTextChars = 0;
  for (const doc of obj.documents) {
    for (const page of doc.pages as Array<Record<string, unknown>>) {
      if (page.text !== null && typeof page.text === "string") {
        totalTextChars += page.text.length;
      }
    }
  }

  if (totalTextChars > limits.perCall.maxTotalTextChars) {
    return {
      ok: false,
      reason: `page texts total ${totalTextChars} characters, more than ${limits.perCall.maxTotalTextChars}; split the documents and upload fewer pages`,
    };
  }

  return { ok: true, value: obj as ReaderInput };
}

export function validateReaderOutput(json: unknown, input: ReaderInput): RuleResult<ReaderOutput> {
  // Check if it's an object
  if (!json || typeof json !== "object") {
    return { ok: false, reason: "output must be an object" };
  }

  const obj = json as Record<string, unknown>;

  // Check reader is a string
  if (typeof obj.reader !== "string") {
    return { ok: false, reason: "reader must be a string" };
  }

  // Check fields is an array
  if (!Array.isArray(obj.fields)) {
    return { ok: false, reason: "fields must be an array" };
  }

  // Check transcripts is an array
  if (!Array.isArray(obj.transcripts)) {
    return { ok: false, reason: "transcripts must be an array" };
  }

  // Build maps for validation
  const docMap = new Map<string, ReaderDocument>();
  const imagePageMap = new Map<string, ReaderPage>();

  for (const doc of input.documents) {
    docMap.set(doc.docId, doc);
    for (const page of doc.pages) {
      if (page.image !== null) {
        imagePageMap.set(`${doc.docId}:${page.page}`, page);
      }
    }
  }

  // Track seen field names for uniqueness
  const seenFields = new Set<string>();

  // Validate each field
  for (let fieldIndex = 0; fieldIndex < obj.fields.length; fieldIndex++) {
    const field = obj.fields[fieldIndex];

    if (!field || typeof field !== "object") {
      return {
        ok: false,
        reason: `fields[${fieldIndex}]: must be an object`,
      };
    }

    const fieldObj = field as Record<string, unknown>;

    // Check field name is in catalog
    if (typeof fieldObj.field !== "string") {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].field: must be a string`,
      };
    }

    if (!isCatalogField(fieldObj.field)) {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].field: not in the catalog`,
      };
    }

    // Check field is unique
    if (seenFields.has(fieldObj.field)) {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].field: appears more than once`,
      };
    }
    seenFields.add(fieldObj.field);

    // Check value is string or null
    if (fieldObj.value !== null && typeof fieldObj.value !== "string") {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].value: must be a string or null`,
      };
    }

    // Check quote is a string
    if (typeof fieldObj.quote !== "string") {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].quote: must be a string`,
      };
    }

    // Check doc exists
    if (typeof fieldObj.doc !== "string") {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].doc: must be a string`,
      };
    }

    if (!docMap.has(fieldObj.doc)) {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].doc: unknown document`,
      };
    }

    // Check page exists in the document
    if (!Number.isInteger(fieldObj.page) || (fieldObj.page as number) < 1) {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].page: must be a positive integer`,
      };
    }

    const doc = docMap.get(fieldObj.doc)!;
    const pageExists = doc.pages.some((p) => p.page === fieldObj.page);
    if (!pageExists) {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].page: no such page in that document`,
      };
    }

    // Check confidence (required in reader output)
    if (!["high", "low"].includes(fieldObj.confidence as string)) {
      return {
        ok: false,
        reason: `fields[${fieldIndex}].confidence: must be "high" or "low"`,
      };
    }
  }

  // Check invoiceLineCount if present
  if (obj.invoiceLineCount !== undefined) {
    if (obj.invoiceLineCount !== null && (!Number.isInteger(obj.invoiceLineCount) || (obj.invoiceLineCount as number) < 0 || (obj.invoiceLineCount as number) > 999)) {
      return { ok: false, reason: "invoiceLineCount: must be null or an integer from 0 to 999" };
    }
  }

  // Track which image pages have transcripts
  const transcriptedPages = new Set<string>();

  // Validate each transcript
  for (let transcriptIndex = 0; transcriptIndex < obj.transcripts.length; transcriptIndex++) {
    const transcript = obj.transcripts[transcriptIndex];

    if (!transcript || typeof transcript !== "object") {
      return {
        ok: false,
        reason: `transcripts[${transcriptIndex}]: must be an object`,
      };
    }

    const transcriptObj = transcript as Record<string, unknown>;

    // Check doc exists
    if (typeof transcriptObj.doc !== "string") {
      return {
        ok: false,
        reason: `transcripts[${transcriptIndex}].doc: must be a string`,
      };
    }

    if (!docMap.has(transcriptObj.doc)) {
      return {
        ok: false,
        reason: `transcripts[${transcriptIndex}].doc: unknown document`,
      };
    }

    // Check page number
    if (!Number.isInteger(transcriptObj.page) || (transcriptObj.page as number) < 1) {
      return {
        ok: false,
        reason: `transcripts[${transcriptIndex}].page: must be a positive integer`,
      };
    }

    const pageKey = `${transcriptObj.doc}:${transcriptObj.page}`;
    const imagePage = imagePageMap.get(pageKey);

    if (!imagePage) {
      return {
        ok: false,
        reason: `transcripts[${transcriptIndex}]: not an image page`,
      };
    }

    transcriptedPages.add(pageKey);

    // Check lines is an array
    if (!Array.isArray(transcriptObj.lines)) {
      return {
        ok: false,
        reason: `transcripts[${transcriptIndex}].lines: must be an array`,
      };
    }

    // Validate each line
    for (let lineIndex = 0; lineIndex < transcriptObj.lines.length; lineIndex++) {
      const line = transcriptObj.lines[lineIndex];

      if (!line || typeof line !== "object") {
        return {
          ok: false,
          reason: `transcripts[${transcriptIndex}].lines[${lineIndex}]: must be an object`,
        };
      }

      const lineObj = line as Record<string, unknown>;

      // Check text
      if (typeof lineObj.text !== "string") {
        return {
          ok: false,
          reason: `transcripts[${transcriptIndex}].lines[${lineIndex}].text: must be a string`,
        };
      }

      // Check box
      if (!lineObj.box || typeof lineObj.box !== "object") {
        return {
          ok: false,
          reason: `transcripts[${transcriptIndex}].lines[${lineIndex}].box: must be an object`,
        };
      }

      const boxObj = lineObj.box as Record<string, unknown>;

      // Check box coordinates
      for (const coord of ["x", "y", "w", "h"]) {
        if (typeof boxObj[coord] !== "number" || !Number.isFinite(boxObj[coord] as number)) {
          return {
            ok: false,
            reason: `transcripts[${transcriptIndex}].lines[${lineIndex}].box.${coord}: must be a finite number`,
          };
        }

        const val = boxObj[coord] as number;
        if (val < 0 || val > 1) {
          return {
            ok: false,
            reason: `transcripts[${transcriptIndex}].lines[${lineIndex}].box.${coord}: must be in [0, 1]`,
          };
        }
      }

      const x = boxObj.x as number;
      const y = boxObj.y as number;
      const w = boxObj.w as number;
      const h = boxObj.h as number;

      // Check x + w <= 1.001 (with tolerance)
      if (x + w > 1.001) {
        return {
          ok: false,
          reason: `transcripts[${transcriptIndex}].lines[${lineIndex}].box: x + w must be <= 1.001`,
        };
      }

      // Check y + h <= 1.001 (with tolerance)
      if (y + h > 1.001) {
        return {
          ok: false,
          reason: `transcripts[${transcriptIndex}].lines[${lineIndex}].box: y + h must be <= 1.001`,
        };
      }
    }
  }

  // Check that every image page has exactly one transcript
  for (const [pageKey] of imagePageMap) {
    if (!transcriptedPages.has(pageKey)) {
      const [docId, pageNum] = pageKey.split(":");
      return {
        ok: false,
        reason: `missing transcript for image page ${pageNum} of document "${docId}"`,
      };
    }
  }

  return { ok: true, value: obj as ReaderOutput };
}

export function readerOutputToAnswer(input: ReaderInput, output: ReaderOutput): ReadingAnswer {
  const answer: ReadingAnswer = {
    schemaVersion: 1,
    bundle: input.bundle,
    reader: output.reader,
    documents: input.documents.map((d) => ({ docId: d.docId, kind: d.kind })),
    fields: output.fields,
  };
  if (output.invoiceLineCount !== undefined) {
    answer.invoiceLineCount = output.invoiceLineCount;
  }
  return answer;
}

export function composeDocumentTexts(
  textDocs: DocumentText[],
  input: ReaderInput,
  output: ReaderOutput,
): DocumentText[] {
  // Build a map of docId -> document
  const textDocMap = new Map<string, DocumentText>();
  for (const doc of textDocs) {
    textDocMap.set(doc.docId, doc);
  }

  // Build a map of docId:page -> transcript
  const transcriptMap = new Map<string, TranscriptPage>();
  for (const transcript of output.transcripts) {
    transcriptMap.set(`${transcript.doc}:${transcript.page}`, transcript);
  }

  const result: DocumentText[] = [];

  for (const inputDoc of input.documents) {
    const docId = inputDoc.docId;

    const pages: DocumentText["pages"] = [];

    for (const inputPage of inputDoc.pages) {
      if (inputPage.text !== null) {
        // Text page: take from textDocs
        const textDoc = textDocMap.get(docId);
        if (!textDoc) {
          throw new Error(`Programmer error: text document "${docId}" not found`);
        }

        const matchingPage = textDoc.pages.find((p) => p.page === inputPage.page);
        if (!matchingPage) {
          throw new Error(
            `Programmer error: text page ${inputPage.page} of document "${docId}" not found in textDocs`,
          );
        }
        pages.push(matchingPage);
      } else {
        // Image page: build from transcript
        const transcriptKey = `${docId}:${inputPage.page}`;
        const transcript = transcriptMap.get(transcriptKey);
        if (!transcript) {
          throw new Error(`Programmer error: transcript for page ${inputPage.page} of document "${docId}" not found`);
        }

        const pageText = transcriptToPageText(
          docId,
          inputPage.page,
          inputPage.width,
          inputPage.height,
          transcript.lines,
        );
        pages.push(pageText);
      }
    }

    result.push({
      docId,
      kind: inputDoc.kind,
      pages,
    });
  }

  return result;
}
