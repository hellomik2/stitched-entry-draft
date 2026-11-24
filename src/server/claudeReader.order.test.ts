import { describe, it, expect } from "vitest";
import { READER_SYSTEM_PROMPT, READER_OUTPUT_SCHEMA, buildReaderRequest } from "./claudeReader";
import { validateReaderOutput, readerOutputToAnswer, type ReaderInput, type ReaderOutput } from "../core/readerContract";
import { validateReadingAnswer } from "../core/reading";
import { estimateReaderCall } from "../core/budget";

// Feature: document-intake, Requirement 51.1 to 51.4 and 51.6 (task 64.1): the reader writes the transcripts first,
// is asked for every packing list row, and counts the packing list lines.

const input: ReaderInput = {
  bundle: "upload",
  documents: [
    {
      docId: "invoice",
      kind: "invoice",
      fileName: "invoice.pdf",
      fileSha256: "0".repeat(64),
      pages: [{ page: 1, width: 612, height: 792, text: "Invoice No.: 1", image: null }],
    },
    {
      docId: "packingList",
      kind: "packingList",
      fileName: "packing.jpg",
      fileSha256: "1".repeat(64),
      pages: [{ page: 1, width: 1000, height: 1000, text: null, image: { mediaType: "image/jpeg", base64: "QUJD" } }],
    },
  ],
};

const output = (extra: Record<string, unknown>): ReaderOutput =>
  ({
    reader: "claude-haiku-5-5",
    fields: [{ field: "invoice.number", value: "1", quote: "Invoice No.: 1", doc: "invoice", page: 1, confidence: "high" }],
    transcripts: [{ doc: "packingList", page: 1, lines: [{ text: "PACKING LIST", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.03 } }] }],
    invoiceLineCount: 1,
    ...extra,
  }) as ReaderOutput;

describe("Feature: document-intake, Requirement 51.1: the schema asks for the transcripts before the fields", () => {
  it("the properties and the required list are in the order transcripts, fields, invoiceLineCount, packingListLineCount", () => {
    const order = ["transcripts", "fields", "invoiceLineCount", "packingListLineCount"];
    expect(Object.keys(READER_OUTPUT_SCHEMA.properties)).toEqual(order);
    expect(READER_OUTPUT_SCHEMA.required).toEqual(order);
    expect((READER_OUTPUT_SCHEMA.properties as Record<string, { type: unknown }>).packingListLineCount.type).toEqual(["integer", "null"]);
  });

  it("the schema sent in a request keeps the order", () => {
    const schema = (buildReaderRequest(input).output_config as unknown as { format: { schema: { properties: object; required: string[] } } }).format.schema;
    expect(Object.keys(schema.properties)).toEqual(["transcripts", "fields", "invoiceLineCount", "packingListLineCount"]);
    expect(schema.required).toEqual(["transcripts", "fields", "invoiceLineCount", "packingListLineCount"]);
  });

  it("the schema keeps at most 16 parameters with union types (an API limit)", () => {
    const text = JSON.stringify(READER_OUTPUT_SCHEMA);
    expect((text.match(/"type":\[/g) ?? []).length).toBeLessThanOrEqual(16);
  });
});

describe("Feature: document-intake, Requirement 51.2 and 51.3: the prompt paragraphs", () => {
  it("the transcript paragraph asks for the transcripts before the fields, one table row per line, and every quoted line", () => {
    expect(READER_SYSTEM_PROMPT).toContain(
      'For every image page add one transcript, before the fields: every printed line in reading order, one table row per line, each as {"t": the line text, "b": [x, y, w, h]} where x, y, w and h are whole numbers from 0 to 1000 in thousandths of the page width and height, origin top-left. A quote for an image page must be copied from one of your transcript lines, so put every line you quote in the transcript. Text pages get no transcript.',
    );
    expect(READER_SYSTEM_PROMPT).not.toContain("Quotes for image pages must come from these lines.");
  });

  it("the packing list paragraphs ask for every row, leave out only a value that cannot be given, and ask for the count", () => {
    expect(READER_SYSTEM_PROMPT).toContain(
      "Give every item row of a packing list as packingList.lines.<n> fields in printed order. When one value of a row cannot be given as asked (for example a weight printed in pounds, LB or LBS, for a kg field), leave out only that field and give the other fields of the row; never convert a unit.",
    );
    expect(READER_SYSTEM_PROMPT).toContain(
      'Set "packingListLineCount" to the number of item lines printed on the packing list, counting lines whose fields you leave out; use null when no packing list is given.',
    );
    const inv = READER_SYSTEM_PROMPT.indexOf('Set "invoiceLineCount"');
    const rows = READER_SYSTEM_PROMPT.indexOf("Give every item row of a packing list");
    const count = READER_SYSTEM_PROMPT.indexOf('Set "packingListLineCount"');
    expect(inv).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(inv);
    expect(count).toBeGreaterThan(rows);
  });

  it("the words other tests and Requirement 29 check are still there", () => {
    expect(READER_SYSTEM_PROMPT).toContain('"t": the line text');
    expect(READER_SYSTEM_PROMPT).toContain('"b": [x, y, w, h]');
    expect(READER_SYSTEM_PROMPT).toContain("thousandths of the page width and height");
    expect(READER_SYSTEM_PROMPT).toContain("Write the JSON on one line, with no indentation.");
    expect(READER_SYSTEM_PROMPT).toContain("Never guess, compute, total or convert values.");
  });
});

describe("Feature: document-intake, Requirement 51.4: packingListLineCount in the contract", () => {
  it("the validator accepts it absent, null or an integer from 0 to 999", () => {
    expect(validateReaderOutput(output({}), input).ok).toBe(true);
    expect(validateReaderOutput(output({ packingListLineCount: null }), input).ok).toBe(true);
    expect(validateReaderOutput(output({ packingListLineCount: 0 }), input).ok).toBe(true);
    expect(validateReaderOutput(output({ packingListLineCount: 6 }), input).ok).toBe(true);
    expect(validateReaderOutput(output({ packingListLineCount: 999 }), input).ok).toBe(true);
  });

  it("the validator refuses any other value with the reason", () => {
    for (const bad of [-1, 1000, 2.5, "6", true]) {
      const r = validateReaderOutput(output({ packingListLineCount: bad }), input);
      expect(r).toEqual({ ok: false, reason: "packingListLineCount: must be null or an integer from 0 to 999" });
    }
  });

  it("readerOutputToAnswer copies it, and leaves it out when the output has none", () => {
    expect(readerOutputToAnswer(input, output({ packingListLineCount: 6 })).packingListLineCount).toBe(6);
    expect(readerOutputToAnswer(input, output({ packingListLineCount: null })).packingListLineCount).toBeNull();
    expect("packingListLineCount" in readerOutputToAnswer(input, output({}))).toBe(false);
  });

  it("validateReadingAnswer checks it as it checks invoiceLineCount", () => {
    const answer = { schemaVersion: 1, bundle: "b", reader: "r", documents: [], fields: [] };
    expect(validateReadingAnswer({ ...answer, packingListLineCount: 6 }).ok).toBe(true);
    expect(validateReadingAnswer({ ...answer, packingListLineCount: null }).ok).toBe(true);
    expect(validateReadingAnswer(answer).ok).toBe(true);
    expect(validateReadingAnswer({ ...answer, packingListLineCount: -1 })).toEqual({ ok: false, reason: "packingListLineCount must be null or an integer from 0 to 999" });
  });
});

describe("Feature: document-intake, Requirement 51.6: the call's limits stay", () => {
  it("max_tokens is the output room of the estimate and thinking stays off", () => {
    const req = buildReaderRequest(input);
    expect(req.max_tokens).toBe(estimateReaderCall(input).outputTokens);
    expect(req.thinking).toEqual({ type: "disabled" });
  });
});
