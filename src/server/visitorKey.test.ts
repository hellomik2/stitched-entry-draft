import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { visitorKey, clientIp } from "./visitorKey";

describe("Property 17: Visitor Key Day-Specific (11.3, 11.4)", () => {
  it("same ip and salt, two different days => different keys; same day => same key; key is 64 hex", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
        fc.ipV4(),
        fc.constantFrom("2026-11-18", "2026-11-19", "2026-11-20"),
        (salt, ip, day1) => {
          const day2 = day1 === "2026-11-20" ? "2026-11-18" : "2026-11-20";

          const key1 = visitorKey(ip, salt, day1);
          const key2 = visitorKey(ip, salt, day2);
          const key1Again = visitorKey(ip, salt, day1);

          // Different days => different keys
          expect(key1).not.toBe(key2);

          // Same day => same key
          expect(key1).toBe(key1Again);

          // Key is 64 hex characters
          expect(key1).toMatch(/^[0-9a-f]{64}$/);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("Property 18: Visitor Key Missing Salt Fallback (11.3)", () => {
  it("null or empty salt or ip => unknown", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(""),
          fc.ipV4(),
        ),
        fc.oneof(
          fc.constant(null),
          fc.constant(""),
          fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
        ),
        (ip, salt) => {
          const key = visitorKey(ip, salt, "2026-11-18");

          if (!ip || ip.length === 0 || !salt || salt.length === 0) {
            expect(key).toBe("unknown");
          } else {
            expect(key).toMatch(/^[0-9a-f]{64}$/);
            expect(key).not.toBe("unknown");
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("clientIp example tests", () => {
  it("clientIp with x-forwarded-for gives first entry", () => {
    const headers = {
      get: (name: string) => {
        if (name === "x-forwarded-for") {
          return "203.0.113.5, 10.0.0.1";
        }
        return null;
      },
    };

    expect(clientIp(headers)).toBe("203.0.113.5");
  });

  it("clientIp with only x-nf-client-connection-ip gives that value", () => {
    const headers = {
      get: (name: string) => {
        if (name === "x-nf-client-connection-ip") {
          return "203.0.113.6";
        }
        return null;
      },
    };

    expect(clientIp(headers)).toBe("203.0.113.6");
  });

  it("clientIp with neither header gives null", () => {
    const headers = {
      get: () => null,
    };

    expect(clientIp(headers)).toBeNull();
  });

  it("clientIp with both headers prefers x-nf-client-connection-ip", () => {
    const headers = {
      get: (name: string) => {
        if (name === "x-forwarded-for") {
          return "198.51.100.9, 203.0.113.5";
        }
        if (name === "x-nf-client-connection-ip") {
          return "203.0.113.5";
        }
        return null;
      },
    };

    expect(clientIp(headers)).toBe("203.0.113.5");
  });
});
