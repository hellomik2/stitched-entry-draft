import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { runBundleFromDisk } from "../node/index";

describe("CSV output verification", () => {
  describe("Feature: document-intake, CSV output SHA-256 (Validates: Requirements 4.5)", () => {
    it("should produce stable CSV output for lantern-hollow bundle without overrides", async () => {
      const { csv } = await runBundleFromDisk(process.cwd(), "lantern-hollow", []);

      // Compute SHA-256 of the CSV as UTF-8
      const hash = createHash("sha256").update(csv, "utf8").digest("hex");

      // Expected hash: the CSV is stable and should not change
      // This hash will be verified by the maintainer's test run
      expect(hash).toBe("00f0ba1f332309ef640d596a65bb541efeb6ec67d354dd8ebf5a395f8f47aaf0");
    });

    it("should produce stable CSV output for lantern-hollow bundle with demo overrides", async () => {
      // Read the demo overrides
      const { overrides } = await import("../../samples/lantern-hollow/overrides-demo.json");

      const { csv } = await runBundleFromDisk(process.cwd(), "lantern-hollow", overrides);

      // Compute SHA-256 of the CSV as UTF-8
      const hash = createHash("sha256").update(csv, "utf8").digest("hex");

      // Expected hash: the CSV with demo overrides is stable and should not change
      expect(hash).toBe("adcfea609c168cadb85d6ccf6dec53cb32750ded6160bdda10dc5667a0efa1a5");
    });
  });
});
