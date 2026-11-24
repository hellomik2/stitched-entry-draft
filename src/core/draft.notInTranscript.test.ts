import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { verifyReadings, type VerifiedReading } from "./reading";
import { readerOutputToAnswer, composeDocumentTexts, type ReaderInput, type ReaderOutput } from "./readerContract";
import {
  buildDraft,
  allFields,
  type Draft,
  type DraftField,
  type DocSource,
  IMAGE_REVIEW_REASON,
  IMAGE_COMPUTED_REVIEW_REASON,
  LOW_CONFIDENCE_REVIEW_REASON,
  CONFIRMED_NOTE,
  UNPLACED_REVIEW_REASON,
  UNPLACED_COMPUTED_REVIEW_REASON,
} from "./draft";
import { formatSource, draftToCsv } from "./csv";
import type { HtsTable } from "./hts";

// Feature: document-intake, Requirement 50.3 to 50.5 (task 63.1): a value read from an image line that is not in the
// transcript reaches the draft like an image value, waits for a person with its own reason, and has no box.

const BUNDLE_C = join(process.cwd(), "samples", "real-reads", "test-bundle-c.json");

function bundleCImagePart(): { input: ReaderInput; output: ReaderOutput } {
  const body = JSON.parse(readFileSync(BUNDLE_C, "utf8"));
  const output: ReaderOutput = {
    ...body.output,
    fields: body.output.fields.filter((f: { doc: string }) => f.doc !== "billOfLading"),
    transcripts: body.output.transcripts.filter((t: { doc: string }) => t.doc !== "billOfLading"),
  };
  const imageDoc = (docId: "invoice" | "packingList") => ({
    docId,
    kind: docId,
    fileName: `${docId}.jpg`,
    fileSha256: "0".repeat(64),
    pages: [{ page: 1, width: 1000, height: 1000, text: null, image: { mediaType: "image/jpeg" as const, base64: "QUJD" } }],
  });
  const input = { bundle: "upload", documents: [imageDoc("invoice"), imageDoc("packingList")] } as unknown as ReaderInput;
  return { input, output };
}

let hts: HtsTable;
let verified: VerifiedReading[];
let draft: Draft;

const build = (readings: VerifiedReading[], overrides: { fieldId: string; value: string }[] = []) =>
  buildDraft({ bundle: "upload", reader: "claude-haiku-5-5", readings, hts, invoiceLineCount: 4, overrides });

/** The same readings with every value outside the transcript accepted as an image reading with a box. */
function placed(readings: VerifiedReading[], keepUnplaced: Set<string> = new Set()): VerifiedReading[] {
  return readings.map((r) => {
    if (r.status !== "uncertain" || !r.notInTranscript || keepUnplaced.has(r.field)) return r;
    const { message: _m, notInTranscript: _n, ...rest } = r as VerifiedReading & { message: string; notInTranscript?: true };
    return { ...rest, status: "accepted", box: { x: 10, y: 10, w: 10, h: 10 }, itemIds: [`${r.doc}:p1:i99`], origin: "imageTranscript" } as VerifiedReading;
  });
}

const fieldOf = (d: Draft, id: string) => allFields(d).find((f) => f.id === id)!;
const unplacedSource = (f: DraftField) => f.sources.some((s) => s.kind === "document" && (s as DocSource).notInTranscript === true);

beforeAll(() => {
  hts = JSON.parse(readFileSync(join(process.cwd(), "data", "hts", "2026HTSRev23-subset.json"), "utf8"));
  const { input, output } = bundleCImagePart();
  verified = verifyReadings(readerOutputToAnswer(input, output), composeDocumentTexts([], input, output));
  draft = build(verified);
});

describe("Feature: document-intake, Requirement 50.3: values outside the transcript reach the draft and wait for a person", () => {
  it("the two reasons say the line is not in the transcript", () => {
    expect(UNPLACED_REVIEW_REASON).toBe(
      "Read from an image by the AI reader, from a line that is not in its transcript, so there is no box on the page. Find it on the page, check it, then confirm it.",
    );
    expect(UNPLACED_COMPUTED_REVIEW_REASON).toBe(
      "Computed from values the AI reader read from an image. At least one is from a line that is not in its transcript, so it has no box on the page. Check them against the page, then confirm it.",
    );
  });

  it("a line description, an origin and the exporting country show the read value with the unplaced reason", () => {
    expect(fieldOf(draft, "L001.32")).toMatchObject({ status: "needsReview", value: "Paper lantern, bat print", reason: UNPLACED_REVIEW_REASON });
    expect(fieldOf(draft, "L001.10")).toMatchObject({ status: "needsReview", value: "VN", reason: UNPLACED_REVIEW_REASON });
    expect(fieldOf(draft, "L004.10")).toMatchObject({ status: "needsReview", value: "CN", reason: UNPLACED_REVIEW_REASON });
    expect(fieldOf(draft, "B14")).toMatchObject({ status: "needsReview", value: "VN", reason: UNPLACED_REVIEW_REASON });
    expect(fieldOf(draft, "L001.33A")).toMatchObject({ status: "needsReview", value: "9505.90.6000" });
  });

  it("the document source of such a value has no box and the flag", () => {
    const s = fieldOf(draft, "L001.32").sources[0] as DocSource;
    expect(s).toMatchObject({ kind: "document", doc: "invoice", page: 1, quote: "Paper lantern, bat print", box: null, readingField: "invoice.lines.1.description", origin: "imageTranscript", notInTranscript: true });
  });

  it("no field with such a source is copied or computed before a person confirms it", () => {
    const withUnplaced = allFields(draft).filter(unplacedSource);
    expect(withUnplaced.length).toBeGreaterThan(20);
    for (const f of withUnplaced) expect(f.status).toBe("needsReview");
  });

  it("every field has the value and status it has when the same readings are accepted with a box; only the image reasons change", () => {
    const ref = build(placed(verified));
    const a = allFields(draft);
    const b = allFields(ref);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    for (let i = 0; i < a.length; i++) {
      expect([a[i].id, a[i].status, a[i].value]).toEqual([b[i].id, b[i].status, b[i].value]);
      const expectedReason = unplacedSource(a[i])
        ? b[i].reason === IMAGE_REVIEW_REASON
          ? UNPLACED_REVIEW_REASON
          : b[i].reason === IMAGE_COMPUTED_REVIEW_REASON
            ? UNPLACED_COMPUTED_REVIEW_REASON
            : b[i].reason
        : b[i].reason;
      expect([a[i].id, a[i].reason]).toEqual([b[i].id, expectedReason]);
    }
    expect(draft.checks).toEqual(ref.checks);
  });
});

describe("Feature: document-intake, Requirement 50.4: confirming works as for the image reasons", () => {
  it("a person's value equal to the shown value confirms a copied value", () => {
    const shown = fieldOf(draft, "L001.32").value!;
    const d = build(verified, [{ fieldId: "L001.32", value: shown }]);
    expect(fieldOf(d, "L001.32")).toMatchObject({ status: "copied", value: shown, reason: null, note: CONFIRMED_NOTE });
  });

  it("a person's value equal to the shown value confirms a computed value", () => {
    const f = allFields(draft).find((x) => x.reason === UNPLACED_COMPUTED_REVIEW_REASON && x.value !== null);
    expect(f).toBeDefined();
    const d = build(verified, [{ fieldId: f!.id, value: f!.value! }]);
    expect(fieldOf(d, f!.id)).toMatchObject({ status: "computed", value: f!.value, reason: null, note: CONFIRMED_NOTE });
  });

  it("a person's other value is a person's value as today", () => {
    const d = build(verified, [{ fieldId: "L001.32", value: "Paper lantern" }]);
    expect(fieldOf(d, "L001.32")).toMatchObject({ status: "personEdited", value: "Paper lantern" });
  });
});

describe("Feature: document-intake, Requirement 50.3 and 50.5: low confidence, and the list of rejected readings", () => {
  it("the draft's rejected readings list only the value that was rejected", () => {
    expect(draft.rejectedReadings.map((r) => r.field)).toEqual(["invoice.seller.address"]);
  });

  it("with confidence low, a value outside the transcript is an uncertain reading of Requirement 36: B14 shows it with the low-confidence reason and no box; a line description stays empty", () => {
    const low = verified.map((r) =>
      r.field === "invoice.countryOfExport" || r.field === "invoice.lines.1.description" ? ({ ...r, confidence: "low" } as VerifiedReading) : r,
    );
    const d = build(low);
    const b14 = fieldOf(d, "B14");
    expect(b14).toMatchObject({ status: "needsReview", value: "VN", reason: LOW_CONFIDENCE_REVIEW_REASON });
    expect(b14.sources[0]).toMatchObject({ kind: "document", box: null, notInTranscript: true });
    expect(fieldOf(d, "L001.32")).toMatchObject({ status: "needsReview", value: null });
    expect(d.rejectedReadings.map((r) => [r.field, r.reason])).toEqual([
      ["invoice.countryOfExport", "low_confidence"],
      ["invoice.seller.address", "value_not_in_quote"],
      ["invoice.lines.1.description", "low_confidence"],
    ]);
  });
});

describe("Feature: document-intake, Requirement 50.6: the CSV source of a value with no box", () => {
  it("says no box and that the line is not in the transcript", () => {
    const s = fieldOf(draft, "L001.32").sources[0];
    expect(formatSource(s)).toBe('invoice p.1 [no box] "Paper lantern, bat print" (read from an image by the AI reader) (not in its transcript)');
    expect(draftToCsv(draft)).toContain('invoice p.1 [no box] ""Paper lantern, bat print"" (read from an image by the AI reader) (not in its transcript)');
  });
});

describe("Feature: document-intake, Property 70: No Draft Value From a Line Outside the Transcript Is Final Without a Person (Validates: Requirements 50.3, 50.4)", () => {
  it("for any subset of the bundle C values left outside the transcript, every field with such a source waits, and every value is as with boxes", () => {
    const unplacedFields = verified.filter((r) => r.status === "uncertain" && r.notInTranscript).map((r) => r.field);
    const ref = build(placed(verified));
    const refById = new Map(allFields(ref).map((f) => [f.id, f]));
    fc.assert(
      fc.property(fc.subarray(unplacedFields), (keep) => {
        const d = build(placed(verified, new Set(keep)));
        for (const f of allFields(d)) {
          const r = refById.get(f.id)!;
          expect([f.id, f.value]).toEqual([r.id, r.value]);
          if (unplacedSource(f)) expect([f.id, f.status]).toEqual([f.id, "needsReview"]);
        }
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
