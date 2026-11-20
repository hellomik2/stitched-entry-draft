import { describe, it, expect } from "vitest";
import { readRequestRefusal } from "./requestGuard";
import * as fc from "fast-check";

function headers(obj: Record<string, string | undefined>): { get(name: string): string | null } {
  return {
    get: (n) => obj[n.toLowerCase()] ?? null,
  };
}

describe("Feature: document-intake, Property 45: Small Guards Hold (requests) (Validates: Requirements 28.1)", () => {
  describe("examples", () => {
    it('content-type "application/json" gives null', () => {
      const result = readRequestRefusal(headers({ "content-type": "application/json" }));
      expect(result).toBeNull();
    });

    it('content-type "application/json; charset=utf-8" gives null', () => {
      const result = readRequestRefusal(headers({ "content-type": "application/json; charset=utf-8" }));
      expect(result).toBeNull();
    });

    it('content-type "Application/JSON" gives null', () => {
      const result = readRequestRefusal(headers({ "content-type": "Application/JSON" }));
      expect(result).toBeNull();
    });

    it("missing content-type gives 415", () => {
      const result = readRequestRefusal(headers({}));
      expect(result).toEqual({ status: 415, message: "Send the documents as JSON." });
    });

    it('content-type "text/plain" gives 415', () => {
      const result = readRequestRefusal(headers({ "content-type": "text/plain" }));
      expect(result).toEqual({ status: 415, message: "Send the documents as JSON." });
    });

    it('content-type "application/x-www-form-urlencoded" gives 415', () => {
      const result = readRequestRefusal(headers({ "content-type": "application/x-www-form-urlencoded" }));
      expect(result).toEqual({ status: 415, message: "Send the documents as JSON." });
    });

    it('content-type "multipart/form-data; boundary=x" gives 415', () => {
      const result = readRequestRefusal(headers({ "content-type": "multipart/form-data; boundary=x" }));
      expect(result).toEqual({ status: 415, message: "Send the documents as JSON." });
    });

    it('JSON with sec-fetch-site "same-origin" gives null', () => {
      const result = readRequestRefusal(headers({ "content-type": "application/json", "sec-fetch-site": "same-origin" }));
      expect(result).toBeNull();
    });

    it('JSON with sec-fetch-site "none" gives null', () => {
      const result = readRequestRefusal(headers({ "content-type": "application/json", "sec-fetch-site": "none" }));
      expect(result).toBeNull();
    });

    it('JSON with sec-fetch-site "cross-site" gives 403', () => {
      const result = readRequestRefusal(headers({ "content-type": "application/json", "sec-fetch-site": "cross-site" }));
      expect(result).toEqual({ status: 403, message: "Requests from other sites are not accepted." });
    });

    it('JSON with sec-fetch-site "same-site" gives 403', () => {
      const result = readRequestRefusal(headers({ "content-type": "application/json", "sec-fetch-site": "same-site" }));
      expect(result).toEqual({ status: 403, message: "Requests from other sites are not accepted." });
    });
  });

  describe("property", () => {
    it("for content types whose part before semicolon trimmed and lowercased is not application/json, result has status 415", () => {
      fc.assert(
        fc.property(fc.string(), (contentType) => {
          const trimmed = contentType.split(";")[0].trim().toLowerCase();
          if (trimmed !== "application/json") {
            const result = readRequestRefusal(headers({ "content-type": contentType }));
            expect(result?.status).toBe(415);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
