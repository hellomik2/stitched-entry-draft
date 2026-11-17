import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { verifyReadings } from "./reading";
import type { ReadingAnswer, VerifiedReading } from "./reading";
import type { DocumentText } from "./pdfText";
import { loadBundleFromDisk } from "../node/index";

let bundleAnswer: ReadingAnswer;
let bundleDocuments: DocumentText[];

describe("Reading verification with confidence and image origin", () => {
  beforeAll(async () => {
    const bundle = await loadBundleFromDisk(process.cwd(), "lantern-hollow");
    bundleAnswer = bundle.answer;
    bundleDocuments = bundle.documents;
  });

  describe("Feature: document-intake, Property 2: Confidence Always Rejects Low (Validates: Requirements 5.1, 5.4)", () => {
    it(
      "should reject all fields marked with low confidence",
      () => {
        fc.assert(
          fc.property(
            fc.uniqueArray(fc.integer({ min: 0, max: bundleAnswer.fields.length - 1 }), {
              minLength: 0,
              maxLength: bundleAnswer.fields.length,
            }),
            (lowConfidenceIndexes) => {
              // Create a modified answer with low confidence on selected fields
              const modifiedAnswer: ReadingAnswer = {
                ...bundleAnswer,
                fields: bundleAnswer.fields.map((field, i) => {
                  if (lowConfidenceIndexes.includes(i)) {
                    return { ...field, confidence: "low" as const };
                  }
                  return { ...field };
                }),
              };

              // Verify the modified readings
              const verified = verifyReadings(modifiedAnswer, bundleDocuments);

              // Check that all low-confidence fields are rejected with reason "low_confidence"
              for (let i = 0; i < verified.length; i++) {
                if (lowConfidenceIndexes.includes(i)) {
                  const v = verified[i];
                  expect(v.status).toBe("rejected");
                  if (v.status === "rejected") {
                    expect(v.reason).toBe("low_confidence");
                  }
                }
              }

              // Check that other fields keep their original status
              for (let i = 0; i < verified.length; i++) {
                if (!lowConfidenceIndexes.includes(i)) {
                  const original = verifyReadings(bundleAnswer, bundleDocuments)[i];
                  expect(verified[i].status).toBe(original.status);
                  if (verified[i].status === "rejected" && original.status === "rejected") {
                    expect((verified[i] as any).reason).toBe((original as any).reason);
                  }
                }
              }
            },
          ),
          { numRuns: 100 },
        );
      },
      60000,
    );
  });

  describe("Feature: document-intake, Property 3: Absent Confidence Treated as Passed (Validates: Requirements 5.3)", () => {
    it(
      "should treat absent confidence same as running verification on unchanged sample",
      () => {
        fc.assert(
          fc.property(
            fc.uniqueArray(fc.integer({ min: 0, max: bundleAnswer.fields.length - 1 }), {
              minLength: 0,
              maxLength: bundleAnswer.fields.length,
            }),
            (highConfidenceIndexes) => {
              // Create a modified answer with high confidence on selected fields, rest absent
              const modifiedAnswer: ReadingAnswer = {
                ...bundleAnswer,
                fields: bundleAnswer.fields.map((field, i) => {
                  if (highConfidenceIndexes.includes(i)) {
                    return { ...field, confidence: "high" as const };
                  }
                  // Remove confidence field (leave it undefined)
                  const { confidence, ...rest } = field as any;
                  return rest;
                }),
              };

              // Verify both versions
              const verified = verifyReadings(modifiedAnswer, bundleDocuments);
              const original = verifyReadings(bundleAnswer, bundleDocuments);

              // Check that statuses and reasons are identical
              for (let i = 0; i < verified.length; i++) {
                expect(verified[i].status).toBe(original[i].status);
                if (verified[i].status === "rejected") {
                  expect((verified[i] as any).reason).toBe((original[i] as any).reason);
                }
              }
            },
          ),
          { numRuns: 100 },
        );
      },
      60000,
    );
  });
});
