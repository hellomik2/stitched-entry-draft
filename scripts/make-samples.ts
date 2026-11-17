import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

type TextRun = {
  t: 'text';
  x: number;
  y: number;
  size: number;
  font: 'Helvetica' | 'Helvetica-Bold';
  text: string;
  color?: [number, number, number];
};

type LineRun = {
  t: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
};

type Run = TextRun | LineRun;

type Page = {
  runs: Run[];
};

type Document = {
  docId: string;
  file: string;
  pages: Page[];
};

type Layout = {
  bundle: string;
  pageSize: [number, number];
  documents: Document[];
};

async function makeDocument(
  layout: Layout,
  document: Document
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const [pageWidth, pageHeight] = layout.pageSize;

  // Embed fonts
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Draw pages
  for (const page of document.pages) {
    const pdfPage = pdfDoc.addPage([pageWidth, pageHeight]);
    const { width, height } = pdfPage.getSize();

    for (const run of page.runs) {
      if (run.t === 'text') {
        const font = run.font === 'Helvetica-Bold' ? helveticaBold : helvetica;
        const color = run.color ? rgb(run.color[0], run.color[1], run.color[2]) : rgb(0, 0, 0);
        pdfPage.drawText(run.text, {
          x: run.x,
          y: run.y,
          size: run.size,
          font,
          color,
        });
      } else if (run.t === 'line') {
        pdfPage.drawLine({
          start: { x: run.x1, y: run.y1 },
          end: { x: run.x2, y: run.y2 },
          thickness: run.width,
          color: rgb(0.3, 0.3, 0.3),
        });
      }
    }
  }

  // Set metadata
  const creationDate = new Date('2026-11-17T00:00:00Z');
  pdfDoc.setTitle(`${document.docId} (DEMO / FICTITIOUS)`);
  pdfDoc.setCreationDate(creationDate);
  pdfDoc.setModificationDate(creationDate);

  // Save to buffer
  const bytes = await pdfDoc.save({ useObjectStreams: false });
  return bytes;
}

async function main() {
  const bundle = process.argv[2] ?? 'lantern-hollow';
  const layoutPath = resolve(process.cwd(), `samples/${bundle}/layout.json`);

  let layout: Layout;
  try {
    const content = readFileSync(layoutPath, 'utf8');
    layout = JSON.parse(content);
  } catch (err) {
    console.error(`Error reading layout.json: ${err}`);
    process.exit(1);
  }

  for (const document of layout.documents) {
    try {
      const pdfBytes = await makeDocument(layout, document);
      const outputDir = resolve(process.cwd(), `public/samples/${bundle}`);
      mkdirSync(outputDir, { recursive: true });

      const outputPath = resolve(outputDir, document.file);
      writeFileSync(outputPath, pdfBytes);

      console.log(`${outputPath} (${pdfBytes.length} bytes)`);
    } catch (err) {
      console.error(`Error creating ${document.docId}: ${err}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
