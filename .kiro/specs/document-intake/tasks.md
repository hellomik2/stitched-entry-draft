# Tasks: Document Intake Feature

## Project Setup and Configuration

- [x] 1. Steering and project file updates
  - [x] 1.1 Update `.kiro/steering/tech.md`: add section "Phase 2: Document Intake" noting that ONE paid AI reader is now in scope (`src/server/claudeReader.ts`), the API key is read only from the server environment and passed explicitly to the SDK, and tests never make network calls (injected fake client)
  - [x] 1.2 Update `.kiro/steering/pipeline.md`: document new `src/server/` (Node-only, never imported by 'use client' code) and `src/app/intake/` folders, `samples/upload-test/` test documents
  - [x] 1.3 Update `.kiro/steering/structure.md`: add `src/server/` and `src/app/intake/` to the structure diagram
  - [x] 1.4 Update `.gitignore`: add `logs/` to exclude cap and usage log files
  - [x] Run `npm run typecheck`

- [x] 2. Intake config and field catalog
  - [x] 2.1 Create `src/core/intakeConfig.ts` with all limits, prices (nano-USD tiers), and readerModel constant
  - [x] 2.2 Create `src/core/fieldCatalog.ts`: generate field list from `samples/lantern-hollow/reading.json` patterns (invoice header, lines 1–8, packing list header and lines, bill of lading header); each field has name and description; no tax identifier fields (Blocks 26, 27, EIN, SSN)
  - [x] 2.3 Create example test `src/core/fieldCatalog.test.ts`: verify every field in the sample reading is in the catalog; verify no catalog name matches known tax identifier patterns
  - [x] 2.4 Re-export both from `src/core/index.ts`
  - [x] Run `npm run typecheck` and `npx vitest --run src/core/fieldCatalog.test.ts`

- [x] 3. Transcript to page text with image origin
  - [x] 3.1 Add `origin?: "textLayer" | "imageTranscript"` to `PageText` type in `src/core/pdfText.ts` (existing pages are unchanged: origin absent means "textLayer")
  - [x] 3.2 Create `src/core/transcript.ts`: implement `transcriptToPageText(docId, page, width, height, lines)` converting page-relative 0..1 boxes to PDF points, clamping boxes inside the page, creating items with line-based IDs, joining lines with spaces for text, and setting `origin: "imageTranscript"`
  - [x] 3.3 Create property test `src/core/transcript.property.test.ts` **Property 1: Transcript Structure Preservation** (boxes inside page, items join back to text, empty lines dropped) using fast-check to generate random transcripts
  - [x] 3.4 Create property test `src/core/transcript.property.test.ts` **Property 28: Transcript Round-Trip** (a whole unique line as quote, value inside it, verification accepts with box inside page) using `verifyReadings` on composed text
  - [x] 3.5 Re-export `transcriptToPageText` from `src/core/index.ts`
  - [x] Run `npm run typecheck` and `npx vitest --run src/core/transcript.property.test.ts`

- [x] 4. Confidence and image origin through pipeline
  - [x] 4.1 Update `FieldReading` type in `src/core/reading.ts` to include `confidence?: "high" | "low"` and update `validateReadingAnswer` to accept and validate it
  - [x] 4.2 Add `"low_confidence"` to `RejectReason` type and update `verifyReadings` to add a new first check: if `confidence === "low"`, reject with reason `"low_confidence"` and message "The reader marked this value as uncertain."
  - [x] 4.3 Add optional `origin?: "imageTranscript"` to accepted `VerifiedReading` returned by `verifyReadings`; set only when the page's `origin` is `"imageTranscript"`
  - [x] 4.4 Update `DocSource` in `src/core/draft.ts` to include optional `origin?: "imageTranscript"`; update `docSource` helper to copy `origin` from reading when present
  - [x] 4.5 Update `formatSource` in `src/core/csv.ts` to append " (read from an image by the AI reader)" to the output only when `origin === "imageTranscript"`
  - [x] 4.6 Create property test `src/core/reading.property.test.ts` **Property 2: Confidence Always Rejects Low** (any `confidence: "low"` is rejected `low_confidence` and never becomes a copied value)
  - [x] 4.7 Create property test `src/core/reading.property.test.ts` **Property 3: Absent Confidence Treated as Passed** (no confidence field is not a rejection reason)
  - [x] 4.8 Create property test `src/core/draft.property.test.ts` **Property 4: Every Copied Value Has Source** (every accepted reading becomes a copied value with doc, page, box)
  - [x] 4.9 Create property test `src/core/csv.property.test.ts` **Property 5: Image-Origin Sources Labelled Distinctly** (only sources with `origin === "imageTranscript"` append the image label)
  - [x] 4.10 Create property test `src/core/csv.property.test.ts` **Property 6: Image-Origin Sources Only for Image Pages** (text-layer sources never have origin set)
  - [x] 4.11 Create example test `src/core/csv.test.ts` that runs the sample bundle through the entire pipeline (sample reading, verifyReadings, buildDraft, draftToCsv) and verifies the CSV output is byte-identical to today's CSV
  - Note: the byte-identical sample CSV is checked in `src/core/csv.test.ts` ("stable CSV output for lantern-hollow").
  - [x] Run `npm run typecheck` and `npx vitest --run src/core/reading.property.test.ts src/core/draft.property.test.ts src/core/csv.property.test.ts src/core/csv.test.ts`

- [x] 5. Reader contract (input/output shapes and validation)
  - [x] 5.1 Create `src/core/readerContract.ts`: define `ReaderPage`, `ReaderDocument`, `ReaderInput`, `TranscriptLine`, `TranscriptPage`, `ReaderOutput` types
  - [x] 5.2 Implement `validateReaderInput(json, limits)` checking shape, document kinds, file counts, page counts, total request size; return NeedsReview with plain message on failure
  - [x] 5.3 Implement `validateReaderOutput(json, input)` checking shape, field names against fieldCatalog, docs and pages referenced exist, image pages have transcripts with boxes in 0..1 range; return NeedsReview on failure
  - [x] 5.4 Implement `readerOutputToAnswer(input, output)` composing a `ReadingAnswer` (schemaVersion 1, bundle, documents, fields from output)
  - [x] 5.5 Implement `composeDocumentTexts(textLayerDocs, input, output)` merging text-layer pages from `textLayerDocs` with image-page transcripts from `output`; for image pages call `transcriptToPageText` to create `PageText` with `origin: "imageTranscript"`
  - [x] 5.6 Create property test `src/core/readerContract.property.test.ts` **Property 25: Prepare Upload Validation Errors** (any input that violates a limit is rejected before upload; never partial success)
  - [x] 5.7 Create example test `src/core/readerContract.test.ts` validating typical valid and invalid `ReaderInput` and `ReaderOutput` examples (correct shape, field out of catalog, page not found, transcript with box outside 0..1, etc.)
  - [x] 5.8 Create example test `src/core/readerContract.test.ts` for `composeDocumentTexts` with a mix of text and image pages
  - [x] 5.9 Re-export contract functions from `src/core/index.ts`
  - [x] Run `npm run typecheck` and `npx vitest --run src/core/readerContract.property.test.ts src/core/readerContract.test.ts`

- [x] 6. Budget (caps, state, cost estimation)
  - [x] 6.1 Create `src/core/budget.ts`: define `UsageState`, `Caps`, `UsageRecord` types
  - [x] 6.2 Implement `decideCall(state, caps, nowIso, visitorKey)` checking total, daily, and per-visitor daily caps; return `{ allowed: true; next: new state; remaining }` or `{ allowed: false; reason }` without mutating input
  - [x] 6.3 Implement `remainingCalls(state, caps, nowIso, visitorKey)` computing estimated calls left before any cap would refuse
  - [x] 6.4 Implement `estimateCostNanoUsd(inputTokens, outputTokens, prices)` using exact integer nano-USD arithmetic (no rounding): input * (tokens > tier ? overRate : rate) + output * rate; additivity within same tier
  - [x] 6.5 Implement `formatUsd(nanoUsd)` formatting nano-USD as dollars with 6 decimal places
  - [x] 6.6 Create property test `src/core/budget.property.test.ts` **Property 7: Cap Enforcement Never Exceeds Limit** (sequence of decisions never exceeds any cap)
  - [x] 6.7 Create property test `src/core/budget.property.test.ts` **Property 8: Cap Counters Equal Allowed Calls** (count of allowed decisions equals state increments)
  - [x] 6.8 Create property test `src/core/budget.property.test.ts` **Property 9: Cap State Not Mutated** (input state is never mutated)
  - [x] 6.9 Create property test `src/core/budget.property.test.ts` **Property 10: Remaining Calls Never Negative** (remainingCalls is 0 exactly when next call would be refused)
  - [x] 6.10 Create property test `src/core/budget.property.test.ts` **Property 11: Cost Estimate Zero Cost for Zero Tokens** (zero tokens yield zero cost)
  - [x] 6.11 Create property test `src/core/budget.property.test.ts` **Property 12: Cost Estimate Monotonic in Tokens** (higher tokens never lower cost)
  - [x] 6.12 Create property test `src/core/budget.property.test.ts` **Property 13: Cost Estimate Additive Within Tier** (sum of individual costs equals combined cost within same tier)
  - [x] 6.13 Re-export budget functions from `src/core/index.ts`
  - [x] Run `npm run typecheck` and `npx vitest --run src/core/budget.property.test.ts`

- [x] 7. Server setup: environment, visitor key, usage store
  - [x] 7.1 Create `src/server/readerEnv.ts`: implement `resolveReaderSetup(env)` following Requirement 7.1 mode logic exactly (kill switch wins, then fake, then claude with key and store, else off); parse caps from env; return setup with mode, reason, caps, store, visitorSalt, apiKey (never logged)
  - [x] 7.2 Create property test `src/server/readerEnv.property.test.ts` **Property 13: Resolver Mode Respects Kill Switch** (kill switch always wins)
  - [x] 7.3 Create property test `src/server/readerEnv.property.test.ts` **Property 14: Resolver Mode Fake Needs No Key** (fake mode without key)
  - [x] 7.4 Create property test `src/server/readerEnv.property.test.ts` **Property 15: Resolver Mode Claude Needs Key and Store** (claude mode requires both)
  - [x] 7.5 Create property test `src/server/readerEnv.property.test.ts` **Property 16: Resolver Provides Reason When Off** (reason string explains why off)
  - [x] 7.6 Create `src/server/visitorKey.ts`: implement `visitorKey(ip, salt, dayUtc)` computing SHA-256(salt + dayUtc + ip) hex, or "unknown" if salt or ip missing; implement `extractVisitorIp(request)` from x-forwarded-for or x-nf-client-connection-ip
  - [x] 7.7 Create property test `src/server/visitorKey.property.test.ts` **Property 17: Visitor Key Day-Specific** (keys for different days differ)
  - [x] 7.8 Create property test `src/server/visitorKey.property.test.ts` **Property 18: Visitor Key Missing Salt Fallback** (no salt means "unknown")
  - Note: the Property 17 and 18 tests live in `src/server/visitorKey.test.ts`.
  - [x] 7.9 Create `src/server/usageStore.ts`: define `UsageStore` interface (readState, writeState, appendRecord); implement `createFileUsageStore(dir)` reading/writing `caps.json` and appending `usage.jsonl`; implement `createMemoryUsageStore()` for tests
  - [x] 7.10 Create example test `src/server/usageStore.test.ts` for file store using temp directory (read/write empty state, append records, persist across reads)
  - [x] Run `npm run typecheck` and `npx vitest --run src/server/readerEnv.property.test.ts src/server/visitorKey.property.test.ts src/server/usageStore.test.ts`

- [x] 8. Fake reader (test-only reader)
  - [x] 8.1 Create `src/server/fakeReader.ts`: implement `createFakeReader(recordings)` returning a reader-like object; implement lookup by sorted SHA-256 set; reject with "no recorded answer for these files" if not found; return zero tokens usage
  - [x] 8.2 Implement `loadRecordings(dir)` reading `.json` files from `${dir}/recordings/`
  - [x] 8.3 Create `Recording` type with name, filesSha256 (sorted), output
  - [x] 8.4 Create example test `src/server/fakeReader.test.ts`: known SHA-256 set returns recording, unknown set is rejected
  - [x] Run `npm run typecheck` and `npx vitest --run src/server/fakeReader.test.ts`

- [x] 9. Intake service and API routes
  - [x] 9.1 Create `src/server/intakeService.ts`: implement `handleReadRequest(deps)` following the orchestration steps exactly (mode off → 503, validate input, fake mode → fake reader with separate counter, claude mode → reserve state BEFORE model call, read caps, decide, record outcome, return 200/429/502)
  - [x] 9.2 Implement `handleStatusRequest(deps)` returning mode, reason, callsRemaining
  - [x] 9.3 Create `src/app/api/read/route.ts` (POST): read env, build deps, call `handleReadRequest`, return Response.json; add size check and reject oversized bodies
  - [x] 9.4 Create `src/app/api/reader-status/route.ts` (GET): read env, call `handleStatusRequest`, return Response.json
  - [x] 9.5 Create example test `src/server/intakeService.test.ts` using in-memory store and stub readers: test fake mode succeeds, off mode returns 503, limits rejection returns 400, cap exceeded returns 429, successful claude call reserves state before calling model
  - [x] 9.6 Property test in `src/server/intakeService.property.test.ts` **Property 23: Handle Read Request Reserves Before Call** (cap state written BEFORE reader, not called if write fails)
  - [x] 9.7 Property test in `src/server/intakeService.property.test.ts` **Property 24: Handle Read Request No Echo** (response never echoes request body in errors)
  - Note: Properties 23 and 24 are tested in `src/server/intakeService.test.ts`.
  - [x] Run `npm run typecheck` and `npx vitest --run src/server/intakeService.test.ts src/server/intakeService.property.test.ts`

- [x] 10. Browser file preparation
  - [x] 10.1 Create `src/app/intake/prepareFiles.ts`: implement `prepareUpload(files, limits)` validating file count, sizes, PDF page counts, total image pages, total request size before any upload
  - [x] 10.2 For each file: extract text with pdfjs or skip (for images), identify image-only PDF pages, render to canvas/ImageBitmap, downscale to maxImageLongSide, encode as JPEG base64, compute SHA-256 of original bytes
  - [x] 10.3 Build `ReaderInput` with `ReaderDocument[]` and `ReaderPage[]` (each page is either text or image, never both)
  - [x] 10.4 Return input, textLayerDocs, views for board drawing
  - [x] 10.5 All errors are plain messages thrown before any request
  - [x] 10.6 Create example test `src/app/intake/prepareFiles.test.ts` validating rejection of oversized files, too many PDFs, too many images, and acceptable file (no real network, no persist)
  - [x] Run `npm run typecheck` and `npx vitest --run src/app/intake/prepareFiles.test.ts`

- [x] 11. Upload panel UI component
  - [x] 11.1 Create `src/app/intake/UploadPanel.tsx` (React client component): file picker, kind selection per file, reader status fetched from `/api/reader-status` on open
  - [x] 11.2 Display security notice: "Do not upload real confidential documents. This demo sends page text and page images to an AI model and keeps nothing."
  - [x] 11.3 Show reader mode and calls remaining
  - [x] 11.4 On "Read documents" click: call `prepareUpload`, POST to `/api/read`, on success call `composeDocumentTexts`, `verifyReadings`, `buildDraft`, `draftToCsv`, call `onSuccess` with bundle data
  - [x] 11.5 On error: display plain message, keep sample visible, allow retry

- [x] 12. StitchBoard upload mode
  - [x] 12.1 Update `src/app/StitchBoard.tsx` to add `source` state (`{ kind: "sample" } | { kind: "upload"; views; answer; documentTexts; title }`)
  - [x] 12.2 Add "Upload documents" button or link in title bar (visible when sample bundle is shown)
  - [x] 12.3 Render `UploadPanel` in documents pane; on success, switch to upload mode
  - [x] 12.4 In upload mode: tabs per document, draw image pages by rendering image on canvas at page size times scale (like PDF pages)
  - [x] 12.5 Add "Back to sample" button/tab to return to sample bundle
  - [x] 12.6 In fake mode, display label "Test mode: recorded answers, no AI call"
  - [x] 12.7 CSV file name: "uploaded-7501-draft.csv" for upload bundles (sample unchanged)
  - [x] 12.8 Sample bundle flow unchanged: three tabs, entering 480 in line 004 Column 36A gives duty 28.80, CSV is unchanged

- [x] 13. (maintainer) Test documents and recordings
  - [x] 13.1 Create fictitious test documents under `samples/upload-test/`: at least one text PDF, one scanned PDF (image only), one photo (JPEG or PNG)
  - [x] 13.2 Mark all documents `DEMO / FICTITIOUS` visibly on every page; use invented companies, people, addresses (no real names or trademarks)
  - [x] 13.3 Use HTS numbers from the shipped 33-row table only
  - [x] 13.4 Create pre-recorded `recordings/*.json` files with exact file SHA-256 sets matched to `ReaderOutput` for the test documents
  - [x] 13.5 Run end-to-end check in fake mode: upload, read, board displays threads to boxes on a text page and an image page, "Needs review" list populates correctly, CSV downloads as "uploaded-7501-draft.csv"
  - [x] 13.6 Verify existing sample checks: first screen loads sample automatically, entering 480 as line 004 Column 36A gives duty 28.80 and Needs review 21→17, CSV download matches today's byte-for-byte

- [x] 14. Claude reader (real AI integration)
  - [x] 14.1 Update `package.json`: add `@anthropic-ai/sdk` dependency (official SDK)
  - [x] 14.2 (maintainer) Run `npm install`
  - [x] 14.3 Create `src/server/claudeReader.ts`: implement `createClaudeReader({ apiKey, client? })` creating SDK client with `maxRetries: 0`; accept injected `client` for tests
  - [x] 14.4 Implement `read(input)` constructing messages (text block for text pages, text + image block for image pages), calling `messages.create` with `model: "claude-haiku-5-5"`, `max_tokens: 16000`, `output_config.format.json_schema` with required properties, `system` prompt instructing: copy values exactly, quote is contiguous text containing value, for image pages first write transcripts line by line, set confidence "low" if unsure, leave field out if not on documents, never choose/correct HTS numbers, never return tax identifiers
  - [x] 14.5 Check `stop_reason === "end_turn"` ; if not (refusal, max_tokens), reject with plain message
  - [x] 14.6 Parse JSON response, validate with `validateReaderOutput`; return output and usage; return usage even on validation failure
  - [x] 14.7 Map SDK errors (AuthenticationError, RateLimitError, APIError) to plain user-facing messages
  - [x] 14.8 Create example test `src/server/claudeReader.test.ts` with injected fake client (no network calls): mock message creation, test end_turn success, test refusal rejection, test max_tokens rejection, test SDK error mapping
  - [x] Run `npm run typecheck` and `npx vitest --run src/server/claudeReader.test.ts`

- [x] 15. Wire Claude reader into read route
  - [x] 15.1 Update `src/app/api/read/route.ts`: when mode is "claude", pass the real reader created from Claude into `handleReadRequest`
  - [x] 15.2 Verify tests still pass and no network calls are made (injected fake client)
  - [x] Run `npm run typecheck` and `npx vitest --run`

- [x] 16. (maintainer) Checkpoint: typecheck, tests, build, confirm sample unchanged
  - [x] 16.1 With no `DOCUMENT_INTAKE_ANTHROPIC_KEY` set, `/api/reader-status` returns mode "off" and reason "no API key"
  - [x] 16.2 Run `npm run typecheck`
  - [x] 16.3 Run `npx vitest --run` (all tests pass, no network)
  - [x] 16.4 Run `npm run build` (Next.js build completes)
  - [x] 16.5 Run sample bundle checks: first screen shows sample, 480 in line 004 gives duty 28.80, CSV unchanged
  - [x] 16.6 All feature requirements met except NICE items

## NICE (Optional) Features

- [x] 17. Durable cap store on Netlify Blobs
  - [x] 17.1 Create `src/server/usageStoreBlobs.ts` implementing `UsageStore` on Netlify Blobs (`@netlify/blobs` 10.7.13, store `document-intake-usage`, strong reads, conditional writes so concurrent requests cannot exceed a cap; no extra environment variable, Netlify provides the Blobs context)
  - [x] 17.2 Update `readerEnv.ts`: `DOCUMENT_INTAKE_STORE=netlify-blobs` selects it, with public-site cap defaults from `intakeConfig.caps.publicSite` (500 total, 30 per UTC day, 3 per visitor); both routes create it
  - [x] 17.3 Tests: `src/server/usageStoreBlobs.test.ts` (Property 29) and Property 30 in `src/server/readerEnv.property.test.ts`
  - _Requirements: 11.5_

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
  - Note: lines that are not on the documents no longer produce empty 7501 lines (task 22); the 8-line limit itself stays.
  - [ ] 21.4 Update HTS table to full public tariff (not just 33-row subset); update fieldCatalog for fields 1–N lines
  - [ ] _Requirements: None (scope expansion)_

---

- [x] 22. Draft builder fixes found with the upload test documents
  - [x] 22.1 An invoice line with no reading gets no 7501 line (a 3-line invoice gives 3 lines, not 8); a line whose readings were all rejected still gets one
  - [x] 22.2 The packing-list quantity check uses lines whose item number and quantity were accepted, so a rejected gross weight no longer reads as "the packing list says 0 PCS"
  - [x] 22.3 Property 31 (draft lines only for invoice lines on the documents) and Property 32 (gross weight does not change the quantity check) in `src/core/draft.test.ts`
  - _Requirements: 5.1, 6.1_

- [x] 23. Board shows every page of an uploaded PDF
  - [x] 23.1 Page navigation ("Page n of m", previous and next) for documents with more than one page; one-page documents and the sample unchanged
  - [x] 23.2 Readings, boxes and threads for the current page; clicking a value opens the page its source is on
  - _Requirements: 4, 13.4_

- [x] 24. Size and cost limit for one reader call
  - [x] 24.1 `intakeConfig`: `perCall` (maxPageTextChars 15000, maxTotalTextChars 60000, maxImageBase64Chars 1500000, imageTokensPerPage 5000, promptOverheadTokens 10000, maxCallCostNanoUsd 10800000), readerMaxOutputTokens 8000, readerTimeoutMs 45000, krwPerUsd 1500, costKrw 20000 (local) and 10000 (publicSite)
  - [x] 24.2 `validateReaderInput` size limits; `estimateReaderCall` in `budget.ts`
  - [x] 24.3 `UsageState.reservedCostNanoUsd`, cost option and "cost_cap" in `decideCall` and `remainingCalls`
  - [x] 24.4 `readerEnv`: `costCapNanoUsd`, `DOCUMENT_INTAKE_COST_CAP_KRW`
  - [x] 24.5 `intakeService`: 413 before any store access; reserve the worst case with the call; cost cap message
  - [x] 24.6 Property 33 and Property 34 tests
  - _Requirements: 17_
- [x] 25. Values read from images are confirmed by a person
  - [x] 25.1 `buildDraft`: image-origin copied values become needsReview; confirming the shown value returns them to copied with the note "Confirmed by a person against the page."
  - [x] 25.2 StitchBoard "Confirm this value" button
  - [x] 25.3 Property 35 test
  - _Requirements: 18_
- [x] 26. Invoice lines checked against the invoice
  - [x] 26.1 `invoiceLineCount` in schema, prompt, contract, reading answer and board
  - [x] 26.2 `CHK.INVOICE` in `buildDraft`
  - [x] 26.3 Property 36 test
  - _Requirements: 19_
- [x] 27. Every accepted value points to its place
  - [x] 27.1 `verifyReadings` box fallback and "no_source_box"
  - [x] 27.2 Property 37 test
  - _Requirements: 20_
- [x] 28. Time limit for the reader call and no document text in errors
  - [x] 28.1 45-second timeout, timeout message, `max_tokens` 8000
  - [x] 28.2 Validation reasons without model strings; doc id enum in the schema
  - [x] 28.3 Property 38 test
  - _Requirements: 21, 22_
- [x] 29. Upgrade `pdfjs-dist` to 6.2.108
  - [x] 29.1 Update `package.json` and the lock file; type check, tests, build, sample and upload checks
  - _Requirements: 12.5_

- [x] 30. A cap reservation counts only when the store confirms it
  - [x] 30.1 `writeState` requires `modified: true` and a non-empty `etag`
  - [x] 30.2 Property 39 test
  - _Requirements: 23_
- [x] 31. Byte-based worst case and the actual cost in the ledger
  - [x] 31.1 `utf8Bytes`, `perPageOverheadTokens` and the byte-based `estimateReaderCall`
  - [x] 31.2 `addReservedCost` and the true-up after the call in `intakeService`
  - [x] 31.3 Property 40 and Property 41 tests
  - _Requirements: 24_
- [x] 32. The app's own key and the Anthropic address
  - [x] 32.1 `readerEnv`: key from `DOCUMENT_INTAKE_ANTHROPIC_KEY` only
  - [x] 32.2 `createAnthropicClient` with fixed `baseURL`, `maxRetries: 0`, `logLevel: "off"`, `openTelemetry: false`
  - [x] 32.3 Steering `tech.md` names the new variable
  - [x] 32.4 Property 42 test
  - _Requirements: 25_
- [x] 33. Values computed from image readings wait for a person
  - [x] 33.1 `IMAGE_COMPUTED_REVIEW_REASON`, confirm back to "computed", waiting pass after `recomputeTotals`
  - [x] 33.2 Board confirm button for both image reasons
  - [x] 33.3 Property 35 test updated; Property 43 test
  - _Requirements: 26_
- [x] 34. Missing amounts, currency and gross weight go to a person
  - [x] 34.1 36A currency and amount cases; 34A without a total gross weight
  - [x] 34.2 Property 44 test
  - _Requirements: 27_
- [x] 35. (maintainer) Verifier items for the cross-check fixes; reproduction scripts fail before and pass after
  - [x] 35.1 Verifier: new items for Requirements 23 to 27; existing items use `DOCUMENT_INTAKE_ANTHROPIC_KEY`; the off-mode screen check accepts "no API key" and "no durable usage store configured"
  - _Requirements: 23, 24, 25, 26, 27_

- [x] 36. Small guards on requests, CSV cells and day counts
  - [x] 36.1 `readRequestRefusal` in `src/server/requestGuard.ts`, used first in the read route
  - [x] 36.2 `escapeCsvCell` puts ' in front of formula characters
  - [x] 36.3 `decideCall` keeps the previous, current and next UTC day
  - [x] 36.4 Property 45 test
  - _Requirements: 28_

- [x] 37. The reader's answer fits in one call
  - [x] 37.1 `intakeConfig` (`readerMaxOutputTokens` 16000, `readerMinOutputTokens` 8000) and the output room in `estimateReaderCall`; `buildReaderRequest` sends it as `max_tokens`
  - [x] 37.2 `buildReaderRequest`: `thinking: { type: "disabled" }`, `{ t, b }` transcript lines in the schema and the system prompt, the JSON on one line; `createClaudeReader` converts `{ t, b }` before validation
  - [x] 37.3 Property 46 test; tests that expected 8,000 follow Requirement 29.4
  - _Requirements: 29_
- [x] 38. A value computed again after a person's edit still waits
  - [x] 38.1 A test that fails on the current code: all-image sample, edit only L001.33A, L001.35 must wait
  - [x] 38.2 `draft.ts`: the pass of Requirement 30.1 after `recomputeTotals`
  - [x] 38.3 Property 47 test
  - _Requirements: 30_
- [x] 39. (maintainer) Verifier items for Requirements 29 and 30; the checks that expected 8,000 output tokens expect the output room
  - _Requirements: 29, 30_

- [x] 40. An edited HTS number derives the line's quantity by the first rule
  - [x] 40.1 Tests that fail on the current code: L003.33A edited keeps the difference, L001.33A to 7013.99.3500 gives 216 No., a person's 35 and a unit change; Property 48 test
  - [x] 40.2 `draft.ts`: one `deriveNetQuantity` for the first build and the rebuild after a 33A edit; remove the two old 35 copies
  - _Requirements: 31_
- [x] 41. A value that cannot be computed from what the draft has now waits
  - [x] 41.1 Tests that fail on the current code: no invoice line, a refused 36A, a rate that is not simple, the currency, total gross weight or unit from an image page; Property 49 test
  - [x] 41.2 `draft.ts`: B39 and B41 with no 7501 line, 38 by its first rule in `recomputeTotals`, image readings added to the sources of 36A, 34A and 35
  - _Requirements: 32_
- [x] 42. Property 2 test does the same checks in less time
  - [x] 42.1 `reading.property.test.ts` Property 2: verify the unchanged answer once per run instead of once per field; the same 100 runs, checks and time limit
  - _Requirements: 14_
- [x] 43. (maintainer) Verifier items for Requirements 31 and 32; reproduction scripts fail before and pass after
  - _Requirements: 31, 32_

- [x] 44. A quantity that was not read is not zero
  - [x] 44.1 Tests that fail on the current code: packing list line 5 quantity rejected, a packing list item number rejected, no packing list line for an item, invoice line 8 quantity or unit rejected, 34A with a packing list quantity rejected; Property 50 test
  - [x] 44.2 `draft.ts`: not fully read packing list lines in the quantity check of 35 and `P3.qty`, 35 waits when an invoice quantity or unit was not read, the 34A packing list map without the quantity
  - _Requirements: 33_

- [x] 45. (maintainer) Verifier item for Requirement 33; the real read of a test bundle (recorded answer) reproduces before and passes after
  - _Requirements: 33_

- [x] 46. A value that repeats on the page, a date in the asked form and a quote over two lines are checked against the page
  - [x] 46.1 Tests that fail on the current code: the repeated invoice cells and packing list counts, the two dates and a dotted date, the two-line address; Property 51 and 52 tests
  - [x] 46.2 `reading.ts`: whole-word occurrences, the row of the line's anchor, the date reader, stacked lines and the ", " at a row change
  - _Requirements: 34, 35_
- [x] 47. A value the reader was not sure of is shown, not used
  - [x] 47.1 Tests that fail on the current code: low readings that pass the checks are "uncertain", B8 to B15 with the new reason and the confirm button, the 34A, 35 and 10 reasons; Property 53 test
  - [x] 47.2 `reading.ts` status "uncertain"; `draft.ts` reasons and header fields; `StitchBoard.tsx` dashed boxes, the list and the confirm button
  - _Requirements: 36_
- [x] 48. One bad transcript line does not throw away the answer
  - [x] 48.1 Tests that fail on the current code: a bad "b" of one line keeps the answer, the line's value is rejected with "no_source_box", other values are accepted; Property 54 test
  - [x] 48.2 `claudeReader.ts` answer parsing, `readerContract.ts`, `transcript.ts`, `reading.ts`
  - _Requirements: 37_
- [x] 49. A draft value waits for what was not read, with the right reason
  - [x] 49.1 Tests that fail on the current code: B10 with missing origins and after person values, 33A not read, a refused 33A, the 34A rules; Property 55 test
  - [x] 49.2 `draft.ts`: one B10 function, the 33A, 35 and 37A reasons, 35 and 37A after a refused 33A, the 34A order
  - _Requirements: 38_
- [x] 50. (maintainer) Verifier items for Requirements 34 to 38; the recorded real answer of bundle A replayed before and after
  - _Requirements: 34, 35, 36, 37, 38_
- [x] 51. A box on a photo or scan shows the AI reader's estimated place
  - [x] 51.1 Tests that fail on the current code: `lineText` on readings from image pages and none on text pages
  - [x] 51.2 `reading.ts` `lineText`; `StitchBoard.tsx` dashed boxes with `data-approx`, the "AI estimate" label, the note above an image page, the transcript line in the source strip
  - _Requirements: 39_

- [x] 52. A weight or package count with thousands commas is read
  - [x] 52.1 Tests that fail on the current code: weights and package counts with thousands commas, misplaced commas, the draft checks and 34A of the sample with weights over 1,000 kg; Property 56 test
  - [x] 52.2 `parse.ts`: `parseKgToTenths` and `parsePackages` read thousands commas; `draft.ts`: the local comma helper is no longer needed
  - _Requirements: 40_

- [x] 53. A paid call always leaves a usage record, the cost top-up waits and tries again, and a store error is judged by its status
  - [x] 53.1 Tests that fail on the current code: a refused record write (403, real library with a fake fetch), token counts that are not integers, top-up after conflicts with waits, a 503 with an ETag on the conditional PUT; the existing top-up tests that expect 3 tries follow Requirement 42.1; Property 57 and 58 tests
  - [x] 53.2 `usageStoreBlobs.ts`: `appendRecord` checks the result, `dropEtagOnError`, `getStore` gets the `fetch`; `usageStore.ts`: `UsageStateConflictError`; `intakeService.ts`: the record log line, the record cost for counts that are not integers, top-up tries with waits (`ReadDeps.sleep`)
  - _Requirements: 41, 42_

- [x] 54. The "AI estimate" label does not cover the page text
  - [x] 54.1 `StitchBoard.tsx` and `globals.css`: the label beside the box with `data-label-side`
  - _Requirements: 43_

- [x] 55. A CSV number keeps its sign, and Block 9 waits without a container number
  - [x] 55.1 Tests that fail on the current code: plain numbers without the quote, "+5V adapter" and "=HYPERLINK(...)" with it, all through `draftToCsv`; Property 59; B9 when the container number is removed, rejected or not sure
  - [x] 55.2 `csv.ts`: the plain-number exception; `draft.ts`: the B9 rule
  - _Requirements: 44_

- [x] 56. An Excel document is read with cell addresses
  - [x] 56.1 Tests that fail on the current code: an .xlsx is accepted by the upload; texts and addresses of a test packing list; number formats; hidden sheets, rows and columns; limits and hostile files; Property 60; Property 61; a reading on a sheet page carries its cell; the CSV source and the source strip show it
  - [x] 56.2 `src/core/sheet.ts` (`readXlsx`, `sheetToPageText`), `prepareFiles.ts`, `reading.ts` (cell on a reading), `draft.ts` (cell on a source), `csv.ts`, `StitchBoard.tsx` (sheet page drawing, cell in the source strip); `fflate` (MIT) for unzipping
  - _Requirements: 45_

- [x] 57. A customer parts list gives the HTS number, origin and MID
  - [x] 57.1 Tests that fail on the current code: header row and column names; exact match only; 33A from the list, the same and different; not in the list; two rows; an unusable number; origin cases; B13; Property 62; Property 63; the parts-list test bundle end to end with its recorded answer
  - [x] 57.2 `src/core/partsList.ts`, `draft.ts`, `UploadPanel.tsx`, `StitchBoard.tsx`, `public/templates/customer-parts-list.csv`, the test bundle in `samples/upload-test/`
  - _Requirements: 46_

- [x] 58. (maintainer) Verifier items for Requirements 45 and 46; the board flow with the parts-list test bundle
  - _Requirements: 45, 46_

- [x] 59. Port codes and the mode of transport from the CBP code tables
  - [x] 59.1 Tests that fail on the current code: `lookupUsPort` and `lookupForeignPort` cases; Property 64; B20, B6 and B19 for one, several and no rows; Property 65; B9 for 10, 11 and the waits; a code table source in the CSV
  - [x] 59.2 `src/core/codeTables.ts`, `draft.ts` (B6, B9, B19, B20, candidates, the code table source), `csv.ts`, `index.ts`
  - _Requirements: 47_

- [x] 60. Block 13 MID suggested by the Appendix 2 rule
  - [x] 60.1 Tests that fail on the current code: the 13 official examples, the short name, street and city examples of Appendix 2, `splitIssuerAddress`, Property 66, Property 67, B13 in the sample, a single origin, several origins, a generic prefix, textiles, the parts list MID first
  - [x] 60.2 `src/core/mid.ts`, `draft.ts` (B13), `index.ts`
  - _Requirements: 48_

- [x] 61. The board: candidate buttons, code table sources, back to sample, sheet width
  - [x] 61.1 Board checks that fail on the current code: candidate buttons, the code table source line, the bill of lading after "Back to sample", the right edge of a sheet page
  - [x] 61.2 `StitchBoard.tsx`
  - _Requirements: 47.8, 47.9, 49_

- [x] 62. (maintainer) The two code tables extracted from the CBP PDFs; verifier items for Requirements 47 to 49; the sample's expected drafts, Needs review counts and CSV fingerprint updated
  - _Requirements: 47, 48, 49_

- [x] 63. A value read from an image line that is not in the transcript waits for a person
  - [x] 63.1 Tests that fail on the current code: the bundle C recording through `verifyReadings` (57 uncertain with no box, 1 rejected with value_not_in_quote, 5 accepted), Property 68, Property 69, the bundle C draft (values with the unplaced reasons, confirming, the same values as with boxes), Property 70, low confidence with no box, the CSV source
  - [x] 63.2 `src/core/reading.ts`, `draft.ts`, `csv.ts`, `index.ts`
  - _Requirements: 50.1 to 50.5, 50.7_

- [x] 64. The reader writes the transcripts first and counts the packing list lines
  - [x] 64.1 Tests that fail on the current code: the schema order, the prompt paragraphs, `packingListLineCount` in the validator, the answer and the reading answer, the check "P3.packing.lines"
  - [x] 64.2 `src/server/claudeReader.ts`, `src/core/readerContract.ts`, `reading.ts`, `draft.ts`, `StitchBoard.tsx`
  - _Requirements: 51_

- [x] 65. Every country name and code, and the printed date forms, reach the draft
  - [x] 65.1 Tests that fail on the current code: `countryCode` for names and codes, Property 71, `parseDocumentDate`, B14, B15 and L<nnn>.10 for an accepted "Germany", "12-NOV-2026" and an unknown origin
  - [x] 65.2 `src/core/parse.ts`, `reading.ts`, `draft.ts`
  - _Requirements: 52_

- [x] 66. The board: no box for a value outside the transcript, and the page above the lists
  - [x] 66.1 Board checks that fail on the current code: the bundle C upload with its recorded answer (the uncertain list, no box, the source strip, Confirm this value), the page image in view above the lists
  - [x] 66.2 `StitchBoard.tsx`
  - _Requirements: 50.6, 53_

- [x] 67. (maintainer) The ISO 3166-1 table; the bundle C recording in the app; verifier items for Requirements 50 to 53; the recorded answers of bundles A, B and C replayed before and after
  - _Requirements: 50, 51, 52, 53_

- [x] 68. A value put into a line the reader transcribed without it is rejected
  - [x] 68.1 Tests that fail on the current code: the sample bundle with every page an image page (line 7 origin rejected with quote_not_found and today's message, every other reading accepted), Property 72, a value at the start or the end of its quote still waits; the two older examples of 50.9 follow 50.1
  - [x] 68.2 `src/core/reading.ts`
  - _Requirements: 50.8, 50.9_

- [x] 69. A usage record is written without a condition, and the store writes after the reader stop in time
  - [x] 69.1 Tests that fail on the current code: `appendRecord` writes without a condition and counts `modified: true` as saved; through the installed library a record saved and then answered 503 or cut, or answered 200 without an ETag, leaves one record and no line; Property 73; the record before the top-up; a store that does not answer after the reader gives the answer within the post-read time with the lines; Property 74; the older tests of Requirement 41.1 and Property 57 follow 54.1 and 56.1
  - [x] 69.2 `src/server/usageStoreBlobs.ts`, `intakeService.ts`, `src/core/intakeConfig.ts` (`postReadStoreMs`, `readerContextWindowTokens`)
  - _Requirements: 54, 55_

- [x] 70. A usage the call cannot have, and an answer without usage, are recorded at the reserved worst case
  - [x] 70.1 Tests that fail on the current code: the counts of 56.1 on the three outcomes (no top-up, the next request answered), the largest usage the call can have, Property 75; `createClaudeReader` with no `usage`, `usage: null`, `content` that is not a list, a null answer, a valid answer without usage
  - [x] 70.2 `src/server/intakeService.ts`, `claudeReader.ts`, `readerTypes.ts`
  - _Requirements: 56_

- [x] 71. The Chapter 99 reason says "See" once
  - [x] 71.1 Tests that fail on the current code: the `chapter99Reason` examples, the sample's L005.ch99 reason, Property 76, the sample CSV fingerprints
  - [x] 71.2 `src/core/draft.ts`, `index.ts`
  - _Requirements: 57_

- [x] 72. (maintainer) Verifier items for Requirements 54 to 57 with the cross-check 3 reproductions; the CBP Form 7501 (11/26) page check in the steering; the recorded answers of bundles A, B and C replayed before and after
  - _Requirements: 54, 55, 56, 57_

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
22. Draft builder fixes found with the upload test documents
23. Board shows every page of an uploaded PDF
24. Size and cost limit for one reader call
25. Values read from images are confirmed by a person
26. Invoice lines checked against the invoice
27. Every accepted value points to its place
28. Time limit for the reader call and no document text in errors
29. Upgrade `pdfjs-dist` to 6.2.108
30. A cap reservation counts only when the store confirms it
31. Byte-based worst case and the actual cost in the ledger
32. The app's own key and the Anthropic address
33. Values computed from image readings wait for a person
34. Missing amounts, currency and gross weight go to a person
35. (maintainer) Verifier items for the cross-check fixes; reproduction scripts fail before and pass after
36. Small guards on requests, CSV cells and day counts
37. The reader's answer fits in one call
38. A value computed again after a person's edit still waits
39. (maintainer) Verifier items for Requirements 29 and 30; the checks that expected 8,000 output tokens expect the output room
40. An edited HTS number derives the line's quantity by the first rule
41. A value that cannot be computed from what the draft has now waits
42. Property 2 test does the same checks in less time
43. (maintainer) Verifier items for Requirements 31 and 32; reproduction scripts fail before and pass after
44. A quantity that was not read is not zero
45. (maintainer) Verifier item for Requirement 33; the real read of a test bundle (recorded answer) reproduces before and passes after
46. A value that repeats on the page, a date in the asked form and a quote over two lines are checked against the page
47. A value the reader was not sure of is shown, not used
48. One bad transcript line does not throw away the answer
49. A draft value waits for what was not read, with the right reason
50. (maintainer) Verifier items for Requirements 34 to 38; the recorded real answer of bundle A replayed before and after
51. A box on a photo or scan shows the AI reader's estimated place
52. A weight or package count with thousands commas is read
53. A paid call always leaves a usage record, the cost top-up waits and tries again, and a store error is judged by its status
54. The "AI estimate" label does not cover the page text
55. A CSV number keeps its sign, and Block 9 waits without a container number
56. An Excel document is read with cell addresses
57. A customer parts list gives the HTS number, origin and MID
58. (maintainer) Verifier items for Requirements 45 and 46; the board flow with the parts-list test bundle
59. Port codes and the mode of transport from the CBP code tables
60. Block 13 MID suggested by the Appendix 2 rule
61. The board: candidate buttons, code table sources, back to sample, sheet width
62. (maintainer) Code tables, verifier items and the sample's expected values
63. A value read from an image line that is not in the transcript waits for a person
64. The reader writes the transcripts first and counts the packing list lines
65. Every country name and code, and the printed date forms, reach the draft
66. The board: no box for a value outside the transcript, and the page above the lists
67. (maintainer) ISO table, bundle C recording, verifier items and replays
68. A value put into a line the reader transcribed without it is rejected
69. A usage record is written without a condition, and the store writes after the reader stop in time
70. A usage the call cannot have, and an answer without usage, are recorded at the reserved worst case
71. The Chapter 99 reason says "See" once
72. (maintainer) Verifier items, the CBP Form 7501 (11/26) page check and replays

**Total Sub-Tasks:** 212
