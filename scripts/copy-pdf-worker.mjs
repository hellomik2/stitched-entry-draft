import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the pdfjs-dist package folder
const pdfJsDistPkg = require.resolve("pdfjs-dist/package.json");
const pdfJsDistDir = path.dirname(pdfJsDistPkg);

// Paths
const sourceWorker = path.join(pdfJsDistDir, "build/pdf.worker.min.mjs");
const sourceStandardFonts = path.join(pdfJsDistDir, "standard_fonts");
const publicDir = path.join(__dirname, "..", "public");
const destWorker = path.join(publicDir, "pdf.worker.min.mjs");
const destStandardFonts = path.join(publicDir, "standard_fonts");

// Create public directory if it doesn't exist
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Copy pdf.worker.min.mjs
if (fs.existsSync(sourceWorker)) {
  fs.copyFileSync(sourceWorker, destWorker);
  console.log(`✓ Copied pdf.worker.min.mjs to ${destWorker}`);
} else {
  console.error(`✗ Source file not found: ${sourceWorker}`);
  process.exit(1);
}

// Copy standard_fonts folder
if (fs.existsSync(sourceStandardFonts)) {
  fs.cpSync(sourceStandardFonts, destStandardFonts, { recursive: true, force: true });
  console.log(`✓ Copied standard_fonts to ${destStandardFonts}`);
} else {
  console.error(`✗ Source folder not found: ${sourceStandardFonts}`);
  process.exit(1);
}
