import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prepareUpload } from "./prepareFiles";

// Feature: document-intake, Requirement 45.1 and 45.6 (task 56.1): the upload takes an .xlsx and sends each sheet as a text page.

const FILES = join(process.cwd(), "samples", "upload-test", "files");
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("Requirement 45.1 and 45.6: prepareUpload with an Excel file", () => {
  it("accepts the Excel packing list and sends its sheet as a text page with no image", async () => {
    const bytes = readFileSync(join(FILES, "gloamwick-packing-list.xlsx"));
    const file = new File([bytes], "gloamwick-packing-list.xlsx", { type: XLSX });
    const r = await prepareUpload([{ file, kind: "packingList" }]);
    if (!r.ok) throw new Error(r.reason);
    const doc = r.value.input.documents[0];
    expect(doc.docId).toBe("packingList");
    expect(doc.kind).toBe("packingList");
    expect(doc.fileName).toBe("gloamwick-packing-list.xlsx");
    expect(doc.fileSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(doc.pages.length).toBe(1);
    expect(doc.pages[0].image).toBeNull();
    expect(doc.pages[0].text).toContain("Packing List No.: GPL-PL-1131");
    expect(doc.pages[0].width).toBe(600);
    expect(doc.pages[0].height).toBe(245);
    const page = r.value.textDocs[0].pages[0];
    expect(page.origin).toBe("sheet");
    expect(page.text).toBe(doc.pages[0].text);
    expect(page.items.find((i) => i.str === "437.4")?.cell).toBe("'Packing List'!G13");
    expect(r.value.views[0].pdf).toBeNull();
    expect(r.value.views[0].imageUrl).toBeNull();
    expect(r.value.views[0].pages).toEqual([{ page: 1, width: 600, height: 245, source: "text" }]);
  });

  it("accepts an .xlsx by its name when the browser gives no type", async () => {
    const bytes = readFileSync(join(FILES, "gloamwick-packing-list.xlsx"));
    const r = await prepareUpload([{ file: new File([bytes], "PL.XLSX", { type: "" }), kind: "packingList" }]);
    expect(r.ok).toBe(true);
  });

  it("passes on the reason of readXlsx for a damaged file", async () => {
    const r = await prepareUpload([{ file: new File([new Uint8Array([1, 2, 3, 4])], "broken.xlsx", { type: XLSX }), kind: "packingList" }]);
    expect(r).toEqual({ ok: false, reason: "broken.xlsx: could not read the Excel file." });
  });

  it("refuses .xls, .xlsm, .xlsb and .csv as documents with the new message", async () => {
    for (const name of ["old.xls", "macro.xlsm", "binary.xlsb", "list.csv", "notes.txt"]) {
      const r = await prepareUpload([{ file: new File([new Uint8Array([80, 75, 3, 4])], name, { type: "" }), kind: "invoice" }]);
      expect(r).toEqual({ ok: false, reason: `${name}: only PDF, JPEG, PNG and Excel (.xlsx) files are accepted.` });
    }
  });
});
