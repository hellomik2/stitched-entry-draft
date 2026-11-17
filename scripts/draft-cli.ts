#!/usr/bin/env tsx

import { mkdir, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBundleFromDisk } from "../src/node/index.js";
import type { Override, VerifiedReading, Draft } from "../src/core/index.js";
import { allFields } from "../src/core/index.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: tsx scripts/draft-cli.ts <bundle> <outDir> [overrides.json]");
    process.exit(1);
  }

  const bundle = args[0];
  const outDir = args[1];
  const overridesFile = args[2];

  // Read overrides if provided
  let overrides: Override[] = [];
  if (overridesFile) {
    const { readFileSync } = await import("node:fs");
    const overridesJson = JSON.parse(readFileSync(overridesFile, "utf-8"));
    if (overridesJson.overrides && Array.isArray(overridesJson.overrides)) {
      overrides = overridesJson.overrides;
    }
  }

  // Get the workspace root
  const root = process.cwd();

  try {
    // Create output directory
    mkdir(outDir, { recursive: true }, (err) => {
      if (err && err.code !== "EEXIST") {
        console.error("Failed to create output directory:", err);
        process.exit(1);
      }
    });

    // Run the bundle
    const result = await runBundleFromDisk(root, bundle, overrides);

    // Prepare document data for output
    const documentsOutput = result.documents.map((doc) => ({
      docId: doc.docId,
      kind: doc.kind,
      pages: doc.pages.map((page) => ({
        page: page.page,
        width: page.width,
        height: page.height,
        itemCount: page.items.length,
        textLength: page.text.length,
      })),
    }));

    // Write JSON outputs
    writeFileSync(
      join(outDir, "documents.json"),
      JSON.stringify(documentsOutput, null, 1) + "\n"
    );
    writeFileSync(
      join(outDir, "verified.json"),
      JSON.stringify(result.verified, null, 1) + "\n"
    );
    writeFileSync(
      join(outDir, "draft.json"),
      JSON.stringify(result.draft, null, 1) + "\n"
    );
    writeFileSync(join(outDir, "draft.csv"), result.csv);

    // Count field statuses over every field: header, lines and totals
    const statusCounts = {
      copied: 0,
      computed: 0,
      needsReview: 0,
      personInput: 0,
      personEdited: 0,
    };
    const fields = allFields(result.draft);
    for (const field of fields) {
      statusCounts[field.status]++;
    }

    // Print summary. "Needs review" and "person fills" are the same lists, under the same names, as on the screen.
    const readingsCount = result.verified.length;
    const linesCount = result.draft.lines.length;
    const summary = `Processed ${readingsCount} readings into ${linesCount} 7501 lines. ` +
      `Needs review ${result.draft.needsReview.length}, person fills ${result.draft.personInput.length}. ` +
      `All ${fields.length} fields: ${statusCounts.copied} copied, ${statusCounts.computed} computed, ` +
      `${statusCounts.needsReview} needs review, ${statusCounts.personInput} person fills, ` +
      `${statusCounts.personEdited} entered by a person.`;

    console.log(summary);
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
