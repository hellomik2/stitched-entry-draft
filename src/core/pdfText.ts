export type DocKind = "invoice" | "packingList" | "billOfLading";
export type Box = { x: number; y: number; w: number; h: number }; // PDF points at scale 1, origin TOP-LEFT of the page
export type TextItem = { id: string; str: string; box: Box; noBox?: true; cell?: string };
export type Span = { itemId: string; start: number; end: number }; // where the item sits inside PageText.text
export type PageText = {
  page: number;
  width: number;
  height: number;
  items: TextItem[];
  text: string;
  spans: Span[];
  origin?: "textLayer" | "imageTranscript" | "sheet";
  grid?: { cols: { label: string; x: number; w: number }[]; rows: { label: string; y: number; h: number }[] };
};
export type DocumentText = { docId: string; kind: DocKind; pages: PageText[] };

export interface PdfPageLike {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
}

export interface PdfLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
}

export const normalizeSpace = (s: string) => s.replace(/\s+/g, " ").trim();

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

interface RawItem {
  str?: string;
  height?: number;
  width?: number;
  transform?: number[];
}

interface ProcessedItem {
  str: string;
  x: number;
  baseline: number;
  w: number;
  size: number;
}

interface LineItem extends ProcessedItem {
  itemIndex: number;
}

export function buildPageText(page: number, width: number, height: number, rawItems: unknown[], docId: string): PageText {
  // Step 1: Filter and normalize items
  const processed: ProcessedItem[] = [];
  for (const rawItem of rawItems) {
    const item = rawItem as RawItem;
    if (!item.str || !Array.isArray(item.transform)) continue;

    const normalized = normalizeSpace(item.str);
    if (!normalized) continue;

    const size = typeof item.height === "number" && item.height > 0 ? item.height : Math.abs(item.transform[3]);
    const x = item.transform[4];
    const baseline = item.transform[5];
    const w = typeof item.width === "number" ? item.width : 0;

    processed.push({ str: normalized, x, baseline, w, size });
  }

  // Step 2 & 3: Sort by baseline descending, then x ascending; group into lines
  processed.sort((a, b) => {
    const baselineDiff = b.baseline - a.baseline;
    if (Math.abs(baselineDiff) > 0.001) return baselineDiff; // baseline descending
    return a.x - b.x; // x ascending
  });

  const lines: LineItem[][] = [];
  let currentLine: LineItem[] = [];

  for (let i = 0; i < processed.length; i++) {
    const item = processed[i];

    if (currentLine.length === 0) {
      currentLine.push({ ...item, itemIndex: i });
    } else {
      const firstInLine = currentLine[0];
      if (Math.abs(firstInLine.baseline - item.baseline) <= 2) {
        currentLine.push({ ...item, itemIndex: i });
      } else {
        // Sort current line by x ascending and add to lines
        currentLine.sort((a, b) => a.x - b.x);
        lines.push(currentLine);
        currentLine = [{ ...item, itemIndex: i }];
      }
    }
  }
  if (currentLine.length > 0) {
    currentLine.sort((a, b) => a.x - b.x);
    lines.push(currentLine);
  }

  // Step 4 & 5: Number items in reading order and build TextItem array
  const items: TextItem[] = [];
  let itemNumber = 1;
  for (const line of lines) {
    for (const item of line) {
      const id = `${docId}:p${page}:i${itemNumber}`;
      const box: Box = {
        x: round2(item.x),
        y: round2(height - item.baseline - 0.8 * item.size),
        w: round2(item.w),
        h: round2(item.size),
      };
      items.push({ id, str: item.str, box });
      itemNumber++;
    }
  }

  // Step 6: Build text and spans
  const textParts: string[] = [];
  const spans: Span[] = [];

  for (const item of items) {
    const start = textParts.join(" ").length + (textParts.length > 0 ? 1 : 0); // account for space separator
    textParts.push(item.str);
    const end = start + item.str.length;
    spans.push({ itemId: item.id, start, end });
  }

  const text = textParts.join(" ");

  return {
    page,
    width: round2(width),
    height: round2(height),
    items,
    text,
    spans,
  };
}

export async function extractDocumentText(pdf: PdfLike, docId: string, kind: DocKind): Promise<DocumentText> {
  const pages: PageText[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const pdfPage = await pdf.getPage(pageNum);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const textContent = await pdfPage.getTextContent();

    const pageText = buildPageText(pageNum, viewport.width, viewport.height, textContent.items, docId);
    pages.push(pageText);
  }

  return { docId, kind, pages };
}
