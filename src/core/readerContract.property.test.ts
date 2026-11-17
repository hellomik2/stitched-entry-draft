import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { validateReaderInput } from "./readerContract";
import { intakeConfig } from "./intakeConfig";

describe("readerContract: property tests", () => {
  it("Feature: document-intake, Property 25: Reader input limits (Validates: Requirements 1.2, 1.3)", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.array(
            fc.tuple(
              fc.stringMatching(/^[0-9a-f]{64}$/),
              fc.constantFrom("invoice", "packingList", "billOfLading"),
              fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/),
              fc.array(
                fc.tuple(
                  fc.base64String(),
                  fc.integer({ min: 0, max: 1 }), // 0 for text, 1 for image
                ),
                { minLength: 1, maxLength: 4 },
              ),
            ),
            { minLength: 1, maxLength: 3 },
          ),
        ),
        ([docsData]) => {
          // Generate valid inputs
          const documents = docsData.map((docData, docIndex) => {
            const [sha256, kind, docId, pages] = docData;

            const validPages = pages.map((pageData, pageIndex) => {
              const [base64Raw, imageType] = pageData;

              if (imageType === 0) {
                // Text page
                return {
                  page: pageIndex + 1,
                  width: 100,
                  height: 100,
                  text: "Sample text content",
                  image: null,
                };
              } else {
                // Image page - ensure valid base64
                const validBase64 = base64Raw.replace(/[^A-Za-z0-9+/]/g, "A").substring(0, 20);
                return {
                  page: pageIndex + 1,
                  width: 100,
                  height: 100,
                  text: null,
                  image: { mediaType: "image/jpeg" as const, base64: validBase64 || "QUJD" },
                };
              }
            });

            return {
              docId: `d${docIndex}-${docId.slice(0, 30)}`,
              kind,
              fileName: "test.pdf",
              fileSha256: sha256,
              pages: validPages,
            };
          });

          // Count image pages to ensure we don't exceed limit
          let imagePageCount = 0;
          for (const doc of documents) {
            for (const page of doc.pages) {
              if (page.image !== null) imagePageCount++;
            }
          }

          // If we exceed image page limit, skip this test case
          if (imagePageCount > intakeConfig.maxImagePages) {
            return true; // Valid case to skip
          }

          const input = {
            bundle: "test-bundle",
            documents,
          };

          const result = validateReaderInput(input, intakeConfig);
          expect(result.ok).toBe(true);

          // Test violations one at a time
          // 1. Add documents until we exceed maxFiles
          const docsToAdd = intakeConfig.maxFiles + 1 - documents.length;
          const extraDocs = Array.from({ length: docsToAdd }, (_, i) => ({
            docId: `extra-${i + 1}`,
            kind: "invoice" as const,
            fileName: `extra-${i + 1}.pdf`,
            fileSha256: "1".repeat(64),
            pages: [
              { page: 1, width: 100, height: 100, text: "text", image: null },
            ],
          }));
          const violationInput1 = {
            bundle: "test-bundle",
            documents: [...documents, ...extraDocs],
          };
          const violationResult1 = validateReaderInput(violationInput1, intakeConfig);
          expect(violationResult1.ok).toBe(false);

          // 2. Bad SHA-256
          if (documents.length > 0) {
            const violationInput = {
              bundle: "test-bundle",
              documents: [
                {
                  ...documents[0],
                  fileSha256: "not-valid-sha",
                },
                ...documents.slice(1),
              ],
            };
            const violationResult = validateReaderInput(violationInput, intakeConfig);
            expect(violationResult.ok).toBe(false);
          }

          // 3. Duplicate docId
          if (documents.length > 1) {
            const violationInput = {
              bundle: "test-bundle",
              documents: [
                documents[0],
                {
                  ...documents[1],
                  docId: documents[0].docId,
                },
                ...documents.slice(2),
              ],
            };
            const violationResult = validateReaderInput(violationInput, intakeConfig);
            expect(violationResult.ok).toBe(false);
          }

          // 4. Page with both text and image
          if (documents.length > 0) {
            const violationInput = {
              bundle: "test-bundle",
              documents: [
                {
                  ...documents[0],
                  pages: [
                    {
                      page: 1,
                      width: 100,
                      height: 100,
                      text: "text",
                      image: { mediaType: "image/jpeg" as const, base64: "QUJD" },
                    },
                    ...documents[0].pages.slice(1),
                  ],
                },
                ...documents.slice(1),
              ],
            };
            const violationResult = validateReaderInput(violationInput, intakeConfig);
            expect(violationResult.ok).toBe(false);
          }

          // 5. Page with neither text nor image
          if (documents.length > 0) {
            const violationInput = {
              bundle: "test-bundle",
              documents: [
                {
                  ...documents[0],
                  pages: [
                    {
                      page: 1,
                      width: 100,
                      height: 100,
                      text: null,
                      image: null,
                    },
                    ...documents[0].pages.slice(1),
                  ],
                },
                ...documents.slice(1),
              ],
            };
            const violationResult = validateReaderInput(violationInput, intakeConfig);
            expect(violationResult.ok).toBe(false);
          }

          // 6. requestBytes exceeds limit
          const violationResult = validateReaderInput(input, intakeConfig, intakeConfig.maxRequestBytes + 1);
          expect(violationResult.ok).toBe(false);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
