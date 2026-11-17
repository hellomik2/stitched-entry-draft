# Tasks: Document Intake Feature

## Project Setup and Configuration

- [ ] 1. Steering and project file updates
  - [ ] 1.1 Update `.kiro/steering/tech.md`: add section "Phase 2: Document Intake" noting that ONE paid AI reader is now in scope (`src/server/claudeReader.ts`), the API key is read only from the server environment and passed explicitly to the SDK, and tests never make network calls (injected fake client)
  - [ ] 1.2 Update `.kiro/steering/pipeline.md`: document new `src/server/` (Node-only, never imported by 'use client' code) and `src/app/intake/` folders, `samples/upload-test/` test documents
  - [ ] 1.3 Update `.kiro/steering/structure.md`: add `src/server/` and `src/app/intake/` to the structure diagram
  - [ ] 1.4 Update `.gitignore`: add `logs/` to exclude cap and usage log files
  - [ ] Run `npm run typecheck`

- [ ] 2. Intake config and field catalog
  - [ ] 2.1 Create `src/core/intakeConfig.ts` with all limits, prices (nano-USD tiers), and readerModel constant
  - [ ] 2.2 Create `src/core/fieldCatalog.ts`: generate field list from `samples/lantern-hollow/reading.json` patterns (invoice header, lines 1–8, packing list header and lines, bill of lading header); each field has name and description; no tax identifier fields (Blocks 26, 27, EIN, SSN)
  - [ ] 2.3 Create example test `src/core/fieldCatalog.test.ts`: verify every field in the sample reading is in the catalog; verify no catalog name matches known tax identifier patterns
  - [ ] 2.4 Re-export both from `src/core/index.ts`
  - [ ] Run `npm run typecheck` and `npx vitest --run src/core/fieldCatalog.test.ts`

- [ ] 3. Transcript to page text with image origin
  - [ ] 3.1 Add `origin?: "textLayer" | "imageTranscript"` to `PageText` type in `src/core/pdfText.ts` (existing pages are unchanged: origin absent means "textLayer")
  - [ ] 3.2 Create `src/core/transcript.ts`: implement `transcriptToPageText(docId, page, width, height, lines)` converting page-relative 0..1 boxes to PDF points, clamping boxes inside the page, creating items with line-based IDs, joining lines with spaces for text, and setting `origin: "imageTranscript"`
  - [ ] 3.3 Create property test `src/core/transcript.property.test.ts` **Property 1: Transcript Structure Preservation** (boxes inside page, items join back to text, empty lines dropped) using fast-check to generate random transcripts
  - [ ] 3.4 Create property test `src/core/transcript.property.test.ts` **Property 28: Transcript Round-Trip** (a whole unique line as quote, value inside it, verification accepts with box inside page) using `verifyReadings` on composed text
  - [ ] 3.5 Re-export `transcriptToPageText` from `src/core/index.ts`
  - [ ] Run `npm run typecheck` and `npx vitest --run src/core/transcript.property.test.ts`

- [ ] 4. Confidence and image origin through pipeline
  - [ ] 4.1 Update `FieldReading` type in `src/core/reading.ts` to include `confidence?: "high" | "low"` and update `validateReadingAnswer` to accept and validate it
  - [ ] 4.2 Add `"low_confidence"` to `RejectReason` type and update `verifyReadings` to add a new first check: if `confidence === "low"`, reject with reason `"low_confidence"` and message "The reader marked this value as uncertain."
  - [ ] 4.3 Add optional `origin?: "imageTranscript"` to accepted `VerifiedReading` returned by `verifyReadings`; set only when the page's `origin` is `"imageTranscript"`
  - [ ] 4.4 Update `DocSource` in `src/core/draft.ts` to include optional `origin?: "imageTranscript"`; update `docSource` helper to copy `origin` from reading when present
  - [ ] 4.5 Update `formatSource` in `src/core/csv.ts` to append " (read from an image by the AI reader)" to the output only when `origin === "imageTranscript"`
  - [ ] 4.6 Create property test `src/core/reading.property.test.ts` **Property 2: Confidence Always Rejects Low** (any `confidence: "low"` is rejected `low_confidence` and never becomes a copied value)
  - [ ] 4.7 Create property test `src/core/reading.property.test.ts` **Property 3: Absent Confidence Treated as Passed** (no confidence field is not a rejection reason)
  - [ ] 4.8 Create property test `src/core/draft.property.test.ts` **Property 4: Every Copied Value Has Source** (every accepted reading becomes a copied value with doc, page, box)
  - [ ] 4.9 Create property test `src/core/csv.property.test.ts` **Property 5: Image-Origin Sources Labelled Distinctly** (only sources with `origin === "imageTranscript"` append the image label)
  - [ ] 4.10 Create property test `src/core/csv.property.test.ts` **Property 6: Image-Origin Sources Only for Image Pages** (text-layer sources never have origin set)
  - [ ] 4.11 Create example test `src/core/csv.test.ts` that runs the sample bundle through the entire pipeline (sample reading, verifyReadings, buildDraft, draftToCsv) and verifies the CSV output is byte-identical to today's CSV
  - [ ] Run `npm run typecheck` and `npx vitest --run src/core/reading.property.test.ts src/core/draft.property.test.ts src/core/csv.property.test.ts src/core/csv.test.ts`

- [ ] 5. Reader contract (input/output shapes and validation)
  - [ ] 5.1 Create `src/core/readerContract.ts`: define `ReaderPage`, `ReaderDocument`, `ReaderInput`, `TranscriptLine`, `TranscriptPage`, `ReaderOutput` types
  - [ ] 5.2 Implement `validateReaderInput(json, limits)` checking shape, document kinds, file counts, page counts, total request size; return NeedsReview with plain message on failure
  - [ ] 5.3 Implement `validateReaderOutput(json, input)` checking shape, field names against fieldCatalog, docs and pages referenced exist, image pages have transcripts with boxes in 0..1 range; return NeedsReview on failure
  - [ ] 5.4 Implement `readerOutputToAnswer(input, output)` composing a `ReadingAnswer` (schemaVersion 1, bundle, documents, fields from output)
  - [ ] 5.5 Implement `composeDocumentTexts(textLayerDocs, input, output)` merging text-layer pages from `textLayerDocs` with image-page transcripts from `output`; for image pages call `transcriptToPageText` to create `PageText` with `origin: "imageTranscript"`
  - [ ] 5.6 Create property test `src/core/readerContract.property.test.ts` **Property 25: Prepare Upload Validation Errors** (any input that violates a limit is rejected before upload; never partial success)
  - [ ] 5.7 Create example test `src/core/readerContract.test.ts` validating typical valid and invalid `ReaderInput` and `ReaderOutput` examples (correct shape, field out of catalog, page not found, transcript with box outside 0..1, etc.)
  - [ ] 5.8 Create example test `src/core/readerContract.test.ts` for `composeDocumentTexts` with a mix of text and image pages
  - [ ] 5.9 Re-export contract functions from `src/core/index.ts`
  - [ ] Run `npm run typecheck` and `npx vitest --run src/core/readerContract.property.test.ts src/core/readerContract.test.ts`

- [ ] 6. Budget (caps, state, cost estimation)
  - [ ] 6.1 Create `src/core/budget.ts`: define `UsageState`, `Caps`, `UsageRecord` types
  - [ ] 6.2 Implement `decideCall(state, caps, nowIso, visitorKey)` checking total, daily, and per-visitor daily caps; return `{ allowed: true; next: new state; remaining }` or `{ allowed: false; reason }` without mutating input
  - [ ] 6.3 Implement `remainingCalls(state, caps, nowIso, visitorKey)` computing estimated calls left before any cap would refuse
  - [ ] 6.4 Implement `estimateCostNanoUsd(inputTokens, outputTokens, prices)` using exact integer nano-USD arithmetic (no rounding): input * (tokens > tier ? overRate : rate) + output * rate; additivity within same tier
  - [ ] 6.5 Implement `formatUsd(nanoUsd)` formatting nano-USD as dollars with 6 decimal places
  - [ ] 6.6 Create property test `src/core/budget.property.test.ts` **Property 7: Cap Enforcement Never Exceeds Limit** (sequence of decisions never exceeds any cap)
  - [ ] 6.7 Create property test `src/core/budget.property.test.ts` **Property 8: Cap Counters Equal Allowed Calls** (count of allowed decisions equals state increments)
  - [ ] 6.8 Create property test `src/core/budget.property.test.ts` **Property 9: Cap State Not Mutated** (input state is never mutated)
  - [ ] 6.9 Create property test `src/core/budget.property.test.ts` **Property 10: Remaining Calls Never Negative** (remainingCalls is 0 exactly when next call would be refused)
  - [ ] 6.10 Create property test `src/core/budget.property.test.ts` **Property 11: Cost Estimate Zero Cost for Zero Tokens** (zero tokens yield zero cost)
  - [ ] 6.11 Create property test `src/core/budget.property.test.ts` **Property 12: Cost Estimate Monotonic in Tokens** (higher tokens never lower cost)
  - [ ] 6.12 Create property test `src/core/budget.property.test.ts` **Property 13: Cost Estimate Additive Within Tier** (sum of individual costs equals combined cost within same tier)
  - [ ] 6.13 Re-export budget functions from `src/core/index.ts`
  - [ ] Run `npm run typecheck` and `npx vitest --run src/core/budget.property.test.ts`

- [ ] 7. Server setup: environment, visitor key, usage store
  - [ ] 7.1 Create `src/server/readerEnv.ts`: implement `resolveReaderSetup(env)` following Requirement 7.1 mode logic exactly (kill switch wins, then fake, then claude with key and store, else off); parse caps from env; return setup with mode, reason, caps, store, visitorSalt, apiKey (never logged)
  - [ ] 7.2 Create property test `src/server/readerEnv.property.test.ts` **Property 13: Resolver Mode Respects Kill Switch** (kill switch always wins)
  - [ ] 7.3 Create property test `src/server/readerEnv.property.test.ts` **Property 14: Resolver Mode Fake Needs No Key** (fake mode without key)
  - [ ] 7.4 Create property test `src/server/readerEnv.property.test.ts` **Property 15: Resolver Mode Claude Needs Key and Store** (claude mode requires both)
  - [ ] 7.5 Create property test `src/server/readerEnv.property.test.ts` **Property 16: Resolver Provides Reason When Off** (reason string explains why off)
  - [ ] 7.6 Create `src/server/visitorKey.ts`: implement `visitorKey(ip, salt, dayUtc)` computing SHA-256(salt + dayUtc + ip) hex, or "unknown" if salt or ip missing; implement `extractVisitorIp(request)` from x-forwarded-for or x-nf-client-connection-ip
  - [ ] 7.7 Create property test `src/server/visitorKey.property.test.ts` **Property 17: Visitor Key Day-Specific** (keys for different days differ)
  - [ ] 7.8 Create property test `src/server/visitorKey.property.test.ts` **Property 18: Visitor Key Missing Salt Fallback** (no salt means "unknown")
  - [ ] 7.9 Create `src/server/usageStore.ts`: define `UsageStore` interface (readState, writeState, appendRecord); implement `createFileUsageStore(dir)` reading/writing `caps.json` and appending `usage.jsonl`; implement `createMemoryUsageStore()` for tests
  - [ ] 7.10 Create example test `src/server/usageStore.test.ts` for file store using temp directory (read/write empty state, append records, persist across reads)
  - [ ] Run `npm run typecheck` and `npx vitest --run src/server/readerEnv.property.test.ts src/server/visitorKey.property.test.ts src/server/usageStore.test.ts`

- [ ] 8. Fake reader (test-only reader)
  - [ ] 8.1 Create `src/server/fakeReader.ts`: implement `createFakeReader(recordings)` returning a reader-like object; implement lookup by sorted SHA-256 set; reject with "no recorded answer for these files" if not found; return zero tokens usage
  - [ ] 8.2 Implement `loadRecordings(dir)` reading `.json` files from `${dir}/recordings/`
  - [ ] 8.3 Create `Recording` type with name, filesSha256 (sorted), output
  - [ ] 8.4 Create example test `src/server/fakeReader.test.ts`: known SHA-256 set returns recording, unknown set is rejected
  - [ ] Run `npm run typecheck` and `npx vitest --run src/server/fakeReader.test.ts`

- [ ] 9. Intake service and API routes
  - [ ] 9.1 Create `src/server/intakeService.ts`: implement `handleReadRequest(deps)` following the orchestration steps exactly (mode off → 503, validate input, fake mode → fake reader with separate counter, claude mode → reserve state BEFORE model call, read caps, decide, record outcome, return 200/429/502)
  - [ ] 9.2 Implement `handleStatusRequest(deps)` returning mode, reason, callsRemaining
  - [ ] 9.3 Create `src/app/api/read/route.ts` (POST): read env, build deps, call `handleReadRequest`, return Response.json; add size check and reject oversized bodies
  - [ ] 9.4 Create `src/app/api/reader-status/route.ts` (GET): read env, call `handleStatusRequest`, return Response.json
  - [ ] 9.5 Create example test `src/server/intakeService.test.ts` using in-memory store and stub readers: test fake mode succeeds, off mode returns 503, limits rejection returns 400, cap exceeded returns 429, successful claude call reserves state before calling model
  - [ ] 9.6 Property test in `src/server/intakeService.property.test.ts` **Property 23: Handle Read Request Reserves Before Call** (cap state written BEFORE reader, not called if write fails)
  - [ ] 9.7 Property test in `src/server/intakeService.property.test.ts` **Property 24: Handle Read Request No Echo** (response never echoes request body in errors)
  - [ ] Run `npm run typecheck` and `npx vitest --run src/server/intakeService.test.ts src/server/intakeService.property.test.ts`

- [ ] 10. Browser file preparation
  - [ ] 10.1 Create `src/app/intake/prepareFiles.ts`: implement `prepareUpload(files, limits)` validating file count, sizes, PDF page counts, total image pages, total request size before any upload
  - [ ] 10.2 For each file: extract text with pdfjs or skip (for images), identify image-only PDF pages, render to canvas/ImageBitmap, downscale to maxImageLongSide, encode as JPEG base64, compute SHA-256 of original bytes
  - [ ] 10.3 Build `ReaderInput` with `ReaderDocument[]` and `ReaderPage[]` (each page is either text or image, never both)
  - [ ] 10.4 Return input, textLayerDocs, views for board drawing
  - [ ] 10.5 All errors are plain messages thrown before any request
  - [ ] 10.6 Create example test `src/app/intake/prepareFiles.test.ts` validating rejection of oversized files, too many PDFs, too many images, and acceptable file (no real network, no persist)
  - [ ] Run `npm run typecheck` and `npx vitest --run src/app/intake/prepareFiles.test.ts`

- [ ] 11. Upload panel UI component
  - [ ] 11.1 Create `src/app/intake/UploadPanel.tsx` (React client component): file picker, kind selection per file, reader status fetched from `/api/reader-status` on open
  - [ ] 11.2 Display security notice: "Do not upload real confidential documents. This demo sends page text and page images to an AI model and keeps nothing."
  - [ ] 11.3 Show reader mode and calls remaining
  - [ ] 11.4 On "Read documents" click: call `prepareUpload`, POST to `/api/read`, on success call `composeDocumentTexts`, `verifyReadings`, `buildDraft`, `draftToCsv`, call `onSuccess` with bundle data
  - [ ] 11.5 On error: display plain message, keep sample visible, allow retry

- [ ] 12. StitchBoard upload mode
  - [ ] 12.1 Update `src/app/StitchBoard.tsx` to add `source` state (`{ kind: "sample" } | { kind: "upload"; views; answer; documentTexts; title }`)
  - [ ] 12.2 Add "Upload documents" button or link in title bar (visible when sample bundle is shown)
  - [ ] 12.3 Render `UploadPanel` in documents pane; on success, switch to upload mode
  - [ ] 12.4 In upload mode: tabs per document, draw image pages by rendering image on canvas at page size times scale (like PDF pages)
  - [ ] 12.5 Add "Back to sample" button/tab to return to sample bundle
  - [ ] 12.6 In fake mode, display label "Test mode: recorded answers, no AI call"
  - [ ] 12.7 CSV file name: "uploaded-7501-draft.csv" for upload bundles (sample unchanged)
  - [ ] 12.8 Sample bundle flow unchanged: three tabs, entering 480 in line 004 Column 36A gives duty 28.80, CSV is unchanged

- [ ] 13. (maintainer) Test documents and recordings
  - [ ] 13.1 Create fictitious test documents under `samples/upload-test/`: at least one text PDF, one scanned PDF (image only), one photo (JPEG or PNG)
  - [ ] 13.2 Mark all documents `DEMO / FICTITIOUS` visibly on every page; use invented companies, people, addresses (no real names or trademarks)
  - [ ] 13.3 Use HTS numbers from the shipped 33-row table only
  - [ ] 13.4 Create pre-recorded `recordings/*.json` files with exact file SHA-256 sets matched to `ReaderOutput` for the test documents
  - [ ] 13.5 Run end-to-end check in fake mode: upload, read, board displays threads to boxes on a text page and an image page, "Needs review" list populates correctly, CSV downloads as "uploaded-7501-draft.csv"
  - [ ] 13.6 Verify existing sample checks: first screen loads sample automatically, entering 480 as line 004 Column 36A gives duty 28.80 and Needs review 21→17, CSV download matches today's byte-for-byte

- [ ] 14. Claude reader (real AI integration)
  - [ ] 14.1 Update `package.json`: add `@anthropic-ai/sdk` dependency (official SDK)
  - [ ] 14.2 (maintainer) Run `npm install`
  - [ ] 14.3 Create `src/server/claudeReader.ts`: implement `createClaudeReader({ apiKey, client? })` creating SDK client with `maxRetries: 0`; accept injected `client` for tests
  - [ ] 14.4 Implement `read(input)` constructing messages (text block for text pages, text + image block for image pages), calling `messages.create` with `model: "claude-haiku-5-5"`, `max_tokens: 16000`, `output_config.format.json_schema` with required properties, `system` prompt instructing: copy values exactly, quote is contiguous text containing value, for image pages first write transcripts line by line, set confidence "low" if unsure, leave field out if not on documents, never choose/correct HTS numbers, never return tax identifiers
  - [ ] 14.5 Check `stop_reason === "end_turn"` ; if not (refusal, max_tokens), reject with plain message
  - [ ] 14.6 Parse JSON response, validate with `validateReaderOutput`; return output and usage; return usage even on validation failure
  - [ ] 14.7 Map SDK errors (AuthenticationError, RateLimitError, APIError) to plain user-facing messages
  - [ ] 14.8 Create example test `src/server/claudeReader.test.ts` with injected fake client (no network calls): mock message creation, test end_turn success, test refusal rejection, test max_tokens rejection, test SDK error mapping
  - [ ] Run `npm run typecheck` and `npx vitest --run src/server/claudeReader.test.ts`

- [ ] 15. Wire Claude reader into read route
  - [ ] 15.1 Update `src/app/api/read/route.ts`: when mode is "claude", pass the real reader created from Claude into `handleReadRequest`
  - [ ] 15.2 Verify tests still pass and no network calls are made (injected fake client)
  - [ ] Run `npm run typecheck` and `npx vitest --run`

- [ ] 16. (maintainer) Checkpoint: typecheck, tests, build, confirm sample unchanged
  - [ ] 16.1 With no `ANTHROPIC_API_KEY` set, `/api/reader-status` returns mode "off" and reason "no API key"
  - [ ] 16.2 Run `npm run typecheck`
  - [ ] 16.3 Run `npx vitest --run` (all tests pass, no network)
  - [ ] 16.4 Run `npm run build` (Next.js build completes)
  - [ ] 16.5 Run sample bundle checks: first screen shows sample, 480 in line 004 gives duty 28.80, CSV unchanged
  - [ ] 16.6 All feature requirements met except NICE items

## NICE (Optional) Features

- [ ] 17. Durable cap store on Netlify Blobs
  - [ ] 17.1 Create `src/server/usageStoreNetlify.ts` implementing `UsageStore` using Netlify Blobs API (environment variable `NETLIFY_BLOBS_KEY`)
  - [ ] 17.2 Update `readerEnv.ts` to accept Netlify Blobs as a store option
  - [ ] _Requirements: 11.5_

- [ ] 18. Optional access code (pre-read gate)
  - [ ] 18.1 Add `accessCode?: string` to `intakeConfig` (optional, empty means disabled)
  - [ ] 18.2 Update `UploadPanel` to ask for access code before read (if configured)
  - [ ] 18.3 Validate code in `handleReadRequest` before allowing read
  - [ ] _Requirements: None (design decision)_

- [ ] 19. Reader suggests document kind
  - [ ] 19.1 Update `ReaderOutput` to include optional `suggestedKind` for each document
  - [ ] 19.2 Update `UploadPanel` to accept suggestion from output and update UI
  - [ ] _Requirements: None (nice-to-have for UX)_

- [ ] 20. Excel input (.xlsx) with cell-address sources
  - [ ] 20.1 Add XLSX file support in `prepareUpload` (library: `xlsx` or similar)
  - [ ] 20.2 Extract cell data and create `PageText` with cells as items; source becomes `CellSource` with cell address instead of box
  - [ ] 20.3 Update `formatSource` to handle cell sources
  - [ ] _Requirements: None (scope expansion)_

- [ ] 21. HEIC and rotated photos, more than 8 invoice lines, full HTS table
  - [ ] 21.1 Add HEIC support in `prepareUpload` (convert to JPEG on rendering)
  - [ ] 21.2 Auto-rotate JPEG/PNG based on EXIF before encoding
  - [ ] 21.3 Remove 8-line limit in draft builder (read all invoice lines)
  - [ ] 21.4 Update HTS table to full public tariff (not just 33-row subset); update fieldCatalog for fields 1–N lines
  - [ ] _Requirements: None (scope expansion)_

---

## Summary

**Top-Level Task Titles:**
1. Steering and project file updates
2. Intake config and field catalog
3. Transcript to page text with image origin
4. Confidence and image origin through pipeline
5. Reader contract (input/output shapes and validation)
6. Budget (caps, state, cost estimation)
7. Server setup: environment, visitor key, usage store
8. Fake reader (test-only reader)
9. Intake service and API routes
10. Browser file preparation
11. Upload panel UI component
12. StitchBoard upload mode
13. (maintainer) Test documents and recordings
14. Claude reader (real AI integration)
15. Wire Claude reader into read route
16. (maintainer) Checkpoint: typecheck, tests, build, confirm sample unchanged
17. Durable cap store on Netlify Blobs (NICE)
18. Optional access code (NICE)
19. Reader suggests document kind (NICE)
20. Excel input (.xlsx) with cell-address sources (NICE)
21. HEIC and rotated photos, more than 8 invoice lines, full HTS table (NICE)

**Total Sub-Tasks:** 138
