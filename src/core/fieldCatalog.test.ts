import { describe, it, expect } from "vitest";
import { FIELD_CATALOG, isCatalogField } from "./fieldCatalog";
import sampleReading from "../../samples/lantern-hollow/reading.json";

describe("Field Catalog", () => {
  it("should contain no duplicate field names", () => {
    const names = FIELD_CATALOG.map((f) => f.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("should have descriptions for all fields", () => {
    for (const field of FIELD_CATALOG) {
      expect(field.description).toBeTruthy();
      expect(typeof field.description).toBe("string");
      expect(field.description.length).toBeGreaterThan(0);
    }
  });

  it("should have no tax identifier patterns in names or descriptions", () => {
    const taxIdPattern = /\b(ein|ssn|tax\s?id|irs)\b/i;
    for (const field of FIELD_CATALOG) {
      expect(field.name).not.toMatch(taxIdPattern);
      expect(field.description).not.toMatch(taxIdPattern);
    }
  });

  it("should include all fields from the lantern-hollow sample reading", () => {
    const sampleFields = new Set(sampleReading.fields.map((f) => f.field));
    const catalogNames = new Set(FIELD_CATALOG.map((f) => f.name));

    for (const field of sampleFields) {
      expect(catalogNames.has(field)).toBe(true);
    }
  });

  it("isCatalogField should return true for valid catalog fields", () => {
    for (const field of FIELD_CATALOG) {
      expect(isCatalogField(field.name)).toBe(true);
    }
  });

  it("isCatalogField should return false for non-catalog fields", () => {
    expect(isCatalogField("invoice.nonexistent")).toBe(false);
    expect(isCatalogField("foo.bar")).toBe(false);
    expect(isCatalogField("")).toBe(false);
  });
});
