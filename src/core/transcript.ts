import { normalizeSpace, PageText, TextItem, Span, Box } from "./pdfText";

export type TranscriptLine = {
  text: string;
  box: { x: number; y: number; w: number; h: number };
};

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function clampBox(box: { x: number; y: number; w: number; h: number }, width: number, height: number): Box {
  // Clamp each edge to the page boundaries
  const x = Math.max(0, Math.min(box.x, 1));
  const y = Math.max(0, Math.min(box.y, 1));
  const maxW = Math.max(0, 1 - x);
  const maxH = Math.max(0, 1 - y);
  const w = Math.max(0, Math.min(box.w, maxW));
  const h = Math.max(0, Math.min(box.h, maxH));

  // Convert to page units and round to 2 decimals
  return {
    x: round2(x * width),
    y: round2(y * height),
    w: round2(w * width),
    h: round2(h * height),
  };
}

export function transcriptToPageText(
  docId: string,
  page: number,
  width: number,
  height: number,
  lines: TranscriptLine[],
): PageText {
  // Normalize lines and drop empty ones
  const normalizedLines: TranscriptLine[] = [];
  for (const line of lines) {
    const normalized = normalizeSpace(line.text);
    if (normalized) {
      normalizedLines.push({ text: normalized, box: line.box });
    }
  }

  // Build items with IDs
  const items: TextItem[] = [];
  for (let i = 0; i < normalizedLines.length; i++) {
    const line = normalizedLines[i];
    const id = `${docId}:p${page}:i${i + 1}`;
    const clampedBox = clampBox(line.box, width, height);
    items.push({ id, str: line.text, box: clampedBox });
  }

  // Build text and spans
  const textParts: string[] = [];
  const spans: Span[] = [];

  for (const item of items) {
    const start = textParts.join(" ").length + (textParts.length > 0 ? 1 : 0);
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
    origin: "imageTranscript",
  };
}
