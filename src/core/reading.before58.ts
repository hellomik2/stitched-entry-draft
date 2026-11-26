import { RuleResult } from "../rules/types";
import { normalizeSpace, DocKind, Box, DocumentText, PageText } from "./pdfText";
import { findPrintedDates } from "./parse";

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
  packingListLineCount?: number | null;
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

export const NOT_IN_TRANSCRIPT_MESSAGE =
  "The AI reader read this value from a line that is not in its transcript of the image, so there is no box on the page. A person finds it on the page and checks it.";

export type VerifiedReading = FieldReading &
  (
    | { status: "accepted"; box: Box | null; itemIds: string[]; origin?: "imageTranscript"; notInTranscript?: true; lineText?: string; cell?: string }
    | { status: "uncertain"; box: Box | null; itemIds: string[]; origin?: "imageTranscript"; notInTranscript?: true; message: string; lineText?: string; cell?: string }
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

  // Check packingListLineCount if present
  if (obj.packingListLineCount !== undefined) {
    if (obj.packingListLineCount !== null && (!Number.isInteger(obj.packingListLineCount) || (obj.packingListLineCount as number) < 0 || (obj.packingListLineCount as number) > 999)) {
      return { ok: false, reason: "packingListLineCount must be null or an integer from 0 to 999" };
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

// Helper: count whole-word occurrences of needle in haystack
function countWholeWordOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let searchIndex = 0;
  while ((searchIndex = haystack.indexOf(needle, searchIndex)) !== -1) {
    const charBefore = searchIndex === 0 ? " " : haystack[searchIndex - 1];
    const charAfter = searchIndex + needle.length >= haystack.length ? " " : haystack[searchIndex + needle.length];
    const isWholeWord = (charBefore === " " || searchIndex === 0) && (charAfter === " " || searchIndex + needle.length >= haystack.length);
    if (isWholeWord) {
      count++;
    }
    searchIndex++;
  }
  return count;
}

// Helper: find index of whole-word occurrence
function findWholeWordOccurrence(haystack: string, needle: string): number {
  let searchIndex = 0;
  while ((searchIndex = haystack.indexOf(needle, searchIndex)) !== -1) {
    const charBefore = searchIndex === 0 ? " " : haystack[searchIndex - 1];
    const charAfter = searchIndex + needle.length >= haystack.length ? " " : haystack[searchIndex + needle.length];
    const isWholeWord = (charBefore === " " || searchIndex === 0) && (charAfter === " " || searchIndex + needle.length >= haystack.length);
    if (isWholeWord) {
      return searchIndex;
    }
    searchIndex++;
  }
  return -1;
}

// Helper: check if a field is a line field (invoice.lines.<n>.* or packingList.lines.<n>.*)
function isLineField(fieldName: string): boolean {
  return /^(invoice|packingList)\.lines\.\d+\./.test(fieldName);
}

// Requirement 35.1: the value MM/DD/YYYY of a date field and exactly one printed date in the quote, the same day.
function dateValueMatchesQuote(fieldName: string, v: string, q: string): boolean {
  if ((fieldName === "invoice.date" || fieldName === "billOfLading.onBoardDate") && /^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
    // Parse the value as MM/DD/YYYY
    const valueParts = v.split("/");
    const valueMonth = parseInt(valueParts[0], 10);
    const valueDay = parseInt(valueParts[1], 10);
    const valueYear = parseInt(valueParts[2], 10);

    // Validate it's a real date
    const valueDate = new Date(valueYear, valueMonth - 1, valueDay);
    if (valueDate.getFullYear() === valueYear && valueDate.getMonth() === valueMonth - 1 && valueDate.getDate() === valueDay) {
      // Now check if quote contains exactly one printed date matching this day
      const printedDates = findPrintedDates(q);
      if (printedDates.length === 1) {
        const printedDate = printedDates[0];
        // For DD.MM.YYYY format in quote, validate that value's day matches first number and month matches second
        if (printedDate.month === valueMonth && printedDate.day === valueDay && printedDate.year === valueYear) {
          return true;
        }
      }
    }
  }
  return false;
}

// Helper: extract line number from field name
function getLineNumber(fieldName: string): number | null {
  const match = /^(invoice|packingList)\.lines\.(\d+)\./.exec(fieldName);
  return match ? parseInt(match[2], 10) : null;
}

// Helper: get field type from field name
function getFieldType(fieldName: string): string | null {
  const match = /^(invoice|packingList)\.lines\.\d+\.(.+)$/.exec(fieldName);
  return match ? match[2] : null;
}

// Helper: union of boxes
function unionBoxes(boxes: Box[]): Box {
  let unionBox: Box | null = null;
  for (const box of boxes) {
    if (!unionBox) {
      unionBox = { ...box };
    } else {
      const minX = Math.min(unionBox.x, box.x);
      const minY = Math.min(unionBox.y, box.y);
      const maxX = Math.max(unionBox.x + unionBox.w, box.x + box.w);
      const maxY = Math.max(unionBox.y + unionBox.h, box.y + box.h);
      unionBox = {
        x: Math.round(minX * 100) / 100,
        y: Math.round(minY * 100) / 100,
        w: Math.round((maxX - minX) * 100) / 100,
        h: Math.round((maxY - minY) * 100) / 100,
      };
    }
  }
  return unionBox || { x: 0, y: 0, w: 0, h: 0 };
}

// Helper: get items in row on text page (overlaps vertically by at least half item height)
function getRowItems(page: PageText, anchorItems: string[]): string[] {
  const anchorItemSet = new Set(anchorItems);
  const anchorBoxes = page.items.filter(i => anchorItemSet.has(i.id)).map(i => i.box);
  
  if (anchorBoxes.length === 0) return [];
  
  // Get vertical extent of anchor items
  const minY = Math.min(...anchorBoxes.map(b => b.y));
  const maxY = Math.max(...anchorBoxes.map(b => b.y + b.h));
  
  const result: string[] = [];
  for (const item of page.items) {
    // Check if item overlaps vertically by at least half its height
    const itemMinY = item.box.y;
    const itemMaxY = item.box.y + item.box.h;
    const overlapStart = Math.max(itemMinY, minY);
    const overlapEnd = Math.min(itemMaxY, maxY);
    const overlapHeight = Math.max(0, overlapEnd - overlapStart);
    const halfItemHeight = item.box.h / 2;
    
    if (overlapHeight >= halfItemHeight) {
      result.push(item.id);
    }
  }
  
  return result;
}

export function verifyReadings(answer: ReadingAnswer, documents: DocumentText[]): VerifiedReading[] {
  const docMap = new Map<string, DocumentText>();
  for (const doc of documents) {
    docMap.set(doc.docId, doc);
  }

  const verified: VerifiedReading[] = answer.fields.map((field, fieldIdx, allFields) => {
    const isLowConfidence = field.confidence === "low";

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

    const v = normalizeSpace(field.value);

    // 5. Find quote on page (Requirement 34 & 35 logic)
    // Order: a) plain occurrences, b) stacked runs (text page), c) whole-word + anchor
    let quoteOccurrenceIndex = -1;

    // a) Count plain occurrences
    let occurrenceCount = 0;
    let firstOccurrence = -1;
    let searchIndex = 0;
    while ((searchIndex = page.text.indexOf(q, searchIndex)) !== -1) {
      if (occurrenceCount === 0) {
        firstOccurrence = searchIndex;
      }
      occurrenceCount++;
      searchIndex++;
    }

    // Store matched run items (used in stacked runs and in value checking below)
    let runItems: typeof page.items | null = null;

    if (occurrenceCount === 1) {
      // Exactly one plain occurrence: use it (like old code)
      quoteOccurrenceIndex = firstOccurrence;
    } else if (occurrenceCount === 0) {
      // b) Try stacked runs on text page (Requirement 35.3)
      if (page.origin !== "imageTranscript") {
        // Try runs of 2-4 items stacked vertically in the same column
        // For each potential start item, find nearest items below in same column
        let foundRun = false;
        for (let startIdx = 0; startIdx < page.items.length && !foundRun; startIdx++) {
          const startItem = page.items[startIdx];
          
          // Try building runs of different lengths from this start
          for (let runLength = 2; runLength <= 4 && !foundRun; runLength++) {
            const candidateRunItems: typeof page.items = [startItem];
            let currentItem = startItem;
            let isValidRun = true;
            
            // Build the run by finding nearest items below in same column
            for (let i = 1; i < runLength && isValidRun; i++) {
              // Find nearest item below currentItem in same column
              let nearestItem: typeof page.items[0] | null = null;
              let minDistance = Infinity;
              
              for (const item of page.items) {
                // Must be below current item (top of item > bottom of current item)
                if (item.box.y <= currentItem.box.y + currentItem.box.h) continue;
                // Must be in same column (left edge within 2 points of start item)
                if (Math.abs(item.box.x - startItem.box.x) > 2) continue;
                // Must not already be in run
                if (candidateRunItems.includes(item)) continue;
                
                // Distance from bottom of current item to top of this item
                const distance = item.box.y - (currentItem.box.y + currentItem.box.h);
                
                // Must be at most 2x current item height below and positive distance
                if (distance > 0 && distance <= 2 * currentItem.box.h && distance < minDistance) {
                  minDistance = distance;
                  nearestItem = item;
                }
              }
              
              if (nearestItem) {
                candidateRunItems.push(nearestItem);
                currentItem = nearestItem;
              } else {
                isValidRun = false;
              }
            }
            
            if (isValidRun && candidateRunItems.length === runLength) {
              // Check if texts match
              const runText = candidateRunItems.map(item => item.str).join(" ");
              if (runText === q) {
                // Found matching run: use it
                runItems = candidateRunItems;
                quoteOccurrenceIndex = 0;  // Placeholder; will use runItems directly
                foundRun = true;
              }
            }
          }
        }
      }

      if (quoteOccurrenceIndex === -1 && runItems === null) {
        // Requirement 50.1: on an image page the page text is the reader's own transcript. A quote missing from it
        // keeps the value for a person, with no box, when the value is inside its own quote.
        if (page.origin === "imageTranscript") {
          // Requirement 50.8: the transcript has this line without the value, so the value was put into it.
          let searchStart = 0;
          while ((searchStart = q.indexOf(v, searchStart)) !== -1) {
            const left = q.slice(0, searchStart).trim();
            const right = q.slice(searchStart + v.length).trim();
            if (left !== "" && right !== "") {
              if (page.text.indexOf(normalizeSpace(left + " " + right)) !== -1) {
                return {
                  ...field,
                  status: "rejected" as const,
                  reason: "quote_not_found" as const,
                  message: `The quote "${q}" is not on ${doc.kind} page ${field.page}.`,
                };
              }
            }
            searchStart++;
          }

          if (q.indexOf(v) !== -1 || dateValueMatchesQuote(field.field, v, q)) {
            return {
              ...field,
              status: "uncertain" as const,
              box: null,
              itemIds: [],
              origin: "imageTranscript" as const,
              notInTranscript: true as const,
              message: NOT_IN_TRANSCRIPT_MESSAGE,
            };
          }
          return {
            ...field,
            status: "rejected" as const,
            reason: "value_not_in_quote" as const,
            message: `The value "${v}" is not found within the quote "${q}" on ${doc.kind} page ${field.page}.`,
          };
        }
        return {
          ...field,
          status: "rejected" as const,
          reason: "quote_not_found" as const,
          message: `The quote "${q}" is not on ${doc.kind} page ${field.page}.`,
        };
      }
    } else {
      // c) Multiple plain occurrences: try whole-word or anchor logic
      const wholeWordCount = countWholeWordOccurrences(page.text, q);
      
      if (wholeWordCount === 1) {
        // Exactly one whole-word occurrence: use it
        quoteOccurrenceIndex = findWholeWordOccurrence(page.text, q);
      } else {
        // Try anchor logic for line fields
        if (isLineField(field.field)) {
          const lineNum = getLineNumber(field.field);
          const fieldType = getFieldType(field.field);
          
          if (lineNum !== null && fieldType !== null) {
            // Find anchor among itemNo, description, amount
            const lineDependentFields = ["itemNo", "description", "amount"];
            let anchorItems: string[] = [];

            for (const dependentFieldType of lineDependentFields) {
              const anchorFieldName = field.field.replace(fieldType, dependentFieldType);
              const anchorField = allFields.find(f => f.field === anchorFieldName && f.doc === field.doc && f.page === field.page);
              
              if (anchorField && anchorField.value !== null) {
                const anchorQ = normalizeSpace(anchorField.quote);
                const anchorV = normalizeSpace(anchorField.value);
                
                // Find if anchor quote has exactly one plain or whole-word occurrence
                let hasUniqueAnchor = false;
                let anchorIdx = -1;
                
                // Count plain occurrences first
                let anchorPlainCount = 0;
                let anchorPlainIdx = -1;
                let searchIdx = 0;
                while ((searchIdx = page.text.indexOf(anchorQ, searchIdx)) !== -1) {
                  if (anchorPlainCount === 0) {
                    anchorPlainIdx = searchIdx;
                  }
                  anchorPlainCount++;
                  searchIdx++;
                }
                
                if (anchorPlainCount === 1) {
                  anchorIdx = anchorPlainIdx;
                  hasUniqueAnchor = true;
                } else {
                  // Try whole-word
                  const anchorWholeWordCount = countWholeWordOccurrences(page.text, anchorQ);
                  if (anchorWholeWordCount === 1) {
                    anchorIdx = findWholeWordOccurrence(page.text, anchorQ);
                    hasUniqueAnchor = true;
                  }
                }
                
                // Check if anchor value is inside anchor quote
                if (hasUniqueAnchor && anchorIdx !== -1 && anchorQ.indexOf(anchorV) !== -1) {
                  // Found valid anchor
                  anchorItems = page.items
                    .filter(item => {
                      const span = page.spans.find(s => s.itemId === item.id);
                      return span && span.start < anchorIdx + anchorQ.length && span.end > anchorIdx;
                    })
                    .map(item => item.id);
                  break;
                }
              }
            }

            if (anchorItems.length > 0) {
              // Get row items
              let rowItems: string[];
              if (page.origin === "imageTranscript") {
                rowItems = anchorItems;
              } else {
                rowItems = getRowItems(page, anchorItems);
              }

              // Find whole-word occurrences that start inside row items
              const rowSpans = page.items
                .filter(item => rowItems.includes(item.id))
                .map(item => page.spans.find(s => s.itemId === item.id))
                .filter((s): s is typeof page.spans[0] => s !== undefined);
              
              if (rowSpans.length > 0) {
                const rowStart = Math.min(...rowSpans.map(s => s.start));
                const rowEnd = Math.max(...rowSpans.map(s => s.end));
                
                // Count whole-word occurrences starting inside row items
                let rowWholeWordCount = 0;
                let rowWholeWordIdx = -1;
                let searchIdx = 0;
                while ((searchIdx = page.text.indexOf(q, searchIdx)) !== -1) {
                  // Check if this is a whole-word occurrence
                  const charBefore = searchIdx === 0 ? " " : page.text[searchIdx - 1];
                  const charAfter = searchIdx + q.length >= page.text.length ? " " : page.text[searchIdx + q.length];
                  const isWholeWord = (charBefore === " " || searchIdx === 0) && (charAfter === " " || searchIdx + q.length >= page.text.length);
                  
                  if (isWholeWord) {
                    // Check if it starts inside a row item's span
                    const startsInRow = rowSpans.some(span => searchIdx >= span.start && searchIdx < span.end);
                    if (startsInRow) {
                      if (rowWholeWordCount === 0) {
                        rowWholeWordIdx = searchIdx;
                      }
                      rowWholeWordCount++;
                    }
                  }
                  searchIdx++;
                }
                
                if (rowWholeWordCount === 1) {
                  quoteOccurrenceIndex = rowWholeWordIdx;
                }
              }
            }
          }
        }

        if (quoteOccurrenceIndex === -1) {
          return {
            ...field,
            status: "rejected" as const,
            reason: "quote_not_unique" as const,
            message: `The quote "${q}" appears more than once on ${doc.kind} page ${field.page}.`,
          };
        }
      }
    }

    if (quoteOccurrenceIndex === -1) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "quote_not_found" as const,
        message: `The quote "${q}" is not on ${doc.kind} page ${field.page}.`,
      };
    }

    // 6. Check value is inside quote
    let valueIndexInQuote = -1;
    let valueFoundInQuote = false;

    // If runItems is set (from stacked runs), check value inside runItems
    if (runItems !== null) {
      const runTextSingleSpace = runItems.map(i => i.str).join(" ");
      valueIndexInQuote = runTextSingleSpace.indexOf(v);
      if (valueIndexInQuote !== -1) {
        valueFoundInQuote = true;
      } else {
        // Try with comma-space at row changes (Requirement 35.4)
        const runTextCommaSpace = runItems
          .map((item, idx) => {
            if (idx === 0) return item.str;
            const prevItem = runItems[idx - 1];
            const prevMaxY = prevItem.box.y + prevItem.box.h;
            if (item.box.y >= prevMaxY) {
              return ", " + item.str;
            }
            return " " + item.str;
          })
          .join("");
        valueIndexInQuote = runTextCommaSpace.indexOf(v);
        if (valueIndexInQuote !== -1) {
          valueFoundInQuote = true;
        }
      }
    } else {
      // Normal path: check value in the quote string
      valueIndexInQuote = q.indexOf(v);
      valueFoundInQuote = valueIndexInQuote !== -1;

      // If value not found directly, check multi-row case (Requirement 35.4)
      if (!valueFoundInQuote) {
        const quoteStart = quoteOccurrenceIndex;
        const quoteEnd = quoteOccurrenceIndex + q.length;
        const quoteItems = page.items.filter(item => {
          const span = page.spans.find(s => s.itemId === item.id);
          return span && span.start < quoteEnd && span.end > quoteStart;
        });

        if (quoteItems.length > 1) {
          // Check if items span multiple rows (boxes don't overlap vertically between adjacent items)
          let isMultiRow = false;
          for (let i = 1; i < quoteItems.length; i++) {
            const prevItem = quoteItems[i - 1];
            const currItem = quoteItems[i];
            const prevMaxY = prevItem.box.y + prevItem.box.h;
            const currY = currItem.box.y;
            if (currY >= prevMaxY) {
              // Different row detected
              isMultiRow = true;
              break;
            }
          }

          if (isMultiRow) {
            // Build quote with ", " at row changes
            const quoteWithCommas = quoteItems
              .map((item, idx) => {
                if (idx === 0) return item.str;
                const prevItem = quoteItems[idx - 1];
                const prevMaxY = prevItem.box.y + prevItem.box.h;
                if (item.box.y >= prevMaxY) {
                  return ", " + item.str;
                }
                return " " + item.str;
              })
              .join("");
            if (quoteWithCommas.indexOf(v) !== -1) {
              valueFoundInQuote = true;
            }
          }
        }
      }
    }

    // If still not found, try date parsing (Requirement 35.1) for specific fields
    if (!valueFoundInQuote) {
      if (dateValueMatchesQuote(field.field, v, q)) {
        valueFoundInQuote = true;
      }
    }

    if (!valueFoundInQuote) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "value_not_in_quote" as const,
        message: `The value "${v}" is not found within the quote "${q}" on ${doc.kind} page ${field.page}.`,
      };
    }

    // 7. Find box and itemIds
    let selectedItems: typeof page.items;
    
    if (runItems !== null) {
      // Use the run items directly
      selectedItems = runItems;
    } else {
      const quoteStart = quoteOccurrenceIndex;
      const quoteEnd = quoteOccurrenceIndex + q.length;
      const valueStart = quoteStart + valueIndexInQuote;
      const valueEnd = valueStart + v.length;

      const relevantItems = page.items.filter((item) => {
        const span = page.spans.find((s) => s.itemId === item.id);
        if (!span) return false;
        return span.start < quoteEnd && span.end > quoteStart;
      });

      // Try to find exact match first
      let exactMatch: typeof page.items[0] | null = null;
      for (const item of relevantItems) {
        const span = page.spans.find((s) => s.itemId === item.id);
        if (span && normalizeSpace(item.str) === v) {
          exactMatch = item;
          break;
        }
      }

      if (exactMatch) {
        selectedItems = [exactMatch];
      } else {
        selectedItems = relevantItems.filter((item) => {
          const span = page.spans.find((s) => s.itemId === item.id);
          if (!span) return false;
          return span.start < valueEnd && span.end > valueStart;
        });
      }

      if (selectedItems.length === 0) {
        selectedItems = page.items.filter((item) => {
          const span = page.spans.find((s) => s.itemId === item.id);
          return span !== undefined && span.start < valueEnd && span.end > valueStart;
        });
      }
    }

    // Check for noBox items
    if (selectedItems.some(item => item.noBox)) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "no_source_box" as const,
        message: "The value was found on a line of the image that the AI reader gave no usable place for, so there is nothing to point to.",
      };
    }

    if (selectedItems.length === 0) {
      return {
        ...field,
        status: "rejected" as const,
        reason: "no_source_box" as const,
        message: "The value was found, but no line on the page lines up with it, so there is nothing to point to.",
      };
    }

    const box = unionBoxes(selectedItems.map(item => item.box));
    const itemIds = selectedItems.map((item) => item.id);

    // Build result with appropriate status
    let result: VerifiedReading;
    
    if (isLowConfidence) {
      result = {
        ...field,
        status: "uncertain" as const,
        box,
        itemIds,
        message: "The AI reader was not sure of this value, so the draft does not use it. A person checks it on the page.",
      };
    } else {
      result = {
        ...field,
        status: "accepted" as const,
        box,
        itemIds,
      };
    }

    if (page.origin === "imageTranscript") {
      (result as any).origin = "imageTranscript" as const;
      (result as any).lineText = selectedItems.map((item) => item.str).join(" ");
    }

    return result;
  });

  // After all readings are verified, populate cell field for sheet pages
  for (const reading of verified) {
    if (reading.status !== "accepted" && reading.status !== "uncertain") continue;
    
    const doc = docMap.get(reading.doc);
    const page = doc?.pages.find((p) => p.page === reading.page);
    
    if (page && reading.itemIds.length > 0) {
      // Collect cell values from items
      const cellValues: string[] = [];
      for (const itemId of reading.itemIds) {
        const item = page.items.find((i) => i.id === itemId);
        if (item && item.cell) {
          cellValues.push(item.cell);
        }
      }
      
      if (cellValues.length > 0) {
        // If multiple cells, use first and last
        if (cellValues.length === 1) {
          reading.cell = cellValues[0];
        } else {
          const first = cellValues[0];
          const last = cellValues[cellValues.length - 1];
          if (first === last) {
            reading.cell = first;
          } else {
            // Extract the ref part (after !) from both first and last
            const firstParts = first.split("!");
            const lastParts = last.split("!");
            if (firstParts.length === 2 && lastParts.length === 2) {
              const sheetName = firstParts[0];
              const firstRef = firstParts[1];
              const lastRef = lastParts[1];
              reading.cell = `${sheetName}!${firstRef}:${lastRef}`;
            }
          }
        }
      }
    }
  }

  return verified;
}
