import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { verifyReadings, type VerifiedReading } from "./reading";
import { readerOutputToAnswer, composeDocumentTexts, type ReaderInput, type ReaderOutput } from "./readerContract";
import {
  buildDraft,
  allFields,
  isImageReviewReason,
  type Draft,
  type DraftField,
  type DocSource,
  IMAGE_REVIEW_REASON,
  IMAGE_COMPUTED_REVIEW_REASON,
  LOW_CONFIDENCE_REVIEW_REASON,
  CONFIRMED_NOTE,
  UNPLACED_COMPUTED_REVIEW_REASON,
  LINE_WITHOUT_BOX_REVIEW_REASON,
  LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON,
} from "./draft";
import { formatSource, draftToCsv } from "./csv";
import type { HtsTable } from "./hts";

// Feature: document-intake, Requirement 58.3 to 58.7 (task 73.1): a value read from a transcript line with no usable place
// reaches the draft like an image value, waits for a person with its own reason, and has no box.
// The recorded real answer of test bundle A (2026-11-26) gives the scanned packing list and the photo of the bill of lading.
// Its invoice is a text PDF that is not in this repository, so its readings are put in as accepted text-page readings
// (all but the two "Same as importer" readings, which the app rejects).

const BUNDLE_A = join(process.cwd(), "samples", "real-reads", "test-bundle-a.json");
type Variant = { dropBlGross?: boolean; allHigh?: boolean; vesselLineWithoutBox?: boolean; vesselLow?: boolean; invoiceLineWithoutBox?: boolean };

function verifiedA(v: Variant = {}): VerifiedReading[] {
  const body = JSON.parse(readFileSync(BUNDLE_A, "utf8"));
  const transcripts = body.output.transcripts
    .filter((t: { doc: string }) => t.doc !== "invoice")
    .map((t: { doc: string; page: number; lines: { text: string; box: unknown }[] }) => ({
      ...t,
      lines: t.lines.map((l) => (v.vesselLineWithoutBox && t.doc === "billOfLading" && l.text.startsWith("Vessel:") ? { ...l, box: null } : l)),
    }));
  const fields = body.output.fields
    .filter((f: { doc: string; field: string }) => f.doc !== "invoice" && !(v.dropBlGross && f.field === "billOfLading.grossKg"))
    .map((f: { doc: string; field: string; confidence?: string }) =>
      v.allHigh && f.doc === "packingList" ? { ...f, confidence: "high" } : v.vesselLow && f.field === "billOfLading.vessel" ? { ...f, confidence: "low" } : f,
    );
  const output: ReaderOutput = { ...body.output, fields, transcripts };
  const imageDoc = (docId: "packingList" | "billOfLading") => ({
    docId,
    kind: docId,
    fileName: `${docId}.jpg`,
    fileSha256: "0".repeat(64),
    pages: [{ page: 1, width: 1000, height: 1000, text: null, image: { mediaType: "image/jpeg" as const, base64: "QUJD" } }],
  });
  const input = { bundle: "upload", documents: [imageDoc("packingList"), imageDoc("billOfLading")] } as unknown as ReaderInput;
  const image = verifyReadings(readerOutputToAnswer(input, output), composeDocumentTexts([], input, output));
  let n = 0;
  const invoice: VerifiedReading[] = body.output.fields
    .filter((f: { doc: string; field: string }) => f.doc === "invoice" && !f.field.startsWith("invoice.shipTo."))
    .map((f: VerifiedReading) =>
      v.invoiceLineWithoutBox
        ? ({ ...f, status: "uncertain", box: null, itemIds: [], origin: "imageTranscript", lineWithoutBox: true, lineText: f.quote, message: "line without a box" } as VerifiedReading)
        : ({ ...f, status: "accepted", box: { x: 10, y: 10, w: 10, h: 10 }, itemIds: [`invoice:p1:i${++n}`] } as VerifiedReading),
    );
  return [...invoice, ...image];
}

let hts: HtsTable;
const build = (readings: VerifiedReading[], overrides: { fieldId: string; value: string }[] = []) =>
  buildDraft({ bundle: "upload", reader: "claude-haiku-5-5", readings, hts, invoiceLineCount: 5, packingListLineCount: 5, overrides });
const fieldOf = (d: Draft, id: string) => allFields(d).find((f) => f.id === id)!;
const check = (d: Draft, id: string) => d.checks.find((c) => c.id === id);
const lineWithoutBoxSource = (f: DraftField) => f.sources.some((s) => s.kind === "document" && (s as DocSource & { lineWithoutBox?: true }).lineWithoutBox === true);
const isFlagged = (r: VerifiedReading) => r.status === "uncertain" && (r as { lineWithoutBox?: true }).lineWithoutBox === true;

/** The same readings with every value on a line without a box accepted as an image reading with a box. */
function placed(readings: VerifiedReading[], keep: Set<string> = new Set()): VerifiedReading[] {
  return readings.map((r) => {
    if (!isFlagged(r) || keep.has(r.field) || r.confidence === "low") return r;
    const { message: _m, lineWithoutBox: _l, ...rest } = r as VerifiedReading & { message: string; lineWithoutBox?: true };
    return { ...rest, status: "accepted", box: { x: 10, y: 10, w: 10, h: 10 }, itemIds: [`${r.doc}:p1:i99`], origin: "imageTranscript" } as VerifiedReading;
  });
}

beforeAll(() => {
  hts = JSON.parse(readFileSync(join(process.cwd(), "data", "hts", "2026HTSRev23-subset.json"), "utf8"));
});

describe("Feature: document-intake, Requirement 58.3: the two reasons", () => {
  it("say the transcript line has no usable place", () => {
    expect(LINE_WITHOUT_BOX_REVIEW_REASON).toBe(
      "Read from an image by the AI reader, from a transcript line it gave no usable place for, so there is no box on the page. Find it on the page, check it, then confirm it.",
    );
    expect(LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON).toBe(
      "Computed from values the AI reader read from an image. At least one is from a transcript line it gave no usable place for, so it has no box on the page. Check them against the page, then confirm it.",
    );
  });

  it("are image review reasons (Requirement 58.4)", () => {
    expect(isImageReviewReason(LINE_WITHOUT_BOX_REVIEW_REASON)).toBe(true);
    expect(isImageReviewReason(LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON)).toBe(true);
  });
});

describe("Feature: document-intake, Requirement 58.7: the packing list of the bundle A recording reaches the checks", () => {
  let draft: Draft;
  beforeAll(() => {
    draft = build(verifiedA());
  });

  it("the invoice quantities are compared with the packing list lines", () => {
    for (const id of ["P3.qty.MCA-101", "P3.qty.MCA-102", "P3.qty.MCA-103", "P3.qty.MCA-104"]) {
      expect([id, check(draft, id)?.ok, check(draft, id)?.detail]).toEqual([id, true, "invoice qty = packing sum"]);
    }
    expect([check(draft, "P3.qty.MCA-105")?.ok, check(draft, "P3.qty.MCA-105")?.detail]).toEqual([false, "packing list line 5 not fully read"]);
  });

  it("the packing list sums and the carton count are checked", () => {
    expect([check(draft, "P3.packing.gross")?.ok, check(draft, "P3.packing.gross")?.detail]).toEqual([true, "line sum = 1248.0, total = 1248.0"]);
    expect([check(draft, "P3.packing.net")?.ok, check(draft, "P3.packing.net")?.detail]).toEqual([true, "line sum = 1103.0, total = 1103.0"]);
    expect([check(draft, "P3.packing.cartons")?.ok, check(draft, "P3.packing.cartons")?.detail]).toEqual([true, "line sum = 77, total = 77"]);
    expect([check(draft, "X.bl.packages")?.ok, check(draft, "X.bl.packages")?.detail]).toEqual([true, "B/L packages = 77, packing cartons = 77"]);
  });

  it("the draft's rejected readings list the two packing list readings of confidence low and none of the other 26 (Requirement 58.5)", () => {
    expect(draft.rejectedReadings.filter((r) => r.field.startsWith("packingList.")).map((r) => [r.field, r.reason])).toEqual([
      ["packingList.lines.5.itemNo", "low_confidence"],
      ["packingList.totalQuantity", "low_confidence"],
    ]);
  });
});

describe("Feature: document-intake, Requirement 58.3 and 58.4: values on a line without a box wait for a person", () => {
  let readings: VerifiedReading[];
  let draft: Draft;
  beforeAll(() => {
    // Without the bill of lading weight and with the two low readings sure, the draft splits the gross weight over the lines.
    readings = verifiedA({ dropBlGross: true, allHigh: true });
    draft = build(readings);
  });

  it("34A is computed from the packing list lines and waits with the computed reason of 58.3", () => {
    expect(["L001.34A", "L002.34A", "L003.34A", "L004.34A"].map((id) => [id, fieldOf(draft, id).status, fieldOf(draft, id).value, fieldOf(draft, id).reason])).toEqual([
      ["L001.34A", "needsReview", "540", LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON],
      ["L002.34A", "needsReview", "384", LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON],
      ["L003.34A", "needsReview", "285", LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON],
      ["L004.34A", "needsReview", "39", LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON],
    ]);
  });

  it("the document source of such a value has no box and the flag", () => {
    const s = fieldOf(draft, "L002.34A").sources.find((x) => x.kind === "document" && x.readingField === "packingList.lines.2.grossKg");
    expect(s).toMatchObject({ kind: "document", doc: "packingList", page: 1, quote: "384.0", box: null, origin: "imageTranscript", lineWithoutBox: true });
    expect(s && "notInTranscript" in s).toBe(false);
  });

  it("with the same readings accepted with a box, every value and status is the same and only the reason is the image reason", () => {
    const ref = build(placed(readings));
    const a = allFields(draft);
    const b = allFields(ref);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    for (let i = 0; i < a.length; i++) {
      expect([a[i].id, a[i].status, a[i].value]).toEqual([b[i].id, b[i].status, b[i].value]);
      const expected = !lineWithoutBoxSource(a[i])
        ? b[i].reason
        : b[i].reason === IMAGE_COMPUTED_REVIEW_REASON
          ? LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON
          : b[i].reason === IMAGE_REVIEW_REASON
            ? LINE_WITHOUT_BOX_REVIEW_REASON
            : b[i].reason;
      expect([a[i].id, a[i].reason]).toEqual([b[i].id, expected]);
    }
    expect(draft.checks).toEqual(ref.checks);
  });

  it("a person's value equal to the shown value confirms it; another value is a person's value as today", () => {
    const shown = fieldOf(draft, "L002.34A").value!;
    expect(fieldOf(build(readings, [{ fieldId: "L002.34A", value: shown }]), "L002.34A")).toMatchObject({ status: "computed", value: shown, reason: null, note: CONFIRMED_NOTE });
    expect(fieldOf(build(readings, [{ fieldId: "L002.34A", value: "400" }]), "L002.34A")).toMatchObject({ status: "personEdited", value: "400" });
  });

  it("with a source outside the transcript too, the reason of Requirement 50.3 stays", () => {
    const mixed = readings.map((r) => {
      if (r.field !== "packingList.lines.2.grossKg") return r;
      const { lineWithoutBox: _l, lineText: _t, ...rest } = r as VerifiedReading & { lineWithoutBox?: true; lineText?: string };
      return { ...rest, notInTranscript: true } as VerifiedReading;
    });
    const d = build(mixed);
    expect([fieldOf(d, "L002.34A").status, fieldOf(d, "L002.34A").value, fieldOf(d, "L002.34A").reason]).toEqual(["needsReview", "384", UNPLACED_COMPUTED_REVIEW_REASON]);
    expect(fieldOf(d, "L001.34A").reason).toBe(LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON);
  });
});

describe("Feature: document-intake, Requirement 58.3 and 30.1: a value computed again after a person's edit", () => {
  it("with the invoice read from lines without a box, L003.35 computed again after a person enters L003.33A waits with the computed reason of 58.3", () => {
    const readings = verifiedA({ dropBlGross: true, allHigh: true, invoiceLineWithoutBox: true });
    const d = build(readings, [{ fieldId: "L003.33A", value: "9405.50.4000" }]);
    expect([fieldOf(d, "L003.33A").status, fieldOf(d, "L003.35").status, fieldOf(d, "L003.35").value, fieldOf(d, "L003.35").reason]).toEqual([
      "personEdited",
      "needsReview",
      "300",
      LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON,
    ]);
  });
});

describe("Feature: document-intake, Requirement 58.3 to 58.6: a copied value on a line without a box, low confidence, the CSV", () => {
  it("B8 from a vessel line without a box shows the value with the copied reason of 58.3 and is confirmed by the shown value", () => {
    const readings = verifiedA({ vesselLineWithoutBox: true });
    const d = build(readings);
    const b8 = fieldOf(d, "B8");
    expect([b8.status, b8.value, b8.reason]).toEqual(["needsReview", "OWLFERRY DAWN", LINE_WITHOUT_BOX_REVIEW_REASON]);
    expect(b8.sources[0]).toMatchObject({ kind: "document", readingField: "billOfLading.vessel", box: null, lineWithoutBox: true });
    expect(fieldOf(build(readings, [{ fieldId: "B8", value: "OWLFERRY DAWN" }]), "B8")).toMatchObject({ status: "copied", value: "OWLFERRY DAWN", reason: null, note: CONFIRMED_NOTE });
  });

  it("with confidence low the value is an uncertain reading of Requirement 36: B8 shows it with the low-confidence reason and no box", () => {
    const d = build(verifiedA({ vesselLineWithoutBox: true, vesselLow: true }));
    const b8 = fieldOf(d, "B8");
    expect([b8.status, b8.value, b8.reason]).toEqual(["needsReview", "OWLFERRY DAWN", LOW_CONFIDENCE_REVIEW_REASON]);
    expect(b8.sources[0]).toMatchObject({ kind: "document", box: null, lineWithoutBox: true });
    expect(d.rejectedReadings.map((r) => r.field)).toContain("billOfLading.vessel");
  });

  it("the CSV source says no box and that the transcript line has no place", () => {
    const d = build(verifiedA({ dropBlGross: true, allHigh: true }));
    const s = fieldOf(d, "L002.34A").sources.find((x) => x.kind === "document" && x.readingField === "packingList.lines.2.grossKg")!;
    expect(formatSource(s)).toBe('packingList p.1 [no box] "384.0" (read from an image by the AI reader) (transcript line with no place)');
    expect(draftToCsv(d)).toContain('packingList p.1 [no box] ""384.0"" (read from an image by the AI reader) (transcript line with no place)');
  });
});

describe("Feature: document-intake, Property 78: No Draft Value From a Line With No Usable Place Is Final Without a Person (Validates: Requirements 58.3, 58.4)", () => {
  it("for any subset of the bundle A values left on lines without a box, every field with such a source waits, has no box in that source, and every value is as with boxes", () => {
    const readings = verifiedA({ dropBlGross: true, allHigh: true });
    const flagged = readings.filter(isFlagged).map((r) => r.field);
    expect(flagged.length).toBe(28);
    const ref = build(placed(readings));
    const refById = new Map(allFields(ref).map((f) => [f.id, f]));
    fc.assert(
      fc.property(fc.subarray(flagged), (keep) => {
        const d = build(placed(readings, new Set(keep)));
        for (const f of allFields(d)) {
          const r = refById.get(f.id)!;
          expect([f.id, f.value]).toEqual([r.id, r.value]);
          if (!lineWithoutBoxSource(f)) continue;
          expect([f.id, f.status]).toEqual([f.id, "needsReview"]);
          for (const s of f.sources) if (s.kind === "document" && (s as DocSource & { lineWithoutBox?: true }).lineWithoutBox) expect(s.box).toBeNull();
        }
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
