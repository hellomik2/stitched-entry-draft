import { RuleResult } from "../rules/types";
import { normalizeSpace, DocKind, Box, DocumentText, PageText } from "./pdfText";

export type FieldReading = {
  field: string;
  value: string | null;
  quote: string;
  doc: string;
  page: number;
  confidence?: "high" | "low";
};

export type ReadingAnswer = {
  schemaVersion: 1;
  bundle: string;
  reader: string;
  documents: { docId: string; kind: DocKind }[];
  fields: FieldReading[];
  invoiceLineCount?: number | null;
};

export interface DocumentReader {
  readonly name: string;
  read(input: { bundle: string; documents: DocumentText[] }): Promise<ReadingAnswer>;
}

export function frozenReader(answer: ReadingAnswer): DocumentReader {
  return {
    name: `frozen:${answer.reader}`,
    read: async () => answer,
  };
}

export type RejectReason =
  | "unknown_document"
  | "page_out_of_range"
  | "value_missing"
  | "empty_quote"
  | "quote_not_found"
  | "quote_not_unique"
  | "value_not_in_quote"
  | "low_confidence"
  | "no_source_box";

export type VerifiedReading = FieldReading &
  (
    | { status: "accepted"; box: Box; itemIds: string[]; origin?: "imageTranscript" }
    | { status: "rejected"; reason: RejectReason; message: string }
  );

export function validateReadingAnswer(json: unknown): RuleResult<ReadingAnswer> {
  if (!json || typeof json !== "object") {
    return { ok: false, reason: "Reading answer must be an object" };
  }

  const obj = json as Record<string, unknown>;

  // Check schemaVersion
  if (obj.schemaVersion !== 1) {
    return { ok: false, reason: "schemaVersion must be 1" };
  }

  // Check bundle is a string
  if (typeof obj.bundle !== "string") {
    return { ok: false, reason: "bundle must be a string" };
  }

  // Check reader is a string
  if (typeof obj.reader !== "string") {
    return { ok: false, reason: "reader must be a string" };
  }

  // Check documents is an array
  if (!Array.isArray(obj.documents)) {
    return { ok: false, reason: "documents must be an array" };
  }

  for (let i = 0; i < obj.documents.length; i++) {
    const doc = obj.documents[i];
    if (!doc || typeof doc !== "object") {
      return { ok: false, reason: `documents[${i}] must be an object` };
    }

    const docObj = doc as Record<string, unknown>;
    if (typeof docObj.docId !== "string") {
      return { ok: false, reason: `documents[${i}].docId must be a string` };
    }

    if (!["invoice", "packingList", "billOfLading"].includes(docObj.kind as string)) {
      return { ok: false, reason: `documents[${i}].kind must be "invoice", "packingList", or "billOfLading"` };
    }
  }

  // Check fields is an array
  if (!Array.isArray(obj.fields)) {
    return { ok: false, reason: "fields must be an array" };
  }

  // Check invoiceLineCount if present
  if (obj.invoiceLineCount !== undefined) {
    if (obj.invoiceLineCount !== null && (!Number.isInteger(obj.invoiceLineCount) || (obj.invoiceLineCount as number) < 0 || (obj.invoiceLineCount as number) > 999)) {
      return { ok: false, reason: "invoiceLineCount must be null or an integer from 0 to 999" };
    }
  }

  for (let i = 0; i < obj.fields.length; i++) {
    const field = obj.fields[i];
    if (!field || typeof field !== "object") {
      return { ok: false, reason: `fields[${i}] must be an object` };
    }

    const fieldObj = field as Record<string, unknown>;
    if (typeof fieldObj.field !== "string") {
      return { ok: false, reason: `fields[${i}].field must be a string` };
    }

    if (fieldObj.value !== null && typeof fieldObj.value !== "string") {
      return { ok: false, reason: `fields[${i}].value must be a string or null` };
    }

    if (typeof fieldObj.quote !== "string") {
      return { ok: false, reason: `fields[${i}].quote must be a string` };
    }

    if (typeof fieldObj.doc !== "string") {
      return { ok: false, reason: `fields[${i}].doc must be a string` };
    }

    if (!Number.isInteger(fieldObj.page) || (fieldObj.page as number) < 1) {
      return { ok: false, reason: `fields[${i}].page must be a positive integer` };
    }

    if (fieldObj.confidence !== undefined && !["high", "low"].includes(fieldObj.confidence as string)) {
      return { ok: false, reason: `fields[${i}].confidence must be "high" or "low"` };
    }
  }

  return { ok: true, value: obj as ReadingAnswer };
}

export function verifyReadings(answer: ReadingAnswer, documents: DocumentText[]): VerifiedReading[] {
  const docMap = new Map<string, DocumentText>();
  for (const doc of documents) {
    docMap.set(doc.docId, doc);
  }

  return answer.fields.map((field) => {
    // 0. Check low confidence (first check before document check)
    if (field.confidence === "low") {
      return {
        ...field,
        status: "rejected" as const,
        reason: "low_confidence" as const,
        message: "The reader marked this value as uncertain.",
      };
    }

    // 1. Check document exists
    if (!docMap.has(field.doc)) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "unknown_document" as const,
        message: `Document "${field.doc}" not found in provided documents.`,
      };
    }

    const doc = docMap.get(field.doc)!;
    const pageList = doc.pages;

    // 2. Check page exists
    const page = pageList.find((p) => p.page === field.page);
    if (!page) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "page_out_of_range" as const,
        message: `Page ${field.page} not found in document "${field.doc}".`,
      };
    }

    // 3. Check value is not null or empty
    if (field.value === null || normalizeSpace(field.value) === "") {
      return {
        ...field,
        status: "rejected" as const,
        reason: "value_missing" as const,
        message: `Value is missing or empty on ${doc.kind} page ${field.page}.`,
      };
    }

    // 4. Check quote is not empty
    const q = normalizeSpace(field.quote);
    if (q === "") {
      return {
        ...field,
        status: "rejected" as const,
        reason: "empty_quote" as const,
        message: `The quote is empty.`,
      };
    }

    // 5. Count occurrences of quote in page text
    let quoteCount = 0;
    let quoteStartIndex = -1;
    let searchIndex = 0;

    while ((searchIndex = page.text.indexOf(q, searchIndex)) !== -1) {
      if (quoteCount === 0) {
        quoteStartIndex = searchIndex;
      }
      quoteCount++;
      searchIndex++;
    }

    if (quoteCount === 0) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "quote_not_found" as const,
        message: `The quote "${q}" is not on ${doc.kind} page ${field.page}.`,
      };
    }

    if (quoteCount > 1) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "quote_not_unique" as const,
        message: `The quote "${q}" appears more than once on ${doc.kind} page ${field.page}.`,
      };
    }

    // 6. Check value is inside quote
    const v = normalizeSpace(field.value);
    const valueIndexInQuote = q.indexOf(v);
    if (valueIndexInQuote === -1) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "value_not_in_quote" as const,
        message: `The value "${v}" is not found within the quote "${q}" on ${doc.kind} page ${field.page}.`,
      };
    }

    // 7. Accepted: find the box and itemIds
    const quoteStart = quoteStartIndex;
    const quoteEnd = quoteStartIndex + q.length;
    const valueStart = quoteStart + valueIndexInQuote;
    const valueEnd = valueStart + v.length;

    // Find items that match or overlap with the value span
    const relevantItems = page.items.filter((item) => {
      const span = page.spans.find((s) => s.itemId === item.id);
      if (!span) return false;

      // Check if this span overlaps or is contained in the quote
      if (span.start < quoteStart || span.end > quoteEnd) return false;

      return true;
    });

    // Try to find exact match first
    let exactMatch = null;
    for (const item of relevantItems) {
      const span = page.spans.find((s) => s.itemId === item.id);
      if (span && normalizeSpace(item.str) === v) {
        exactMatch = item;
        break;
      }
    }

    let selectedItems: typeof relevantItems;
    if (exactMatch) {
      selectedItems = [exactMatch];
    } else {
      // Find all items that overlap with the value span
      selectedItems = relevantItems.filter((item) => {
        const span = page.spans.find((s) => s.itemId === item.id);
        if (!span) return false;
        // Overlaps with [valueStart, valueEnd]
        return span.start < valueEnd && span.end > valueStart;
      });
    }

    // Requirement 20.1: the quote is part of one text item, so no item lies fully inside it.
    // Use the items that overlap the value inside the quote.
    if (selectedItems.length === 0) {
      selectedItems = page.items.filter((item) => {
        const span = page.spans.find((s) => s.itemId === item.id);
        return span !== undefined && span.start < valueEnd && span.end > valueStart;
      });
    }

    // Requirement 20.2: nothing on the page lines up with the value.
    if (selectedItems.length === 0) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "no_source_box" as const,
        message: "The value was found, but no line on the page lines up with it, so there is nothing to point to.",
      };
    }

    // Calculate union box
    let unionBox: Box | null = null;
    for (const item of selectedItems) {
      if (!unionBox) {
        unionBox = { ...item.box };
      } else {
        const minX = Math.min(unionBox.x, item.box.x);
        const minY = Math.min(unionBox.y, item.box.y);
        const maxX = Math.max(unionBox.x + unionBox.w, item.box.x + item.box.w);
        const maxY = Math.max(unionBox.y + unionBox.h, item.box.y + item.box.h);
        unionBox = {
          x: Math.round(minX * 100) / 100,
          y: Math.round(minY * 100) / 100,
          w: Math.round((maxX - minX) * 100) / 100,
          h: Math.round((maxY - minY) * 100) / 100,
        };
      }
    }

    const accepted: VerifiedReading = {
      ...field,
      status: "accepted" as const,
      box: unionBox || { x: 0, y: 0, w: 0, h: 0 },
      itemIds: selectedItems.map((item) => item.id),
    };

    // Add origin if page has imageTranscript origin
    if (page.origin === "imageTranscript") {
      (accepted as any).origin = "imageTranscript" as const;
    }

    return accepted;
  });
}
