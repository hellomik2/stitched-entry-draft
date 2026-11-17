---
inclusion: always
---
# Pipeline contract
- src/rules/: pure 7501 math (no I/O). src/core/: pure, browser-safe pipeline (no node:* imports, no pdf.js import; pdf.js documents are passed in). src/node/: Node-only helpers (fs, pdf.js legacy build). src/app/: Next.js UI. scripts/: CLI scripts run with tsx. tools/hts-mcp/: the MCP server.
- Relative imports only. No path aliases such as "@/".
- Public entry points: src/rules/index.ts, src/core/index.ts, src/node/index.ts. Tests and the verification harness import only these.
- Data: samples/<bundle>/ (bundle.json, layout.json, reading.json, overrides-demo.json), data/hts/2026HTSRev23-subset.json, PDFs in public/samples/<bundle>/.
- Every draft value is copied (with a page source), computed (with inputs and a rule), entered by a person, or empty with a reason. Never guess, never choose an HTS number.
- Do not change files under samples/ or data/: they are handed over as-is.
