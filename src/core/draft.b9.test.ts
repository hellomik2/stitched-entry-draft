import { describe, it, expect } from "vitest";
import { runBundleFromDisk } from "../node/index";
import { buildDraft } from "./draft";
import { verifyReadings } from "./reading";
import type { ReadingAnswer } from "./reading";

// Requirement 44.3 (agy cross-check 2, R11): B9 says "the B/L lists a container" only when a container number was accepted.
const B9_WAIT = "The container number on the bill of lading was not read, so the mode of transport is not known. A person checks the bill of lading.";

describe("Feature: document-intake, Requirement 44.3: Block 9 waits without a container number", () => {
  const load = runBundleFromDisk(process.cwd(), "lantern-hollow", []);
  const b9Of = async (change: (fields: ReadingAnswer["fields"]) => ReadingAnswer["fields"]) => {
    const b = await load;
    const answer = { ...b.answer, fields: change(b.answer.fields) };
    const draft = buildDraft({ bundle: "lantern-hollow", reader: b.draft.reader, readings: verifyReadings(answer, b.documents), hts: b.hts });
    return draft.header.find((f) => f.id === "B9");
  };
  const waits = (f: Awaited<ReturnType<typeof b9Of>>) => [f?.status, f?.value, f?.rule, f?.note, f?.reason];

  it("the sample (container number accepted) keeps B9 as today", async () => {
    const b = await load;
    const f = b.draft.header.find((x) => x.id === "B9");
    expect([f?.status, f?.value, f?.rule, f?.note, f?.sources.length]).toEqual(["computed", "11", "7501 p.8", "Vessel, containerized: the B/L lists a container.", 1]);
  });

  it("container number not read: B9 waits with no value", async () => {
    expect(waits(await b9Of((fs) => fs.filter((x) => x.field !== "billOfLading.containerNo")))).toEqual(["needsReview", null, null, null, B9_WAIT]);
  });

  it("container number rejected (quote not on the page): B9 waits with no value", async () => {
    expect(waits(await b9Of((fs) => fs.map((x) => (x.field === "billOfLading.containerNo" ? { ...x, value: "ABCU 0000000", quote: "Container No.: ABCU 0000000" } : x))))).toEqual(["needsReview", null, null, null, B9_WAIT]);
  });

  it("container number not sure (confidence low): B9 waits with no value", async () => {
    expect(waits(await b9Of((fs) => fs.map((x) => (x.field === "billOfLading.containerNo" ? { ...x, confidence: "low" as const } : x))))).toEqual(["needsReview", null, null, null, B9_WAIT]);
  });
});
