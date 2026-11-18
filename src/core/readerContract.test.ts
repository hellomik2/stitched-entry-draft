import { describe, it, expect } from "vitest";
import {
  validateReaderOutput,
  composeDocumentTexts,
  ReaderInput,
  ReaderOutput,
} from "./readerContract";
import { DocumentText, PageText } from "./pdfText";

describe("readerContract: validateReaderOutput", () => {
  const mockInput: ReaderInput = {
    bundle: "test-bundle",
    documents: [
      {
        docId: "doc1",
        kind: "invoice",
        fileName: "invoice.pdf",
        fileSha256: "0".repeat(64),
        pages: [
          { page: 1, width: 100, height: 100, text: "Invoice text", image: null },
          { page: 2, width: 100, height: 100, text: null, image: { mediaType: "image/jpeg", base64: "QUJD" } },
        ],
      },
    ],
  };

  it("accepts a valid output", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "invoice.number",
          value: "12345",
          quote: "Invoice No. 12345",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(true);
  });

  it("rejects a field name outside the catalog", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "unknown.field",
          value: "12345",
          quote: "Invoice No. 12345",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not in the catalog");
    }
  });

  it("rejects an unknown document", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "invoice.number",
          value: "12345",
          quote: "Invoice No. 12345",
          doc: "unknown-doc",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unknown document");
    }
  });

  it("rejects a page that does not exist", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "invoice.number",
          value: "12345",
          quote: "Invoice No. 12345",
          doc: "doc1",
          page: 99,
          confidence: "high",
        },
      ],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("does not exist");
    }
  });

  it("rejects missing confidence", () => {
    const output = {
      reader: "test-reader",
      fields: [
        {
          field: "invoice.number",
          value: "12345",
          quote: "Invoice No. 12345",
          doc: "doc1",
          page: 1,
          // confidence is missing
        },
      ],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
    } as unknown as ReaderOutput;

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("confidence");
    }
  });

  it("rejects a box with x + w > 1.001", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "invoice.number",
          value: "12345",
          quote: "Invoice No. 12345",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.7, y: 0.2, w: 0.4, h: 0.4 } }, // x + w = 1.1 > 1.001
          ],
        },
      ],
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("x + w");
    }
  });

  it("rejects missing transcript for an image page", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "invoice.number",
          value: "12345",
          quote: "Invoice No. 12345",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [], // missing transcript for page 2
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("missing transcript");
    }
  });

  it("rejects a transcript for a text page", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "invoice.number",
          value: "12345",
          quote: "Invoice No. 12345",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [
        {
          doc: "doc1",
          page: 1, // This page has text, not an image
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not an image page");
    }
  });

  it("rejects duplicated field names", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [
        {
          field: "invoice.number",
          value: "12345",
          quote: "Invoice No. 12345",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
        {
          field: "invoice.number", // Duplicate
          value: "67890",
          quote: "Invoice No. 67890",
          doc: "doc1",
          page: 1,
          confidence: "high",
        },
      ],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("appears more than once");
    }
  });

  it("accepts invoiceLineCount: null", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
      invoiceLineCount: null,
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(true);
  });

  it("accepts invoiceLineCount: 3", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
      invoiceLineCount: 3,
    };

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(true);
  });

  it("rejects invoiceLineCount: -1", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
      invoiceLineCount: -1,
    } as any;

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invoiceLineCount");
    }
  });

  it("rejects invoiceLineCount: 1.5", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
      invoiceLineCount: 1.5,
    } as any;

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invoiceLineCount");
    }
  });

  it("rejects invoiceLineCount: \"3\"", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
      invoiceLineCount: "3",
    } as any;

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invoiceLineCount");
    }
  });

  it("rejects invoiceLineCount: 1000", () => {
    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "doc1",
          page: 2,
          lines: [
            { text: "Some text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
          ],
        },
      ],
      invoiceLineCount: 1000,
    } as any;

    const result = validateReaderOutput(output, mockInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invoiceLineCount");
    }
  });
});

describe("readerContract: composeDocumentTexts", () => {
  it("takes text from textDocs for text pages", () => {
    const textDocs: DocumentText[] = [
      {
        docId: "doc1",
        kind: "invoice",
        pages: [
          {
            page: 1,
            width: 100,
            height: 100,
            items: [],
            text: "Original text content",
            spans: [],
          },
        ],
      },
    ];

    const input: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "doc1",
          kind: "invoice",
          fileName: "invoice.pdf",
          fileSha256: "0".repeat(64),
          pages: [
            { page: 1, width: 100, height: 100, text: "Invoice text", image: null },
          ],
        },
      ],
    };

    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [],
    };

    const result = composeDocumentTexts(textDocs, input, output);

    expect(result).toHaveLength(1);
    expect(result[0].docId).toBe("doc1");
    expect(result[0].pages).toHaveLength(1);
    expect(result[0].pages[0].text).toBe("Original text content");
    expect(result[0].pages[0].origin).toBeUndefined(); // text pages should not have origin
  });

  it("builds page from transcript for image pages", () => {
    const textDocs: DocumentText[] = [
      {
        docId: "doc1",
        kind: "invoice",
        pages: [],
      },
    ];

    const input: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "doc1",
          kind: "invoice",
          fileName: "invoice.pdf",
          fileSha256: "0".repeat(64),
          pages: [
            { page: 1, width: 200, height: 150, text: null, image: { mediaType: "image/jpeg", base64: "QUJD" } },
          ],
        },
      ],
    };

    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "doc1",
          page: 1,
          lines: [
            { text: "Line 1", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } },
            { text: "Line 2", box: { x: 0.1, y: 0.35, w: 0.3, h: 0.1 } },
          ],
        },
      ],
    };

    const result = composeDocumentTexts(textDocs, input, output);

    expect(result).toHaveLength(1);
    expect(result[0].docId).toBe("doc1");
    expect(result[0].pages).toHaveLength(1);
    expect(result[0].pages[0].origin).toBe("imageTranscript");
    expect(result[0].pages[0].items).toHaveLength(2);
    expect(result[0].pages[0].items[0].str).toBe("Line 1");
    expect(result[0].pages[0].items[1].str).toBe("Line 2");
  });

  it("throws when text page is missing from textDocs", () => {
    const textDocs: DocumentText[] = [
      {
        docId: "doc1",
        kind: "invoice",
        pages: [], // Missing page 1
      },
    ];

    const input: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "doc1",
          kind: "invoice",
          fileName: "invoice.pdf",
          fileSha256: "0".repeat(64),
          pages: [
            { page: 1, width: 100, height: 100, text: "Invoice text", image: null },
          ],
        },
      ],
    };

    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [],
    };

    expect(() => composeDocumentTexts(textDocs, input, output)).toThrow();
  });

  it("composes an image-only document without textDocs entry", () => {
    const textDocs: DocumentText[] = []; // No entry needed for image-only

    const input: ReaderInput = {
      bundle: "test",
      documents: [
        {
          docId: "photo1",
          kind: "invoice",
          fileName: "invoice.jpg",
          fileSha256: "0".repeat(64),
          pages: [
            { page: 1, width: 200, height: 150, text: null, image: { mediaType: "image/jpeg", base64: "QUJD" } },
          ],
        },
      ],
    };

    const output: ReaderOutput = {
      reader: "test-reader",
      fields: [],
      transcripts: [
        {
          doc: "photo1",
          page: 1,
          lines: [
            { text: "Page text", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } },
          ],
        },
      ],
    };

    const result = composeDocumentTexts(textDocs, input, output);

    expect(result).toHaveLength(1);
    expect(result[0].docId).toBe("photo1");
    expect(result[0].pages).toHaveLength(1);
    expect(result[0].pages[0].origin).toBe("imageTranscript");
    expect(result[0].pages[0].items).toHaveLength(1);
    expect(result[0].pages[0].items[0].str).toBe("Page text");
  });
});
