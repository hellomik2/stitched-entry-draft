# Document Intake Requirements

## Introduction

This feature adds the missing front door to the 7501 draft helper: a person uploads their own shipping documents (commercial invoice, packing list, bill of lading), an AI reader reads them, and the result flows into the existing pipeline (`verifyReadings` → `buildDraft` → review lists → `draftToCsv`), displayed on the same board (StitchBoard). The sample bundle remains the first screen and continues to work exactly as today. Document intake replaces today's hand-coded `frozenReader` with support for real document uploads and real or fake AI reading. Files are processed in the browser; only page text, page images, file metadata, and SHA-256 hashes are sent to the server. Nothing the person uploads is written to disk or retained after the response.

## Glossary

- **Uploaded Document**: A file (PDF or image) chosen by a person, assigned a document kind (invoice, packing list, or bill of lading), and ready for reading.
- **Text Page**: A PDF page that contains a text layer extractable by `extractDocumentText`, or an image page that has been converted to text.
- **Image Page**: A PDF page with no or negligible text layer, or a standalone image file (JPEG, PNG). Rendered as an image and passed to the AI reader or transcript library.
- **Transcript**: The output of AI reading for image pages: an array of items, each with text, a bounding box in page-relative coordinates (0..1), and optional confidence. Transcripts are converted to the same `PageText` structure used for text pages so that quotes and threads work identically for both.
- **Reader Input**: The standardized input shape passed to a reader: `bundle` ID, and per document: `docId`, document `kind` (invoice, packing list, or billOfLading), original file SHA-256, and pages (each with page number, width, height in pixels, and either extracted text or a rendered image).
- **Reader Output**: The standardized output shape returned by a reader: the existing `ReadingAnswer` shape (`field`, `value`, `quote`, `doc`, `page`) plus per-field `confidence` ("high" or "low") and per-image-page `transcript` (items with text and box in page-relative 0..1 coordinates).
- **Real Reader**: The AI reader that calls the Claude Haiku 5.5 model via the Anthropic SDK, used on the public site when `DOCUMENT_INTAKE_ANTHROPIC_KEY` is set and the kill switch is not off.
- **Fake Reader**: A test-only reader that looks up pre-recorded answers by exact file SHA-256 set; refuses any other file set with "no recorded answer".
- **Recording**: A pre-recorded JSON file pairing a set of file SHA-256 values to a complete `ReadingAnswer`.
- **Reader Mode**: The server mode controlling which reader is active: "off" (sample bundle only; no AI calls), "fake" (recorded answers for testing; visible "Test mode" label on the board), or "claude" (real AI reader; active only if `DOCUMENT_INTAKE_ANTHROPIC_KEY` is set).
- **Kill Switch**: An environment variable `DOCUMENT_INTAKE_KILL_SWITCH` that, when set to any value, turns the AI reader off entirely; the sample bundle keeps working.
- **Usage Record**: One JSON-Lines entry logged per AI call: timestamp (ISO), model name, input/output token counts, estimated cost in USD, file SHA-256 values, reader mode, and outcome (success/error). Never includes document text, images, the API key, or visitor IP.
- **Cap**: A limit on AI reader calls. Types: total (default 300 for dev), daily (default 30 per UTC day for public, 0 = no limit), daily-per-visitor (default 3, identified by salted hash of IP; public site only), and public-total (500 for the public site).
- **Visitor Key**: A salted SHA-256 hash of the visitor's IP address, used only for counting daily calls per visitor on the public site. The salt is a random string generated at server startup; the IP is never logged.
- **File Fingerprint**: SHA-256 hash of a file's raw bytes, computed in the browser before upload. Sent to the server for usage tracking, cap counting, and recording matching. Never transmitted without the file or as a standalone identifier.
- **Test Mode**: The visible label "Test mode: recorded answers, no AI call" shown on the board when the reader mode is "fake".

---

## Requirements

### Requirement 1 (MUST): File Input and Validation

**User Story:** As an Entry Writer, I want to pick files (PDF or image), assign each one a document kind, and have them validated before any processing, so that invalid or oversized files are refused with a plain message before reaching the server.

#### Acceptance Criteria

1. WHEN a person opens the "Upload documents" control in the StitchBoard title bar, THE app SHALL display an upload panel in the documents pane with (a) a file picker accepting PDF (`.pdf`), JPEG (`.jpg`, `.jpeg`), and PNG (`.png`) files; (b) per-file kind selection: "Invoice", "Packing list", or "Bill of lading"; (c) the reader status line showing mode and calls available; and (d) a notice: "Do not upload real confidential documents. This demo sends page text and page images to an AI model and keeps nothing."
2. WHEN a person selects a file, THE app SHALL validate the file before offering upload: (a) filetype must be PDF, JPEG, or PNG; (b) file size must not exceed `maxFileSize` (configuration default 10 MB); (c) for PDFs, the page count must not exceed `maxPdfPages` (default 4); (d) the number of files must not exceed `maxUploadFiles` (default 3); and (e) the total number of image pages (JPEG, PNG, and images from PDF pages without text layers) must not exceed `maxImagePages` (default 6).
3. WHEN any file fails validation, THE app SHALL refuse the file and display a plain message: for example "PDF too large (11 MB, max 10 MB)" or "JPEG photo exceeds max image pages (7, max 6)".
4. IF a PDF has mixed pages (some with text layers, some without), THE app SHALL count only the image pages against `maxImagePages`.
5. ALL limits (filetype, file size, page counts) SHALL be stored in ONE shared configuration module (not environment variables), so the browser and server use identical limits. Only the reader mode, kill switch, store, caps, salt, and API key come from server environment variables.
6. THE app SHALL NOT send files to the server or cache them in the browser until all validations pass and the person clicks "Read documents".

---

### Requirement 2 (MUST): Browser-Side Document Processing

**User Story:** As an Entry Writer, I want documents processed in my browser before any upload, so that my files never leave my machine until the server sees only sanitized page data.

#### Acceptance Criteria

1. WHEN a person clicks "Read documents" for a valid file set, THE app SHALL (a) extract page text from each PDF using `extractDocumentText` (existing); (b) for each PDF page with no or negligible text, render it as an image, downscale to `max(width, height) ≤ 1600` pixels while maintaining aspect ratio, and encode as JPEG; (c) for JPEG and PNG files, render them as images and downscale identically; (d) compute SHA-256 of each original file (before extraction or rendering).
2. WHEN all pages are processed, THE app SHALL display progress: a count of pages processed or a progress bar. If processing fails (e.g. PDF read error), THE app SHALL show a plain error message and stop.
3. THE app SHALL NOT store original files or rendered images on disk or in localStorage after processing. Images are held in memory only, for transmission to the server.
4. FOR each page, THE app SHALL prepare the Reader Input shape: page number, width, height in pixels, and one of (a) `text: string` (from `extractDocumentText`) or (b) `image: Uint8Array` (JPEG, downscaled, base64-encoded for JSON transmission).

---

### Requirement 3 (MUST): Reader Input and Output Contracts

**User Story:** As a developer, I want a single reader boundary defined by input and output shapes, so that real readers (AI) and fake readers (recorded) implement the same interface and tests can inject fake clients.

#### Acceptance Criteria

1. THE app SHALL define `ReaderInput` as a TypeScript type: `{ bundle: string; documents: Array<{ docId: string; kind: DocKind; fileSha256: string; pages: Array<{ pageNumber: number; width: number; height: number; text?: string; imageBase64?: string }> }> }`.
2. THE app SHALL define `ReaderOutput` as `ReadingAnswer` (existing type) plus per-field `confidence: "high" | "low"` and per-image-page `transcript: Array<{ text: string; box: { x: number; y: number; width: number; height: number } }>` where box coordinates are in page-relative 0..1 range.
3. A reader (real or fake) SHALL accept a `ReaderInput`, perform reading or lookup, and return a `Promise<ReaderOutput>`. If reading fails or the fake reader has no matching recording, THE reader SHALL return a rejection with a plain message (e.g. "no recorded answer for these files").
4. THE app SHALL export a reader interface `DocumentReader` with a `name: string` property (for logging) and a `read(input: ReaderInput): Promise<ReaderOutput>` method.
5. EVERY reader implementation (real or fake) SHALL be a separate module exporting a `DocumentReader` factory function or instance, never hardcoded in the main pipeline.

---

### Requirement 4 (MUST): Source Traceability for Image Pages

**User Story:** As a reviewer, I want to click a thread from a value to see exactly where it came from—whether a text page or an image page—so that I can verify the AI reading without trusting the quote alone.

#### Acceptance Criteria

1. FOR image pages, THE transcript SHALL be converted to a `PageText` structure (via a new helper function `transcriptToPageText`) identical in shape to text-page `PageText`: items with id, text, box in PDF points (converted from page-relative 0..1 to absolute page-point coordinates), plus spans linking text positions to items. Each page's source (text layer or transcript) is recorded as "textLayer" or "imageTranscript".
2. BEFORE verification, transcripts of image pages are converted to `PageText` structures so that the existing `verifyReadings` function runs unchanged on the combined document texts, treating image-page text identically to text-layer text.
3. WHEN a reading comes from an image page (where the page's source is "imageTranscript"), THE source in the draft SHALL be labelled "read from an image by the AI reader" in the StitchBoard source strip and in the CSV source column. Sources from text-layer pages are printed exactly as today, preserving byte-identical CSV output for the sample bundle.
4. THE existing `verifyReadings` function does NOT change. Quote validation, box extraction, and rejection logic work identically on combined text.

---

### Requirement 5 (MUST): Confidence and Validation Rules

**User Story:** As an Entry Writer, I want readings flagged as low-confidence or unverifiable, so that I know when to check the page myself instead of trusting the AI.

#### Acceptance Criteria

1. WHEN a reader returns a field with `confidence: "low"`, the draft builder SHALL reject the reading with `reason: "low_confidence"` (a new `RejectReason` value). (Replaced by Requirement 36.1: a low reading that passes every other check is "uncertain".)
2. THE existing `RejectReason` values and their use remain unchanged: `unknown_document`, `page_out_of_range`, `value_missing`, `empty_quote`, `quote_not_found`, `quote_not_unique`, `value_not_in_quote`. Readings rejected for any of these reasons go to "Needs review" with the existing message text.
3. A reading whose `confidence` field is missing (undefined or null, as in the sample `reading.json`) is treated as having passed confidence (confidence is not a rejection reason).
4. IF a reading is rejected for any reason (including `low_confidence`), THE reading SHALL NOT become a copied value in the draft; instead it SHALL go to "Needs review" with the reason shown, exactly like today.
5. THE reader (AI) SHALL NEVER return an HTS number that it does not find printed on the document. It SHALL copy the printed number only, and the existing HTS lookup (`lookupHts`) SHALL decide whether that number is in the shipped table.
6. THE reader SHALL NEVER return or attempt to read tax identifiers: 7501 Blocks 26 and 27 (EIN, SSN), or any field that a real customs declaration would never display in a commercial invoice, packing list, or bill of lading.

---

### Requirement 6 (MUST): Field Scope and Line Limits

**User Story:** As an Entry Writer, I want to know the draft reads invoices with up to 8 lines and uses a known HTS table subset, so that I understand what the tool can and cannot do.

#### Acceptance Criteria

1. THE draft builder SHALL read and process invoice lines 1 through 8 only (existing behavior). Any lines beyond 8 are ignored by the draft builder; the reader may return them but they are not used.
2. THE HTS lookup SHALL use only the shipped table `data/hts/2026HTSRev23-subset.json` (33 rows, existing). Any HTS number not in that table SHALL be flagged "needs review: HTS number not in shipped table" in the draft.
3. THE reader SHALL copy whatever HTS number appears on the invoice, without choosing or correcting it. The shipped table check is performed downstream, not by the reader.
4. THE draft field names, labels, and structure SHALL match the sample `samples/lantern-hollow/reading.json` exactly (existing).

---

### Requirement 7 (MUST): Reader Modes and Server-Side Control

**User Story:** As a developer, I want to control which reader is active (off, fake, or real AI) via environment variables only, so that the demo stays off in the browser and the public site never accidentally calls the AI.

#### Acceptance Criteria

1. THE server (Next.js route handler) SHALL determine reader mode based on environment variables, in this order:
   - IF `DOCUMENT_INTAKE_KILL_SWITCH` is set to a non-empty value, mode is "off".
   - ELSE IF `DOCUMENT_INTAKE_MODE` equals "fake", mode is "fake" (no key needed, no AI call).
   - ELSE IF `DOCUMENT_INTAKE_ANTHROPIC_KEY` is set AND a durable usage store is configured (`DOCUMENT_INTAKE_STORE` is "file" for local use; other stores are NICE), mode is "claude".
   - ELSE mode is "off".
2. THE `DOCUMENT_INTAKE_ANTHROPIC_KEY` SHALL be read only on the server, passed explicitly to the Anthropic SDK client, never logged, never echoed in responses, and never written to any file.
3. THE kill switch environment variable `DOCUMENT_INTAKE_KILL_SWITCH` SHALL accept any non-empty value to turn off the AI reader. The sample bundle keeps working.
4. THE server SHALL expose a `/api/reader-status` endpoint returning `{ mode: "off" | "fake" | "claude"; callsRemaining: number | null; reason: string | null }` where `reason` is a short plain message when mode is "off" (for example "no API key", "kill switch is on", "no durable usage store configured") and null otherwise.

---

### Requirement 8 (MUST): Real Reader — Claude Haiku 5.5

**User Story:** As an Entry Writer on the public site, I want the AI reader to call Claude and return a complete reading, so that I do not have to type invoice data manually.

#### Acceptance Criteria

1. THE real reader SHALL use the Anthropic SDK to call `claude-haiku-5-5` (Claude Haiku 5.5) with the Reader Input encoded as JSON, including page images as base64. THE real reader SHALL create the SDK client with the key passed explicitly and automatic retries turned off (max retries 0).
2. THE system prompt SHALL instruct the model to read the documents, extract field values (following the field names in `samples/lantern-hollow/reading.json`), and return a `ReadingAnswer` JSON with `confidence` ("high" or "low") and `transcript` per image page.
3. FOR each page image, THE model SHALL return a `transcript` array with items containing `text` (a span of recognized text), `box: { x, y, width, height }` in page-relative 0..1 coordinates, and optionally `confidence: "high" | "low"`.
4. THE reader SHALL validate the model response as valid JSON and a valid `ReadingAnswer` shape before returning it. If validation fails, THE reader SHALL return a rejection (not throw).
5. THE reader SHALL handle API errors (rate limits, timeouts, invalid key) and return a rejection with a plain message suitable for display to the user (e.g. "API error: rate limit; try again in a few minutes").
6. WHEN the model stops for any reason other than a normal end of turn (for example a refusal or the output token limit), THE reader SHALL return a rejection with a plain message.

---

### Requirement 9 (MUST): Fake Reader for Testing

**User Story:** As a developer, I want a fake reader for local testing and CI, so that tests do not call the real AI and can inject exact answers.

#### Acceptance Criteria

1. THE fake reader SHALL accept a `ReaderInput` and look up the exact set of file SHA-256 values in a pre-recorded `Recording`. If the set matches, THE fake reader SHALL return the recorded `ReadingAnswer`; otherwise, it SHALL return a rejection "no recorded answer for these files".
2. THE fake reader SHALL NEVER read or parse document content; it matches only on file hashes.
3. A `Recording` SHALL be a JSON file with shape `{ filesSha256: string[]; answer: ReadingAnswer }` where `filesSha256` is sorted alphabetically.
4. THE fake reader SHALL be activated only when the server environment variable `DOCUMENT_INTAKE_MODE` is explicitly set to `"fake"`.
5. WHEN the fake reader is active, THE StitchBoard SHALL display a visible label: "Test mode: recorded answers, no AI call" in the title bar or documents pane.

---

### Requirement 10 (MUST): Usage Logging and Cost Tracking

**User Story:** As an operator, I want to log every AI call with tokens and cost, so that I can monitor usage and predict bills without exposing secrets.

#### Acceptance Criteria

1. WHEN an AI reader call completes (success or failure), THE server SHALL log one JSON-Lines entry to `logs/usage.jsonl` (or an environment-specified path) with fields:
   - `timestamp` (ISO 8601)
   - `model` ("claude-haiku-5-5")
   - `inputTokens` (integer or null if call failed before getting a response)
   - `outputTokens` (integer or null if call failed)
   - `estimatedCostUsd` (computed from tokens and configured per-million-token prices, or null)
   - `filesSha256` (array of file hashes, sorted)
   - `readerMode` ("claude", "fake", or "off")
   - `outcome` ("success", "error", "cap-exceeded", or "kill-switch")
   - `errorMessage` (string or null)
2. THE logging SHALL NEVER include: original file content, rendered images, the API key, visitor IP address (use salted hash for caps only), or user identifiers.
3. THE per-token costs SHALL be configuration values with source and date: Claude Haiku 5.5 default `0.10 USD` per million input tokens, `0.50 USD` per million output tokens, for prompts up to 100K tokens. These defaults SHALL be overridable via environment or config file.
4. THE cap state is reserved and written BEFORE the model is called; if that write fails, the call is refused and the model is not called (fail closed). If only the usage record write fails AFTER a successful call, the draft is still returned and the error is written to the server log without document content.

---

### Requirement 11 (MUST): Reader Call Caps

**User Story:** As an operator, I want to set global and per-visitor limits on AI calls, so that runaway traffic or abuse does not incur unexpected costs.

#### Acceptance Criteria

1. THE server SHALL enforce three configurable caps on AI reader calls:
   - **Total cap** (configuration, default 300 for development, 500 for public site): cumulative calls allowed; persists across server restarts in a durable store.
   - **Daily cap per UTC day** (configuration, default 0 meaning no limit; 30 for public site): calls allowed per UTC day, reset at 00:00 UTC.
   - **Per-visitor daily cap** (configuration, default 3): calls allowed per visitor per UTC day.
2. THE server SHALL check caps BEFORE calling the model. If any cap would be exceeded, THE server SHALL refuse the call and return `{ outcome: "cap-exceeded"; reason: "daily cap reached" }` or similar (not an error).
3. THE visitor key (for per-visitor daily caps) SHALL be `SHA-256(SALT + UTC_day + IP)` where SALT comes from the environment variable `DOCUMENT_INTAKE_VISITOR_SALT`. Without a SALT (not set), the per-visitor count uses one shared key "unknown", which is stricter and never looser. THE visitor IP address itself SHALL NOT be logged, stored, or used for any other purpose; only the hashed key is used for counting.
4. THE visitor key is specific to one UTC day, so keys cannot be linked across days.
5. CAP state (total calls, daily calls, per-visitor daily calls) SHALL persist across server restarts via a durable store: for local use, a JSON file store at `logs/caps.json`. For the public site, if no durable store is configured, THE AI reader SHALL be off (fail closed).
6. WHEN a cap is exceeded, THE StitchBoard SHALL display a plain message: "AI reader at capacity; try again tomorrow" or "AI reader is off".
7. THE `/api/reader-status` endpoint SHALL return `callsRemaining: null` if mode is "off" or caps unknown; otherwise `callsRemaining: number` (estimated calls left today, or for development, calls left before total cap).
8. Fake mode calls are counted in a separate in-memory counter and never use or change the paid-call cap state.

---

### Requirement 12 (MUST): Security — No Uploads Retained

**User Story:** As a user, I want to know my documents are never saved on the server, so that I trust the tool with confidential invoice data.

#### Acceptance Criteria

1. THE server SHALL NOT write uploaded files or rendered images to disk.
2. THE server SHALL NOT retain document text or images in memory after the reader call completes and the response is sent.
3. THE server SHALL NOT log or echo document content in any log file, error message, or trace output.
4. NOTHING except the file hashes, page metadata (dimensions), and extracted field values SHALL persist after the response.
5. Libraries that open uploaded files SHALL be on a version without a known high-severity advisory (`pdfjs-dist` 6.2.108 or later, advisory GHSA-hq66-cqwq-w95j).

---

### Requirement 13 (MUST): UI — Upload Control and Board Integration

**User Story:** As an Entry Writer, I want an "Upload documents" button in the StitchBoard title bar that opens a panel with file input and status, so that uploading is discoverable and does not disrupt the current draft view.

#### Acceptance Criteria

1. THE StitchBoard title bar SHALL have an "Upload documents" button or link that is visible when the sample bundle is displayed.
2. WHEN clicked, THE button SHALL slide open or expand an upload panel in the documents pane without closing the current draft view.
3. THE upload panel SHALL show (a) a file picker (accept PDF, JPEG, PNG); (b) per-file kind selector (dropdown or radio buttons); (c) the reader status line (mode and calls available, e.g. "Reader: OFF" or "Claude: 27 calls left today"); (d) a "Read documents" button (disabled if no files or if validation fails); and (e) the security notice (quoted above).
4. AFTER a successful read, THE board SHALL switch to show the uploaded bundle (tabs per document, page images or PDFs, threads, review lists, CSV download with filename `uploaded-7501-draft.csv`).
5. THE board SHALL display a "Back to sample" button or tab so the person can return to the sample bundle.
6. IF a read fails (validation, API error, or cap exceeded), THE board SHALL show the error message in the upload panel and keep the sample bundle visible; the person can fix and retry.
7. THE sample bundle flow (first screen, three tabs, entering 480 gives duty 28.80, CSV byte-identical to today) SHALL remain unchanged.

---

### Requirement 14 (MUST): Tests — Property-Based

**User Story:** As a developer, I want property-based tests for transcript conversion and reading validation, so that edge cases do not slip through.

#### Acceptance Criteria

1. PROPERTY TEST: "Transcript to PageText conversion preserves structure". For any transcript (array of items with text, box 0..1), THE resulting `PageText` SHALL satisfy:
   - Every item's span slices correctly back to its text (no misalignment).
   - Every box is within page bounds [0, 1] × [0, 1].
   - Text is items joined by single spaces.
   - All items are preserved.

2. PROPERTY TEST: "Reading answer to draft — low-confidence and unverifiable readings never become copied values". For any reading with `confidence: "low"` OR missing quote OR quote not on page OR value not in quote, THE draft SHALL NOT create a copied value; the field SHALL be "needsReview" with a reason. AND every copied value in the draft equals the value of an accepted reading after space normalization and carries a document source with doc, page, and a box inside the page.

3. PROPERTY TEST: "Transcript round trip". For any transcript item used whole as the quote of a reading, with a value taken from inside that line, verification accepts the reading when the line text is unique on the page and returns a box inside the page.

4. PROPERTY TEST: "Cap decision enforcement — calls never exceed daily, per-visitor, or total caps". For any sequence of cap-check calls with a given total, daily, and per-visitor cap setting, THE number of allowed calls SHALL NOT exceed any cap for any visitor or day.

5. PROPERTY TEST: "Cost estimate monotonicity — cost never decreases when tokens increase". For any two token counts `t1 ≤ t2`, THE estimated cost for `t2` SHALL be ≥ estimated cost for `t1`.

6. EXAMPLE TEST: Fake reader with a recorded answer for the sample bundle files. The fake reader SHALL return the recorded answer when called with the correct file SHA-256 set and reject with "no recorded answer" for any other set.

7. EXAMPLE TEST: Real reader request shape (with injected fake Anthropic client). Verify that THE reader constructs a valid API request with images base64-encoded, fields following the lantern-hollow schema, and handles a mock response correctly (NO REAL NETWORK CALL).

---

### Requirement 15 (MUST): Sample Bundle Unchanged

**User Story:** As a developer, I want the sample bundle to keep working exactly as today, so that existing tests and demos do not break.

#### Acceptance Criteria

1. THE first screen (loading the sample bundle automatically) SHALL render identically to today: three tabs (invoice, packing list, bill of lading), pages visible, fields populated from the frozen reader.
2. WHEN a person enters 480 as the value of line 004 Column 36A (entered value), THE computed Column 38 duty of line 004 SHALL be 28.80 and the Needs review list SHALL go from 21 to 17 items. (With Requirements 47 and 48: from 20 to 16, see 47.10.)
3. WHEN the person clicks "Download CSV", THE CSV file SHALL be byte-identical to today's output (same order of columns, same values, no extra metadata).
4. THE sample bundle mode selector or tab SHALL always be available so the person can switch back after uploading a document.

---

### Requirement 16 (MUST): Local Test Documents

**User Story:** As a developer, I want to run the whole upload-read-board flow locally end to end without calling the real AI, so that I can test and demonstrate the feature.

#### Acceptance Criteria

1. THE repository SHALL ship fictitious upload test documents under `samples/upload-test/`: at least one text PDF (PDF with a text layer), one scanned PDF (image-only pages, no text layer), and one photo (JPEG or PNG).
2. ALL documents SHALL have invented companies, people, and addresses; no real names or trademarks. They SHALL be clearly marked `DEMO / FICTITIOUS` visibly on every page.
3. ALL HTS numbers in the test documents SHALL exist in the shipped 33-row table (`data/hts/2026HTSRev23-subset.json`).
4. THE repository SHALL include a pre-recorded `Recording` (JSON file mapping file SHA-256 values to a `ReadingAnswer`) for the test documents so the fake reader can look them up.
5. WITH the server in fake mode (`DOCUMENT_INTAKE_MODE=fake`), running the whole flow end to end (upload, read, board with threads to boxes on text and image pages, Needs review list, CSV download) SHALL work locally without any API key or network call.

---

### Requirement 17 (MUST): Size and Cost Limit for One Reader Call

**User Story:** As an operator, I want every AI call to stay under a fixed cost and the running total to stay under the approved won budget, so that large or crafted uploads cannot spend more than approved.

#### Acceptance Criteria

1. THE server SHALL refuse with status 400 (model not called) a reader input with a page text longer than `intakeConfig.perCall.maxPageTextChars` (15,000 characters), page texts totalling more than `maxTotalTextChars` (60,000), or a page image whose base64 text is longer than `maxImageBase64Chars` (1,500,000).
2. BEFORE the model is called, THE server SHALL estimate the worst case of the call with `estimateReaderCall(input)`: input tokens = `promptOverheadTokens` (10,000: system prompt, field list, output schema) + for every page text and file name ceil(ASCII characters / 2) + 2 x other characters + `imageTokensPerPage` (5,000) per image page; output tokens = the output room of Requirement 29.4 (8,000 to 16,000, the `max_tokens` of the request); cost from the configured prices. These are upper bounds (Claude scales every image to at most about 4,800 tokens).
3. IF the worst-case cost is above `perCall.maxCallCostNanoUsd` (10,800,000 nano-USD = 0.0108 USD), THE server SHALL answer 413 with "These documents are too large to read in one go. Split them and upload fewer pages at a time." and SHALL NOT call the model or write the cap state. The line is 1.5 times the large-call cost assumed when the AI budget was approved (32,000 input and 8,000 output tokens = 0.0072 USD), the same factor used to re-check the first real calls.
4. THE cap state SHALL keep a running total `reservedCostNanoUsd`. Every allowed call adds its worst-case cost in the same conditional write that reserves the call (before the model is called), so the total can only over-count, also when a call times out or the function is stopped.
5. THE server SHALL refuse a call with 429 "This demo has used its AI budget." (usage record outcome "cap-exceeded", errorMessage "cost_cap") when the running total plus the call's worst-case cost would exceed the won cap converted at a deliberately high rate: `costKrw` 10,000 for the public site and 20,000 for local use, `krwPerUsd` 1,500. `DOCUMENT_INTAKE_COST_CAP_KRW` overrides the won cap (a positive integer; anything else turns the reader off, like the other caps). The converted cap is `setup.costCapNanoUsd`; `setup.caps` keeps its three call caps unchanged.
6. `/api/reader-status` remaining calls SHALL also respect the calls the cost cap still allows (each counted at the per-call line).
7. Fake mode applies the same size limits and the 413 line (test mode behaves like the real reader) but never touches the paid cap state.

---

### Requirement 33 (MUST): A Quantity That Was Not Read Is Not Zero

**User Story:** As an entry writer, I want the draft to tell me when a packing list or invoice quantity was not read, instead of comparing or adding it as zero, so that I check the right thing.

**Background:** In a real read of a test bundle, the quantity of packing list line 5 (item MCA-105) was rejected for low confidence while its item number was accepted. The draft left the line out of the packing list quantities and showed L005.35 "says 480 PCS, the packing list says 0 PCS. A person decides." and the check "invoice qty = 480, packing sum = 0". In the same way, when one invoice line of a 7501 line has no accepted quantity or unit, 35 is the sum of the other invoice lines, and the allocation of 34A leaves out a packing list line whose quantity was not read although the allocation uses only gross weights.

#### Acceptance Criteria

1. A packing list line is "not fully read" when the verified readings hold at least one reading of `packingList.lines.<n>.` (accepted or rejected) but no accepted item number, or no accepted quantity that parses as a count. The packing list quantities of an item number are, as today, the quantities of its fully read lines.

2. For each invoice line n of a 7501 line with an accepted quantity q, the quantity check of the line's 35 and of the check `P3.qty.<item>` SHALL be, in this order: (a) the invoice line has no accepted item number: 35 waits with the reason "The item number of invoice line <n> was not read, so its quantity was not compared with the packing list. A person compares them."; (b) a not fully read packing list line has the item number X of invoice line n: 35 waits with the reason "Packing list line <list> was not fully read (item number or quantity), so invoice line <n> (<q> PCS) was not compared with the packing list. A person compares them." and the check detail "packing list line <list> not fully read"; (c) the packing list quantities of X do not add up to q and some not fully read packing list line has no accepted item number: the same reason and detail with those lines; (d) no packing list line has the item number X: the reason "Invoice line <n> (<X>) says <q> PCS; no packing list line for <X> was read. A person decides." and the detail "no packing list line for <X> was read"; (e) the quantities of X do not add up to q: the reason and detail of today ("says <q> PCS, the packing list says <sum> PCS. A person decides."). In (a) to (e), 35 has status "needsReview", no value and the unit of the HTS number, and the check is not ok. <list> is the packing list line numbers joined with ", ".

3. WHEN there is no such difference and the HTS number is found, but an invoice line of the 7501 line has no accepted quantity, no accepted unit, or a unit the draft does not convert (anything but PCS, PC, EA, PIECES, NO., DZ PCS, DOZ., DZ., KG), 35 SHALL have status "needsReview", no value, the unit of the HTS number and the reason "The quantity or unit of invoice line <list> was not read or is not a unit the draft counts, so the net quantity is not added up. A person enters it." (instead of the sum of the other lines, or "Could not parse quantities from invoice lines."). <list> is the invoice line numbers joined with ", ".

4. THE gross weight allocation of 34A SHALL use every packing list line with an accepted item number and an accepted gross weight, whether or not its quantity was read (the allocation uses only gross weights).

5. THE sample bundle with or without the demo answers, the upload test recordings and the verifier's expected drafts are unchanged; Properties 35, 43, 47, 48 and 49 still hold.

---

### Requirement 18 (MUST): Values Read from Images Are Confirmed by a Person

**User Story:** As an entry writer, I want every value the AI read from a photo or scan to wait for my check, so that a misread or a tampered image cannot slip into the draft as a copied value.

#### Acceptance Criteria

1. WHEN a draft value would be "copied" and any of its document sources has origin "imageTranscript", THE draft SHALL give it status "needsReview" with reason "Read from an image by the AI reader. Check it against the page, then confirm it." The value and its sources stay, so the board still shows the value and the thread.
2. (Replaced by Requirement 26.) Values computed from such a value wait for a person as Requirement 26 says.
3. THE board SHALL show a "Confirm this value" button (data-testid "confirm-image-value") in the source strip of such a field. It applies the field's own value as the person's value. A confirmed field returns to status "copied" (the value is the document's, now checked by a person), keeps its value, sources and rule, and gets the note "Confirmed by a person against the page."; the board offers Undo for it. Status "personEdited" was not used because the existing recomputation after person values would then change other fields.
4. THE sample bundle has no image pages and is unchanged.

---

### Requirement 19 (MUST): Invoice Lines Checked Against the Invoice

**User Story:** As an entry writer, I want the draft to tell me when invoice lines may be missing, so that a line the reader left out does not silently disappear from the 7501.

#### Acceptance Criteria

1. THE draft SHALL add a totals field "CHK.INVOICE" (block "P2", label "Invoice lines against the invoice", status "needsReview", value null) when any of the following holds, with the reason of every case that holds joined by a space:
   - no `P2.invoice.subtotal` check ran (no accepted, parseable invoice subtotal): "No invoice subtotal was read, so the invoice line amounts were not added up against it. Compare the 7501 lines with the invoice."
   - a P2 check failed: "The invoice line amounts do not match the invoice totals (<detail of each failed P2 check, joined by "; ">). A line may be missing; compare the 7501 lines with the invoice."
   - the reader gave an invoice line count N that differs from the number M of invoice lines with at least one reading: "The invoice shows N item lines, but the draft has readings for M."
   - N is above 8: "The invoice shows N item lines; this draft reads only the first 8."
   Its sources are the accepted invoice subtotal and total readings, its inputs the P2 check ids. It appears in Needs review and in the CSV. A person closes it by entering a note as its value.
2. THE reader output SHALL include "invoiceLineCount": the number of item lines printed on the commercial invoice, counting lines whose fields were left out, or null when no invoice was given. The JSON schema requires it (integer or null); the output validator accepts it absent (older recordings) and otherwise requires null or an integer from 0 to 999. `readerOutputToAnswer` copies it into the reading answer (optional `invoiceLineCount`), and the board passes it to `buildDraft` (optional input `invoiceLineCount`).
3. THE sample bundle and the upload test recordings are unchanged (subtotal and total are read and match; they carry no count).

---

### Requirement 20 (MUST): Every Accepted Value Points to Its Place

**User Story:** As an entry writer, I want every accepted value to have a box on its page, so that the thread always leads to the printed value.

#### Acceptance Criteria

1. WHEN `verifyReadings` accepts a value but no text item lies fully inside the quote (the quote is part of one item, for example "HM-INV-1124" from the item "Invoice No.: HM-INV-1124"), THE box SHALL come from the items that overlap the value inside the quote.
2. IF no item overlaps the value either, THE reading SHALL be rejected with the new reason "no_source_box" and the message "The value was found, but no line on the page lines up with it, so there is nothing to point to." so it goes to Needs review.
3. Readings that get a box today keep exactly the same box.

---

### Requirement 21 (MUST): Time Limit for the Reader Call

**User Story:** As an operator, I want a stuck AI call to stop before the hosting platform cuts the function, so that the person gets a clear message and the call is still recorded.

#### Acceptance Criteria

1. THE Claude reader SHALL pass a request timeout of `intakeConfig.readerTimeoutMs` (45,000 ms) to `messages.create` (second argument `{ timeout }`), under the 60-second limit of a synchronous Netlify function.
2. A timeout SHALL become the ReaderError "The AI reader took longer than 45 seconds and was stopped. Try fewer pages." The usage record has outcome "error", that message and null tokens; the cost was already reserved (Requirement 17.4).
3. `max_tokens` SHALL be the output tokens of `estimateReaderCall(input)` (Requirement 29.4).

---

### Requirement 22 (MUST): Reader Errors Never Carry Document Text

**User Story:** As a user, I want error messages and usage records to hold no text from my documents, so that nothing from them is kept on the server.

#### Acceptance Criteria

1. Validation reasons for reader output SHALL name only positions and fixed words (for example "fields[3].doc: unknown document"), never a string taken from the model's answer, because the reason is stored in usage records.
2. THE output JSON schema sent to the model SHALL limit "doc" (in fields and in transcripts) to the document ids of the request.

---

### Requirement 23 (MUST): A Cap Reservation Counts Only When the Store Confirms It

**User Story:** As an operator, I want a call to go ahead only after the usage store has really saved its reservation, so that a store error cannot let calls through without being counted.

#### Acceptance Criteria

1. `createBlobsUsageStore().writeState` SHALL treat a conditional write as saved only when the result has `modified: true` and a non-empty string `etag`. Otherwise it SHALL throw "usage state write was not confirmed by the store; not written" (the existing "usage state changed by another request; not written" stays for `modified: false`).
2. WHEN `writeState` throws, THE server SHALL answer 503 "Usage store unavailable; the AI reader was not called." and SHALL NOT call the reader (as today).
3. Reason: the installed `@netlify/blobs` (10.7.13) answers a conditional write with `{ modified: true, etag: "" }` for every HTTP status other than 412, for example 403, 429 or 5xx after its retries, so `modified` alone does not prove the write.

---

### Requirement 24 (MUST): The Worst Case Counts Every Byte, and the Ledger Gets the Actual Cost

**User Story:** As an operator, I want the worst-case estimate to hold for any text a visitor uploads, and the cost ledger to hold what a call really cost, so that crafted text cannot spend more than the approved budget.

#### Acceptance Criteria

1. `estimateReaderCall` SHALL count every text the uploader controls at one token per UTF-8 byte (a token always covers at least one byte, so this bounds any text, also characters outside the Basic Multilingual Plane). inputTokens = `promptOverheadTokens` (10,000: the fixed system prompt, field list and output schema) + for every page: `perPageOverheadTokens` (160: the fixed words the request puts around a page) + utf8Bytes(fileName) + 4 x utf8Bytes(docId) (the request repeats the file name and the document id on every page, and the output schema lists the document id twice) + utf8Bytes(text) for a text page or `imageTokensPerPage` (5,000) for an image page. utf8Bytes counts, for each code point, 1 byte below U+0080, 2 below U+0800, 3 below U+10000 (lone surrogates included), 4 otherwise.
2. Any input that passes the per-call line (0.0108 USD, with at least 8,000 output tokens of room, Requirement 29.4) therefore has at most 68,000 input tokens, under the 100,000-token price step.
3. AFTER a reader call that reports token usage (a valid answer, an invalid answer, or a ReaderError that carries usage), THE server SHALL compute the actual cost with `estimateCostNanoUsd(inputTokens, outputTokens)`. IF it is above the worst case reserved for the call, THE server SHALL add the difference to `reservedCostNanoUsd`: read the state, apply `addReservedCost`, write it, with the tries of Requirement 42.1; if they fail, log "usage cost top-up not written" (no document text). The answer to the person does not change. A usage the call cannot have gets no top-up (Requirement 56.1), and the top-up runs after the record, within the time of Requirement 55.
4. `addReservedCost(state, extraNanoUsd)` in `budget.ts` SHALL return a new state with `reservedCostNanoUsd` = (old value or 0) + extraNanoUsd and every other part unchanged; it never changes its input.

---

### Requirement 25 (MUST): The Reader Uses Only the App's Own Key and the Anthropic Address

**User Story:** As an operator, I want the AI reader to start only with the key I set for this app and to call Anthropic directly, so that variables the hosting platform adds by itself cannot turn the reader on or route its calls elsewhere.

#### Acceptance Criteria

1. THE server SHALL read the Claude API key only from the environment variable `DOCUMENT_INTAKE_ANTHROPIC_KEY` (trimmed). It SHALL NOT read `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL`; with only `ANTHROPIC_API_KEY` and a store set, the mode is "off" with reason "no API key". Reason: on credit plans Netlify's AI Gateway puts `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` into every function by itself; with them the reader would start without the operator's key and its calls would go through the Gateway and be billed in Netlify credits, which can pause every site of the team.
2. THE Claude reader SHALL build its SDK client in one exported function `createAnthropicClient(apiKey)` in `claudeReader.ts` with `apiKey` given, `baseURL` fixed in code to "https://api.anthropic.com" (exported constant `ANTHROPIC_API_BASE_URL`), `maxRetries: 0`, `logLevel: "off"` and `openTelemetry: false`, so no environment variable can change the address, turn on SDK request logging or send traces with request content.
3. Operator order: set `DOCUMENT_INTAKE_ANTHROPIC_KEY` first, then `DOCUMENT_INTAKE_STORE=netlify-blobs` and `DOCUMENT_INTAKE_VISITOR_SALT`.

---

### Requirement 26 (MUST): Values Computed from Image Readings Wait for a Person

**User Story:** As an entry writer, I want every value the draft computes from something the AI read in a photo or scan to wait for my check, so that a misread total, quantity or weight cannot reach the 7501 as a computed value.

#### Acceptance Criteria

1. WHEN a draft value would be "computed" and any of its document sources has origin "imageTranscript", THE draft SHALL give it status "needsReview" with reason "Computed from values the AI reader read from an image. Check them against the page, then confirm it." (exported constant `IMAGE_COMPUTED_REVIEW_REASON`). Value, sources, rule, note and inputs stay. This happens in the same step as Requirement 18.1, before person values are applied. Examples: 34A gross weight from a packing list photo, 35 quantity and 36A entered value from a scanned invoice.
2. Confirming such a field (applying its own value; the same "Confirm this value" button) SHALL return it to status "computed" with reason null and the note "Confirmed by a person against the page."; value, sources, rule and inputs stay; the board offers Undo. Entering a different value works as for any other field.
3. AFTER all person values and the recomputation of totals, and before the Needs review list is built, every field with status "computed" or "copied" that depends on an image-waiting field SHALL get status "needsReview" with reason "Waiting on <ids>: values read from an image are not confirmed yet." where <ids> are the image-waiting fields it depends on, in draft order (header, then lines, then totals), joined by ", ". An image-waiting field has status "needsReview" and reason `IMAGE_REVIEW_REASON` or `IMAGE_COMPUTED_REVIEW_REASON`. A field depends on the fields in its `inputs`, and an "37A" field also on the "33A" and "10" fields of its own line (its rate is looked up from them), directly or through other fields. Value, sources, rule, note and inputs stay. There is no confirm button for these fields: they clear when the values they wait on are confirmed.
4. Requirement 18.2 ("values computed from such a value keep their status") is replaced by 26.1 to 26.3; 18.1, 18.3 and 18.4 stay.
5. THE sample bundle has no image pages and is unchanged.

---

### Requirement 27 (MUST): Missing Amounts, Currency and Gross Weight Go to a Person

**User Story:** As an entry writer, I want the draft to stop when an amount, the currency or the gross weight was not read, so that a missing value never becomes a zero or a partial sum on the 7501.

#### Acceptance Criteria

1. 36A: WHEN the invoice currency is read and is USD, no P1 check of the group failed, and any invoice line of the 7501 line has no accepted amount that parses as money, THE 36A field SHALL get status "needsReview", value null, reason "No accepted amount for invoice line <n>[, <m> ...]. A person enters the entered value." (the invoice line numbers without one, joined by ", "), and the accepted amount readings of the group as sources, instead of adding up the amounts that were read.
2. 36A: IF no accepted `invoice.currency` reading with a non-empty value exists, every 36A field SHALL get status "needsReview", value null, reason "No invoice currency was read. A person checks that the amounts are in USD and enters the entered value." (checked after the existing "Currency is not USD." case and before the P1 case).
3. 34A: IF no accepted `packingList.totalGrossKg` reading parses as kilograms, every 34A field SHALL get status "needsReview", value null, reason "No total gross weight was read from the packing list. A person enters the gross weight." (today they stay "computed" with no value).
4. Fields computed from these (38, B39, fees, totals) wait as they do today for a 36A in Needs review; none of them becomes "computed" with 0.
5. THE sample bundle, the upload test recordings and the verifier's expected drafts are unchanged (they read every amount, the currency and the total gross weight).

---

### Requirement 28 (MUST): Small Guards on Requests, CSV Cells and Day Counts

**User Story:** As an operator, I want other sites unable to spend the demo's AI reads, spreadsheet formulas unable to run from a document's text, and a server with a late clock unable to erase today's count.

#### Acceptance Criteria

1. THE read route SHALL refuse a request before reading its body: with 415 "Send the documents as JSON." when its `content-type` (lower case, the part before ";", trimmed) is not "application/json", and with 403 "Requests from other sites are not accepted." when a `sec-fetch-site` header is present and is neither "same-origin" nor "none". THE check is the exported function `readRequestRefusal(headers)` in `src/server/requestGuard.ts`, which returns `{ status, message }` or null. Browsers cannot send "application/json" to another site without asking first, so a page on another site cannot use a visitor's browser to spend the reads.
2. `draftToCsv` SHALL put a single quote (') in front of a cell that starts with "=", "+", "-", "@", a tab or a carriage return, before the usual quoting, so a spreadsheet shows the text instead of running it as a formula. THE sample and upload test CSVs have no such cell and do not change.
3. `decideCall` SHALL keep the counts of the previous, the current and the next UTC day of `nowIso` (today it keeps the previous and the current day), so a server whose clock is a little behind does not erase the count of a day that another server has already started.

---

### Requirement 29 (MUST): The Reader's Answer Fits in One Call

**User Story:** As an entry writer, I want the AI reader to finish its answer for an ordinary set of three documents with a photo and a scan, so that I get a draft instead of "The AI reader ran out of room for its answer."

**Background:** The first real call (an invoice text PDF, a packing list scan and a bill of lading photo; 12,798 input tokens) stopped at the 8,000-token output limit. An answer of the current shape for the three test bundles, built from their answer keys without a paid call, is about 18,800, 11,800 and 17,300 characters, that is about 6,300, 3,900 and 5,800 tokens at 3 characters per token and up to 9,400 at 2, before any thinking. Claude Haiku 5.5 thinks adaptively when `thinking` is left out, and thinking tokens count toward `max_tokens`.

#### Acceptance Criteria

1. `buildReaderRequest` SHALL send `thinking: { type: "disabled" }` together with `output_config.effort: "low"` (Claude Haiku 5.5 accepts "disabled" at effort low, medium and high). Reading printed values needs no reasoning, and without thinking the size of the answer depends only on the documents.
2. THE output schema SHALL ask for each transcript line as an object with exactly two properties: "t" (string, the line text) and "b" (array of integers: x, y, w, h of the line box in thousandths of the page width and height, origin top-left). The schema keeps `additionalProperties: false` and uses no `minimum`, `maximum`, `minItems` or `maxItems` (the API does not accept numeric and complex array constraints). `createClaudeReader` SHALL turn every line into the existing `{ text, box: { x, y, w, h } }` with each number divided by 1000 before `validateReaderOutput`. A line whose "b" is not exactly 4 integers from 0 to 1000 makes the answer invalid with the reason "transcripts[<i>].lines[<j>].b: must be 4 integers from 0 to 1000" (positions and fixed words only, Requirement 22.1). `ReaderOutput`, the fake reader, the recordings and every step after the reader stay as they are. (Changed by Requirement 37.1: a line with a bad "b" keeps its text with no box.)
3. THE system prompt SHALL describe the transcript line as "t" and "b" in thousandths, and SHALL say "Write the JSON on one line, with no indentation." (spaces and line breaks are output tokens too).
4. `estimateReaderCall` output tokens SHALL be the output room under the per-call line: the largest whole number of tokens o for which `estimateCostNanoUsd(inputTokens, o)` is at most `perCall.maxCallCostNanoUsd`, capped at `intakeConfig.readerMaxOutputTokens` (16,000, the usual limit for a request that is not streamed) and never below the new `intakeConfig.readerMinOutputTokens` (8,000, the output size of the approved cost assumption). `buildReaderRequest(input)` SHALL send this number as `max_tokens`. The 413 rule of Requirement 17.3 does not change: with fewer than 8,000 tokens of room the worst case (with 8,000) is above the line and the call is refused, so an input that passes still has at most 68,000 input tokens and no call's worst case is above 0.0108 USD. Examples: 21,841 input tokens give 16,000; 60,000 give 9,600; 68,000 give 8,000; 68,001 are refused.
5. THE time limit stays 45 seconds (Requirement 21.1). At the speed of the first call (8,000 tokens in about 28 seconds) about 12,000 output tokens fit in it, so 29.1 to 29.3 keep the answer short; the higher limit of 29.4 is room, not the target.

---

### Requirement 30 (MUST): A Value Computed Again After a Person's Edit Still Waits

**User Story:** As an entry writer, I want a value that the draft computes again from photo readings after I change another field to wait for my check, so that editing one field never makes an unchecked photo value final.

#### Acceptance Criteria

1. AFTER all person values and the recomputation of totals, and before the waiting pass of Requirement 26.3, every field with status "computed" or "copied" that has a document source with origin "imageTranscript" and whose note is not "Confirmed by a person against the page." SHALL get status "needsReview" with reason `IMAGE_COMPUTED_REVIEW_REASON` (for "computed") or `IMAGE_REVIEW_REASON` (for "copied"); value, sources, rule, note and inputs stay. Example: on a draft whose pages are all images, a person edits only L001.33A; L001.35 is computed again from the invoice quantities (216) and today becomes "computed" with no person check; it SHALL wait.
2. Applying the shown value of such a field through the same "Confirm this value" button SHALL make it final ("computed" with the confirmation note, or "personEdited" with that value); it SHALL NOT stay in Needs review.
3. Fields from text pages, the sample bundle, the upload test recordings and the verifier's expected drafts are unchanged; Properties 35 and 43 still hold.

---

### Requirement 31 (MUST): An Edited HTS Number Derives the Line's Quantity by the First Rule

**User Story:** As an entry writer, I want a line's net quantity (35) to follow the same rules after I change the line's HTS number (33A) as when the draft was first built, so that a quantity difference I still have to decide never disappears and the quantity is always in the unit of the number I chose.

**Background:** On the sample bundle, L003.35 waits with "says 240 PCS, the packing list says 216 PCS. A person decides." A person's edit of L003.33A, even to the same number 9505.90.4000, turns it into "computed" 240 and the difference is gone. On the text pages, editing L001.33A from 6913.90.5000 (unit Dz Pcs) to 7013.99.3500 (unit No.) leaves L001.35 at "computed" 18 with the unit changed to No.; the quantity in No. is 216. Both come from a second, shorter copy of the quantity rule that runs after the edit.

#### Acceptance Criteria

1. THE first build of a line's 35 and the rebuild after a person's 33A edit SHALL use one function of `draft.ts` (for example `deriveNetQuantity`), given the line number, the line's invoice lines and the HTS lookup. It gives the field that the first build gives today, in the same order: the quantity difference of the invoice and the packing list first (status "needsReview", the same reason, the unit of the HTS number, no value), then "Waiting on L<nnn>.33A: the HTS number is not in the tariff schedule revision." when the number is not found, then the quantity in the unit of the HTS number (status "computed", rule P12, the same note), else "Could not parse quantities from invoice lines.".
2. WHEN a person's value for L<nnn>.33A is accepted (the number is in the schedule), L<nnn>.35 SHALL be replaced by the result of that function for the new number, unless L<nnn>.35 has status "personEdited". This holds whatever 35 was before (computed, confirmed, or waiting for any reason). Examples on the sample bundle: L003.33A to 9505.90.4000 (the same number) or to 3926.40.0090 leaves L003.35 "needsReview" with the difference reason and no value; L001.33A of the text pages to 7013.99.3500 gives L001.35 "computed" "216" with unit "No."; L006.33A to 7013.99.5090 (the demo answer) gives L006.35 "computed" "300" as today.
3. WHEN L<nnn>.35 has status "personEdited" and the accepted 33A has another unit than 35 had, 35 SHALL get status "needsReview", no value, and the reason "L<nnn>.33A changed the unit from <old unit> to <new unit>; the quantity a person entered (<value> <old unit>) is in the old unit. A person enters the quantity in <new unit>." (the final period is not doubled when the unit ends with one, as in "No.") With the same unit the person's value stays. (Person values apply in order; a 35 entered after the 33A edit is in the new unit and stays.)
4. THE image rules of Requirements 18.1, 26.1 and 30.1 apply to the new 35 as before: a 35 computed from image readings waits until a person confirms it.
5. THE sample bundle without person values, the demo answers (`samples/lantern-hollow/overrides-demo.json`), the upload test recordings and the verifier's expected drafts are unchanged.

---

### Requirement 32 (MUST): A Value That Cannot Be Computed From What the Draft Has Now Waits

**User Story:** As an entry writer, I want a total or a duty that the draft cannot compute from the values it has now to wait for me with no value, so that a stale or empty number never looks final.

**Background:** A cross-check found three ways around this. When the reader gives no invoice line at all, the draft has no 7501 line and B39 is "computed" 0, FEE.MPF "computed" 34.58 (the minimum) and B41 "computed" 0.00. When a person's value for a line's 36A is refused (for example "540.50", not whole dollars), 36A has no value but its 38 keeps the duty computed from the old value; the same happens when a person enters a rate that is not Free or a simple percentage (for example "5 cents/kg") in 37A. When only the invoice currency was read from an image page and the amounts from a text page, every line's 36A is "computed" with no person check, because the currency is not among its sources; the same holds for the packing list total gross weight and 34A, and for an invoice line's unit and 35.

#### Acceptance Criteria

1. WHEN the draft has no 7501 line, B39 and B41 SHALL have status "needsReview", no value, and the reason "No 7501 line was built because no invoice line was read. A person reads the invoice lines.", in the first build and after the recomputation of totals. FEE.MPF, B43 and B44 then wait as they do today when an input waits ("Waiting on B39." and so on).
2. AFTER the person values, a line's 38 that is not "personEdited" SHALL follow the rule of its first build: no value and "Waiting on L<nnn>.36A." when 36A has no value or waits for another reason than the two image reasons (`IMAGE_REVIEW_REASON`, `IMAGE_COMPUTED_REVIEW_REASON`); else no value and "Waiting on L<nnn>.37A." for 37A in the same way; else the duty of `computeDuty` from the shown values (status "computed", rule P7, inputs [L<nnn>.36A, L<nnn>.37A], the same note), or no value with the reason of `computeDuty` when it cannot compute. A 38 whose inputs wait only for a person's image check keeps a value and waits through Requirement 26.3 as today. Examples on the sample bundle: text pages and L001.36A "540.50" give L001.38 "needsReview" with no value and "Waiting on L001.36A."; text pages and L001.37A "5 cents/kg" give L001.38 "needsReview" with no value; every page an image, every other image value confirmed, and L001.36A "540.50" give the same as the text pages.
3. WHEN a line's 36A is "computed" and the invoice currency reading came from an image page, or a line's 34A is "computed" and the packing list total gross weight reading came from an image page, or a line's 35 is "computed" and the unit reading of one of its invoice lines came from an image page, that reading SHALL be added to the field's sources, so that the field waits by Requirement 26.1 and the person sees the page box. When these readings come from text pages, the sources stay as they are.
4. THE sample bundle with or without the demo answers, the upload test recordings and the verifier's expected drafts are unchanged; Properties 35, 43 and 47 still hold.

---

### Requirement 34 (MUST): A Value That Repeats on the Page Is Checked in Its Own Line

**User Story:** As an entry writer, I want a value that is printed on many lines (a country code, a unit, the same HTS number, a small count) to be checked in its own line, so that a right value is not refused only because the same text is printed elsewhere, and every value still points to one place.

**Background:** In a real read of test bundle A, `verifyReadings` refused 15 right values with `quote_not_unique`: "PT" and "PCS" printed on every invoice line, "6913.90.5000" printed on invoice lines 1 and 5, and the carton counts "20", "24", "6" and the total "77" of the packing list, which also appear inside "1-20", "1,200" or "66-77".

#### Acceptance Criteria

1. WHEN a quote appears more than once on the page, `verifyReadings` SHALL count only its whole-word occurrences: the character before the occurrence is the start of the page text or a space, and the character after it is the end of the page text or a space. When the page has exactly one whole-word occurrence, the reading is checked at that occurrence (value inside the quote, box) as a quote found once is checked today. Example: on the packing list transcript of bundle A, "77" appears in "66-77" and in "TOTAL 77 4,980"; only the second is a whole word, so `packingList.totalCartons` is accepted with the box of the TOTAL line.
2. WHEN the reading is a line field (`invoice.lines.<n>.<f>` or `packingList.lines.<n>.<f>`) and its quote has not exactly one whole-word occurrence on the page, THE check SHALL look in the row of line <n> only. The row comes from an anchor: the first of the same line's readings `itemNo`, `description` and `amount` whose own quote has exactly one occurrence, or exactly one whole-word occurrence, on the same page, and contains its own value; the anchor items are the page items that overlap that occurrence. On a text page the row is every item of the page whose box overlaps the vertical extent of the anchor items by at least half of the item's own height; on an image transcript page the row is the anchor items (each transcript line is a row). WHEN the quote has exactly one whole-word occurrence that starts inside a row item, the reading is checked at that occurrence. Example: on the bundle A invoice, the quote "PT" of `invoice.lines.3.origin` is checked in the row of "MCA-103" and gets the box of that row's "PT".
3. WHEN no anchor is found, or the row has not exactly one such occurrence, THE reading SHALL be rejected with `quote_not_unique` and today's message.
4. A reading that is accepted today keeps exactly the same status, items and box. Only readings that are rejected today with `quote_not_unique` can change.

---

### Requirement 35 (MUST): A Date in the Asked Form and a Quote Over Two Lines Are Checked Against the Page

**User Story:** As an entry writer, I want a date that the reader wrote in the form the field list asks for, and an address that the reader quoted over two printed lines, to be checked against what is printed, so that right values are not refused for the form they were asked to take.

**Background:** The field list asks the reader for `invoice.date` and `billOfLading.onBoardDate` in MM/DD/YYYY, but `verifyReadings` wants the value inside the quote, so "11/03/2026" with the quote "Date: 03 Nov 2026" and "11/05/2026" with "Shipped on board: 05 NOV 2026" were refused although right. The seller address printed on two lines in the left column of the invoice was quoted as one text, "Rua das Corujas 12, Vila Nevoa 0000-000 Portugal"; on a text page with two columns the two lines are not next to each other in the page text, so the quote was "not on the page", and the value had a comma where the line breaks.

#### Acceptance Criteria

1. FOR `invoice.date` and `billOfLading.onBoardDate`, WHEN the value is not inside the quote, `verifyReadings` SHALL accept the reading when the value is a real calendar date written MM/DD/YYYY, the quote passes the checks of being found and unique, and the quote holds exactly one printed date that names the same day without doubt. Printed dates without doubt: a day number, an English month name or its first three letters (any case) and a four-digit year, in the forms "03 Nov 2026", "03-NOV-2026", "Nov 03, 2026", "November 3, 2026" and "Nov 3 2026"; the form "2026-11-03"; and the form "09.11.2026" (dots: day, month, year). Other number-only dates ("03/11/2026" with the value "11/03/2026", "3/11/26") are not without doubt and stay `value_not_in_quote`. The box comes from the items that overlap the printed date inside the quote. Examples: "11/03/2026" with "Date: 03 Nov 2026" is accepted; "11/09/2026" with "Date: 09.11.2026" is accepted and "09/11/2026" with it is rejected (that date is the 9th of November); "02/30/2026" is rejected.
2. `parseUsDate` and the 7501 Block 15 stay as they are.
3. WHEN a quote is not found in the page text of a text page, `verifyReadings` SHALL try it over stacked lines: two to four page items where each next item is the nearest item below the previous one in the same column (its box top lies below the previous item's box top by at most twice the previous item's height, and its left edge is within 2 points of the first item's left edge), and whose texts joined with single spaces equal the quote. WHEN exactly one such run is on the page, the quote is found there and checked as a quote found once, with the box from the run's items.
4. WHEN the items of a found quote lie on two or more rows (their boxes do not overlap vertically, as in a run of 35.3 or a quote over two transcript lines of an image page), the value SHALL also count as inside the quote when it reads ", " in place of the space where one row ends and the next begins. Example: the value "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal" with the run above is accepted with the box around both items.
5. A reading that is accepted today keeps exactly the same status, items and box.

---

### Requirement 36 (MUST): A Value the Reader Was Not Sure Of Is Shown, Not Used

**User Story:** As an entry writer, I want a value that the AI reader marked as not sure to stay visible with its place on the page, without being used in any count or total, so that I can check it instead of losing it.

**Background:** The reader marked five values of bundle A "low": two net weights under a coffee stain, the handwritten quantity of packing list line 5, the printed quantity total and the total gross weight 1,248.0. Four were right. Today they are rejected like a value that is not on the page and disappear: every 34A says "No total gross weight was read from the packing list", so the difference of 1,248.0 kg (packing list) and 1,284.0 kg (bill of lading) that the entry writer must decide is never shown.

#### Acceptance Criteria

1. `verifyReadings` SHALL check a reading with `confidence: "low"` like any other reading. WHEN it fails a check, it is rejected with that check's reason. WHEN it passes every check, it SHALL get the new status "uncertain" with the box, items and origin an accepted reading would get, and the message "The AI reader was not sure of this value, so the draft does not use it. A person checks it on the page." `verifyReadings` no longer gives the reason "low_confidence" (the value may stay in the RejectReason type). This replaces Requirements 5.1 and 5.4 for low confidence; a missing confidence still counts as passed (Requirement 5.3).
2. THE draft SHALL treat an "uncertain" reading like a rejected reading in every count, sum, comparison, check, grouping and computed value: every field and check of the draft has the same status and value as when that reading is rejected, except as 36.3 says, and only the reasons of 36.4 and Requirement 38.4 change.
3. FOR the header fields B8 (`billOfLading.vessel`), B12 (`billOfLading.number`), B14 (`invoice.countryOfExport`) and B15 (`billOfLading.onBoardDate`), WHEN the reading is "uncertain" and the value converts as the copy does today (B12 passes the B/L number check, B14 gives a country code, B15 passes `parseUsDate`), the field SHALL have status "needsReview", the value the copy would have, the reading as its document source, and the reason `LOW_CONFIDENCE_REVIEW_REASON` = "The AI reader was not sure of this value. Check it against the page, then confirm it." The board shows the "Confirm this value" button for this reason as it does for `IMAGE_REVIEW_REASON`; confirming with the shown value makes the field "copied" with the note `CONFIRMED_NOTE`. When the value does not convert, the field is as today when the reading is rejected.
4. Reasons that name an uncertain value:
   a. WHEN `packingList.totalGrossKg` is "uncertain", every line's 34A SHALL have status "needsReview", no value, no sources but that reading, and the reason "The AI reader read the packing list total gross weight as <v> kg but was not sure, so it is not used. A person checks it and enters the gross weight." where <v> is the reading's value with spaces normalized; Requirement 38.4 adds the bill of lading weight to it.
   b. WHEN the only packing list lines with the item number of an invoice line that are not fully read (Requirement 33.1) are not fully read only because their quantity reading is "uncertain", the reason of Requirement 33.2 (b) SHALL read "The AI reader read the quantity of packing list line <k> as <v> but was not sure, so invoice line <n> (<q> PCS) was not compared with the packing list. A person compares them." for one such line (with more lines: "of packing list lines <list> as <v1>, <v2>, ..."), and the check detail "packing list line <list> quantity not sure".
   c. In the reason of L<nnn>.10, the part for an invoice line whose origin reading is "uncertain" SHALL read `Invoice line <n>: the AI reader read "<v>" but was not sure. A person checks it on the invoice.`; for an origin reading rejected with a reason other than "quote_not_found" it SHALL read `Invoice line <n>: the reader suggested "<v>" but it was rejected: <message>` with that reading's message (today it always says the quote is not on the page). A reading rejected with "quote_not_found" keeps today's text (the sample bundle's line 7).
5. THE board SHALL draw the box of an "uncertain" reading on its page with a dashed border, with `data-testid` "uncertain-box-<field>" and `data-reading` "<field>" (so a thread can reach it), and list the page's "uncertain" readings in a block with `data-testid` "uncertain-readings" above the rejected ones: the field name, the value in quotes, and "not sure, not used until a person checks it". Rejected readings stay in "rejected-readings"; accepted boxes keep `data-testid` "box-<field>".
6. THE sample bundle (no confidence), the demo answers and the verifier's expected drafts of the sample are unchanged.

---

### Requirement 37 (MUST): One Bad Transcript Line Does Not Throw Away the Answer

**User Story:** As an entry writer, I want the app to keep a paid answer when one transcript line has a bad box, so that I get every value that does not depend on that line.

**Background:** A real read of test bundle B (an invoice PDF and a scanned bill of lading) was refused as a whole with "The reader answer was not valid: transcripts[0].lines[21].b: must be 4 integers from 0 to 1000" after the call was paid; the user got nothing.

#### Acceptance Criteria

1. THE Claude reader SHALL turn a transcript line whose "b" is not 4 integers from 0 to 1000, or whose box ends past the page (x + w or y + h over 1001 in thousandths), into a line with its text and `box: null`, instead of refusing the answer. A line whose "t" is not a string is left out of the transcript. Every other check of the answer (field names, documents, pages, confidence, a missing transcript for an image page) refuses the answer as today.
2. `TranscriptLine.box` MAY be null. `validateReaderOutput` SHALL accept a line with `box: null` and check every other box as today. `transcriptToPageText` keeps such a line as a page item (its text in the page text as today) that is marked as having no box.
3. WHEN `verifyReadings` would take the box of a reading from an item that has no box, THE reading SHALL be rejected with the reason "no_source_box" and the message "The value was found on a line of the image that the AI reader gave no usable place for, so there is nothing to point to." It goes to a person as every rejected reading does. Readings on other lines are checked as today. (Changed by Requirement 58.1: on an image page such a reading waits for a person, with no box.)

---

### Requirement 38 (MUST): A Draft Value Waits for What Was Not Read, With the Right Reason

**User Story:** As an entry writer, I want a value that depends on something not read to wait and to say what is missing, so that a value computed from part of the lines never looks final and I am not sent after the wrong problem.

**Background:** With bundle A, the origins of four invoice lines were rejected and Block 10 became "computed" CN from the one line left. An HTS number that was not read gave the reasons "HTS number must be exactly 10 digits (got "")" and "the HTS number is not in the tariff schedule revision". When a person enters an HTS number that is not in the schedule, 33A waits but 35, 37A and 38 keep the values of the old number. When a packing list line's gross weight was not read, 34A says the line sum "differs" from the total.

#### Acceptance Criteria

1. WHEN any 7501 line's 10 has no value and the line 10 values that are there hold fewer than two different codes, B10 SHALL have status "needsReview", no value, the inputs of today, and the reason "Waiting on <the ids of the line 10 fields with no value, joined with ", ">." Otherwise B10 is built as today (one code: "computed" with that code; two or more different codes: "computed" "MULTI", which no missing origin can change; the sample bundle's B10 stays "MULTI" although its L007.10 has no value). THE first build and `recomputeTotals` SHALL use one function for B10, so that B10 is built again after person values unless it is "personEdited". Example: the line 10 values of L001, L002, L003 and L005 missing give "Waiting on L001.10, L002.10, L003.10, L005.10."; after a person enters "PT" in each, B10 is "computed" "MULTI".
2. WHEN none of the invoice lines of a 7501 line has an accepted HTS reading, L<nnn>.33A SHALL have status "needsReview", no value, and the reason made of one part per invoice line n of the 7501 line, joined with " ", then " A person reads it on the invoice. The app does not choose a number.": no reading of `invoice.lines.<n>.hts`: "The HTS number of invoice line <n> was not read."; a rejected reading: `Invoice line <n>: the reader suggested "<v>" but it was rejected: <message>`; an "uncertain" reading: `Invoice line <n>: the AI reader read "<v>" but was not sure.` The line's 35 and 37A then wait with the reason "Waiting on L<nnn>.33A: the HTS number was not read." (instead of "...is not in the tariff schedule revision."). An HTS number that was read and is not in the schedule keeps today's reasons.
3. WHEN a person's value for L<nnn>.33A is refused (not a 10-digit number or not in the schedule), L<nnn>.35 and L<nnn>.37A that are not "personEdited" SHALL have status "needsReview", no value, and the reason "Waiting on L<nnn>.33A: the HTS number a person entered was not accepted."; L<nnn>.38 then waits on 37A by Requirement 32.2. Example on the sample text pages: L001.33A "9999.99.9999" gives L001.35 and L001.37A no value and L001.38 "Waiting on L001.37A.".
4. THE line 34A fields SHALL follow these rules in this order, each giving every line's 34A status "needsReview", no value and the reason shown: (a) the total gross weight was not read (no reading, rejected, or not a weight): today's reason; "uncertain": the reason of 36.4a, where, WHEN `billOfLading.grossKg` is accepted or "uncertain" and its weight differs from <v> by more than 0.1 kg, the sentence "The bill of lading says <b> kg." comes before "A person checks it and enters the gross weight." (<b> as printed, spaces normalized); (b) the total gross weight is accepted, `billOfLading.grossKg` is accepted or "uncertain", and the two weights differ by more than 0.1 kg: "The packing list total gross weight (<p> kg) differs from the bill of lading (<b> kg). A person decides." (<p> and <b> with one decimal, as the reason of today's sum difference writes weights); (c) a packing list line has at least one reading but no accepted item number or no accepted gross weight that parses: "The gross weight of packing list line <list> was not read or the AI reader was not sure of it, so the total cannot be split over the 7501 lines. A person enters the gross weight."; (d) the line sums differ from the total: today's reason. Otherwise the allocation is as today. Example for bundle A: (a) gives "The AI reader read the packing list total gross weight as 1,248.0 kg but was not sure, so it is not used. The bill of lading says 1,284.0 kg. A person checks it and enters the gross weight."
5. THE sample bundle with or without the demo answers and the verifier's expected drafts of the sample are unchanged. In the upload test recordings only the reasons these rules name change (the packing list line 3 gross weight there is marked low, so its 34A reason follows 38.4 (c)).

---

### Requirement 39 (MUST): A Box on a Photo or Scan Shows the AI Reader's Estimated Place

**User Story:** As an entry writer, I want a box on a photo or a scan to say that its place is the AI reader's estimate, so that a box that is a little off does not look like a wrong value, and I check the words.

**Background:** For an image page the reader gives each transcript line a box in thousandths of the page. In a real read of test bundle A, the boxes on the photo of the bill of lading were up to 0.23 of the page height above the printed lines near the top and on them near the bottom, and the boxes on the scanned packing list were on the lines near the top and up to 0.15 below them at the bottom, while the app sends the whole image with its own proportions and maps the thousandths back on the same frame. So the thread of Block 8 ended on the Shipper line, although the value and its transcript line were right. The app cannot measure the place without another read, so it shows the box as the AI reader's estimate.

#### Acceptance Criteria

1. `verifyReadings` SHALL give every accepted or "uncertain" reading from an image transcript page the field `lineText`: the texts of the items its box comes from, joined with " ". Readings from text pages get no `lineText` and are otherwise unchanged.
2. THE board SHALL draw the boxes of readings from image transcript pages with a dashed border and `data-approx="true"`; boxes on text pages keep their look and have no `data-approx`. WHEN such a box belongs to the selected field, a small label "AI estimate" with `data-testid` "approx-label" is shown at the box. Above the page view of an image page, the board shows one line with `data-testid` "approx-note": "Boxes on a photo or scan are where the AI reader placed each line. They can be off; check the words."
3. THE source strip SHALL show, for a document source of an image transcript page, after today's text: `Place estimated by the AI reader. Its transcript line: "<lineText>"`.
4. Text-page boxes, the sample bundle, the CSV and the `box-<field>` test ids are unchanged.

---

### Requirement 40 (MUST): A Weight or Package Count With Thousands Commas Is Read

**User Story:** As an entry writer, I want "1,248.0 kg" and "1,200 CTNS" read as the numbers they are, so that the weight checks and the 34A split work for shipments over 1,000 kg.

**Background:** `parseMoneyToCents` and `parseCount` read thousands commas; `parseKgToTenths` and `parsePackages` did not. An accepted total gross weight "1,248.0" counted as "not a weight", so every 34A said "No total gross weight was read", and the bill of lading weight "1,284.0" was never compared.

#### Acceptance Criteria

1. `parseKgToTenths` SHALL read an integer part written with thousands commas in groups of three (one to three digits, then one or more groups of a comma and three digits) as well as plain digits, with the optional single decimal and the optional "kg" as today. Examples: "1,248.0" gives 12480 tenths, "12,345.6 kg" gives 123456. A comma anywhere else ("1,24.8", "12,34", ",123.4", "1,2345.0") stays not a weight.
2. `parsePackages` SHALL read the count in the same two forms: "1,200 CTNS" gives 1200; "1,20 CTNS" is refused.
3. `parseMoneyToCents` and `parseCount` stay as they are (they already read thousands commas in groups of three). Person values of 34A and 35 keep their pattern. The sample bundle, its CSV and the verifier's expected drafts are unchanged.
4. THE packing list sum checks `P3.packing.gross`, `P3.packing.net` and `P3.packing.cartons` SHALL not add up part of the lines: WHEN a packing list line has at least one reading but no accepted gross weight (net weight, carton count) that parses, the check has ok false and the detail "packing list line <list> gross weight not read or not sure" ("net weight", "cartons" for the other two), not a line sum that leaves the line out. Example: once "1,103.0" is read, the real read of bundle A (net weights of lines 2 and 3 not sure) gives "packing list line 2, 3 net weight not read or not sure" instead of "line sum = 512.0, total = 1103.0".

---

### Requirement 41 (MUST): A Paid Call Always Leaves a Usage Record

**User Story:** As an operator, I want every paid reader call to leave its usage record, so that the paid-call ledger counted from these records is never short.

**Background:** The installed `@netlify/blobs` answers a conditional PUT with `{ modified: true, etag: "" }` for 403, 429 and 5xx, and `appendRecord` did not look at the result, so a refused record write left no record and no log line. Token counts from the reader that are not integers made the record's cost throw after the reader was called, so the server answered 500 and wrote no record.

#### Acceptance Criteria

1. `createBlobsUsageStore().appendRecord` SHALL write the record and judge the write as Requirement 54.1 says; WHEN the record is not saved it SHALL throw "usage record write was not confirmed by the store; not written".
2. WHEN `appendRecord` throws in claude mode (success, error and cap-exceeded records), THE server SHALL log one line: `usage record not written: ` followed by the JSON of `{ timestamp, model, outcome, inputTokens, outputTokens, estimatedCostNanoUsd }` of that record (no file hashes, no error message, no document text). The status and body of the answer are the same as with a working store. The record is not written again (the library has already retried 429 and 5xx). (Requirement 62.2 adds the record key to this line.)
3. WHEN the reader reports `inputTokens` or `outputTokens` that is not a non-negative safe integer, or a usage the call cannot have (Requirement 56.1), THE server SHALL NOT throw: the record has `inputTokens: null`, `outputTokens: null` and `estimatedCostNanoUsd` = the worst case reserved for the call (`estimateReaderCall(input).worstCaseCostNanoUsd`), the ledger gets no top-up, and the answer is the one for that outcome (200 with the output for a valid answer, 502 for an invalid answer or a reader error).

---

### Requirement 42 (MUST): The Cost Top-Up Waits and Tries Again, and a Store Error Is Judged by Its Status

**User Story:** As an operator, I want the cost ledger to keep the actual cost when two requests write at the same moment, and a store error never to count as a saved write, so that the cost cap holds.

**Background:** The top-up of Requirement 24.3 tried 3 times without waiting, so when other requests reserved at the same moment all 3 tries met a changed state and the ledger kept less than the actual cost (10 staggered calls: 0.985 USD in the ledger, 1.12 USD spent). It also tried again after a store error that the library had already retried 5 times. A conditional PUT answered 503 with an `etag` header counted as confirmed.

#### Acceptance Criteria

1. THE top-up (Requirement 24.3) SHALL make up to 6 tries; each try reads the state, applies `addReservedCost` and writes it. A try that fails because the state changed (`writeState` throws `UsageStateConflictError`, exported from `usageStore.ts`, message "usage state changed by another request; not written", thrown by the Blobs store for `modified: false`) is followed by a wait and the next try: before try n (n = 2 to 6) the server waits 50 x (n - 1) ms plus a random part below 50 x (n - 1) ms (at most 1.5 s in all). A try that fails for any other reason ends the top-up. WHEN the top-up is not written, THE server logs "usage cost top-up not written" (as today). The answer does not change. `ReadDeps.sleep?: (ms: number) => Promise<void>` (default: a `setTimeout` promise) does the waiting, so tests do not wait.
2. `openNetlifyBlobs` SHALL pass `getStore` the option `fetch: dropEtagOnError()`. `dropEtagOnError(base?)`, exported from `usageStoreBlobs.ts`, returns a fetch that calls `base` (default: `globalThis.fetch` at the time of each request) and, WHEN the response status is not 200 to 299, returns the same response without its `etag` header (status, other headers and body unchanged); responses 200 to 299 pass unchanged. So a conditional PUT answered 403, 429 or 5xx counts as not confirmed even when the answer carries an ETag (Requirement 23.1).

---

### Requirement 43 (MUST): The "AI estimate" Label Does Not Cover the Page Text

**User Story:** As an entry writer, I want the "AI estimate" label beside the selected box, so that it does not hide the words of the line above.

**Background:** The label sat above the top left corner of the selected box and covered the first characters of the line above it (on a scanned bill of lading, "Consignee:" above the "Vessel:" line of Block 8).

#### Acceptance Criteria

1. THE "approx-label" (Requirement 39.2) SHALL stay a child of the selected box element and sit beside the box: to the right of the box, vertically centred, WHEN the page view has at least 96 px to the right of the box; otherwise to the left of the box, vertically centred, WHEN it has at least 96 px to the left; otherwise above the box as before. The label has `data-label-side` = "right", "left" or "above".
2. Everything else on the board stays as it is.

---

### Requirement 44 (MUST): A CSV Number Keeps Its Sign, and Block 9 Waits Without a Container Number

**User Story:** As an entry writer, I want "-12" in the CSV to stay "-12", and Block 9 not to say that the bill of lading lists a container when no container number was read, so that the draft says only what the documents show.

**Background:** Every CSV cell that started with "+" or "-" got a leading quote, also plain numbers, and the tests of Property 45 repeated the rule inside the test instead of reading the real `draftToCsv` output. B9 was "11" computed with the note "Vessel, containerized: the B/L lists a container." also when the container number was not read or was rejected.

#### Acceptance Criteria

1. THE CSV SHALL NOT add the leading quote to a cell that is a plain number: an optional "+" or "-", then digits (plain, or one to three digits followed by groups of a comma and three digits), then optionally "." and digits. Examples: "-12", "+5", "-1,234.50" stay as they are. Every other cell that starts with "=", "+", "-", "@", a tab or a carriage return keeps the leading quote: "+5V adapter" gives "'+5V adapter" (a spreadsheet would read it as a formula) and "=HYPERLINK(...)" gives "'=HYPERLINK(...)".
2. THE tests of Property 45 SHALL put the value into a field of the sample draft and read the cell back from the real `draftToCsv` output with `parseCsv`, not repeat the rule inside the test.
3. WHEN the bill of lading container number has no accepted reading (not read, rejected, or not sure), B9 SHALL be needsReview with no value, no rule, no note and the reason "The container number on the bill of lading was not read, so the mode of transport is not known. A person checks the bill of lading." (Requirement 47.7 replaces the case of a container number that is not read when a vessel is read: B9 is then "10".) WHEN it is accepted, B9 stays as today ("11", computed, rule "7501 p.8", the container reading as its source; a value from an image waits for a person by Requirement 26). The sample bundle, its CSV and the verifier's expected drafts are unchanged.

---

### Requirement 45 (MUST): An Excel Document Is Read With Cell Addresses

**User Story:** As an entry writer, I want to upload the packing list the supplier sent as an Excel file, so that I do not print it to PDF first, and every value shows the cell it came from.

**Background:** The upload accepted only PDF, JPEG and PNG and refused ".xlsx". The text of an Excel cell is exact and cheaper to read than an image, so a sheet goes the same way as a text PDF page: the reader gets the cell text and every quote is checked against it.

#### Acceptance Criteria

1. THE upload SHALL accept a file whose name ends in ".xlsx" (or whose type is "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") for any document kind, within the existing file size limit. Other files are refused with "<name>: only PDF, JPEG, PNG and Excel (.xlsx) files are accepted." (this replaces the old message), also ".xls", ".xlsm", ".xlsb" and ".csv".
2. `readXlsx(bytes, fileName)` in `src/core/sheet.ts` SHALL read only the workbook list, its relationships, the shared strings, the styles and the worksheets of visible sheets. It never reads macros (`xl/vbaProject.bin`), external links (`xl/externalLinks/`), connections or embedded objects, never runs or follows a formula, and takes a formula cell's saved value (without a saved value the cell is empty). Hidden sheets, hidden rows and hidden columns are not read, because a person does not see them.
3. `readXlsx` SHALL refuse the file before reading further, with these reasons: not a zip file, or a part it needs is missing or broken: "<name>: could not read the Excel file."; more than 1,000 zip entries, a part it reads inflating to more than 5,000,000 bytes, or the parts it reads inflating to more than 20,000,000 bytes together, whatever sizes the zip headers claim (inflating stops as soon as a limit is passed): "<name>: the Excel file unpacks to too much data; it may be damaged."; no visible sheet with a cell that has text: "<name>: the Excel file has no visible sheet with text."; more than 4 visible sheets: "<name>: <k> visible sheets is over the 4 sheet limit."; a sheet with more than 5,000 cells with text, a cell right of column AZ or below row 1,000, or a cell with more than 1,000 characters: "<name>: sheet "<sheet>" is too large (at most 5,000 cells with text, columns A to AZ, rows 1 to 1,000 and 1,000 characters in a cell)."
4. A cell's text SHALL be what a person sees in Excel in the common cases: shared and inline strings as written (rich text runs joined, phonetic runs left out); a number in "General" with at most 15 significant digits ("132.30000000000001" gives "132.3"); a number format made only of "0", "0.0...", "#,##0" or "#,##0.0..." with that many decimals and with thousands commas when the format has them (1800 with "#,##0" gives "1,800", 70 with "0.0" gives "70.0"); a date format (built-in formats 14 to 22, or a format code with d, m or y outside quotes and brackets and without 0 or #) as MM/DD/YYYY in the 1900 date system; a boolean as "TRUE" or "FALSE"; an error as written ("#N/A"). Any other number format gives the General text.
5. `sheetToPageText(sheet, docId, page)` SHALL make one text page per visible sheet, in workbook order. It has one text item per cell with text, in row then column order, with `cell` set to the address "<sheet>!<column><row>" in Excel form (a sheet name with anything other than letters, digits and "_" is put in single quotes: "'Packing List'!G16"), the box of the cell on a drawn grid (a column is 6 points per character of its width, 8.43 characters when not set; a row is its height in points, 15 when not set; 36 points on the left for row numbers and 20 points on top for column letters; a hidden row or column has no size), and `origin: "sheet"`. The page text is built as for a text-layer page (items joined by one space), so quotes are checked by the same rules as on a text PDF page. The page also carries the grid (column letters with x and width, row numbers with y and height) for drawing.
6. THE upload SHALL send each sheet page to the reader as a text page (text set, image null), so the per-page and per-call text limits and the worst-case cost estimate apply unchanged. The prompt, the field catalog, the answer format and the output room do not change.
7. AN accepted or uncertain reading whose quote lies on a sheet page SHALL carry `cell`: the address of the one cell it covers, or "<first>:<last>" over the first and last cell it covers in reading order (for example "'Packing List'!A3:B3"). The draft source made from it carries the same `cell`. The source strip shows " (cell 'Packing List'!G16)" after the quote, and the CSV source gives `packingList p.1 [x,y,w,h] "604.0" (cell 'Packing List'!G16)`. Sources from PDF and image pages are unchanged, so the sample CSV stays the same byte for byte.
8. THE board SHALL draw a sheet page on the page canvas: a white background, the cell grid in light lines, column letters across the top, row numbers down the left, and each cell's text at its place (text runs on into empty cells to the right, as in Excel, and is cut at the next cell with text). Reading boxes, threads and page navigation (one page per sheet) work as on a text PDF page.

---

### Requirement 46 (MUST): A Customer Parts List Gives the HTS Number, Origin and MID From the Office's Own Rows

**User Story:** As an entry writer, I want to upload the importer's parts list once and have each invoice line's HTS number taken from the row with the same part code, so that I do not look up the number for every line of every entry, while the app still never chooses a number itself.

**Background:** Many foreign invoices print a part code but no US HTS number. Brokers keep, for each importer, a list of part codes with the HTS number, country of origin and manufacturer ID that the office decided earlier. The app copies these past decisions of the office; it does not choose a number.

#### Acceptance Criteria

1. THE upload panel SHALL have an optional input "Customer parts list (optional)" for one ".xlsx" or ".csv" file (the same file size limit and the sheet limits of Requirement 45.3, except that a list may have up to 2,000 rows and 20,000 cells with text; an .xlsx gives its first visible sheet; a CSV, read with the app's CSV parser after removing a byte order mark, is one sheet named after the file without its extension, at most 2,000 lines). The panel shows the accepted column names and a "Download blank template" link to `/templates/customer-parts-list.csv`, whose only line is `Part No,Description,HTS,Origin,MID`. The list is read by rules in the browser. It is never sent to the reader, adds no AI cost and does not count toward the three documents.
2. `readPartsList(sheet)` in `src/core/partsList.ts` SHALL take as header row the first of the first 20 rows that has a part code column and an HTS column. Header texts are compared without case, with spaces collapsed and a trailing ":" removed. Part code: "part no", "part no.", "part number", "part code", "item code", "item no", "item no.", "item number", "product code", "product number", "sku". Description: "description", "item description", "product description". HTS: "hts", "hts code", "hts number", "hts no", "hts no.", "us hts code", "htsus", "tariff number". Origin: "origin", "country of origin", "origin country", "coo". MID: "mid", "manufacturer id", "mid code". Without such a row the list is refused with "No header row with a part code column and an HTS column in the first 20 rows. Use the template's column names: Part No, Description, HTS, Origin, MID." Every later row with a part code is a list row. Its row number is the Excel row number (for a CSV, the line number).
3. WHEN a list is loaded, THE draft SHALL look, for each invoice line with an accepted item number (`invoice.lines.<n>.itemNo`), for list rows whose part code is exactly the same text after removing outer spaces; nothing else is changed, so "GPL 103" and "gpl-103" do not match "GPL-103". Only a single matching row is used. With two or more, the line's reason sentence is `Part code "<code>" of invoice line <n> is on <k> rows of the customer parts list (rows <r1>, <r2>), so the list was not used.` A row's HTS number is usable when `normalizeHts` accepts it, its origin when `countryCode` accepts it, its MID when it is 8 to 15 capital letters and digits that start with two letters.
4. HTS number (L<nnn>.33A), for an invoice line with one matching row and a usable HTS number in it:
   a. WHEN the invoice HTS number has no accepted reading, the list number SHALL be the line's HTS number: 33A, 35, 37A, 38 and the grouping of 7501 lines use it as they use a number read from the invoice (tariff table lookup; Requirement 38 when it is not in the table). 33A has the list cell as a source before the tariff source, and its note starts with `From the customer parts list row <r> (part code "<code>").`
   b. WHEN the invoice number is accepted and has the same 10 digits, 33A SHALL be as today with the list cell added as a source and the note starting with `The customer parts list row <r> (part code "<code>") gives the same number.`
   c. WHEN the invoice number is accepted and differs (or is not 10 digits), the invoice line SHALL get its own 7501 line, whose 33A is needsReview with no value, rule P15, the invoice reading and the list cell as sources and the reason `Invoice line <n> gives HTS <invoice text>, and the customer parts list row <r> (part code "<code>") gives <list number in entry form>. A person picks the number.` Its 35 and 37A wait with the reason `Waiting on L<nnn>.33A: the invoice and the customer parts list give different HTS numbers.`, and its 38 waits as it does when 37A has no value.
5. WHEN an invoice line has neither an accepted invoice HTS number nor a usable list number, 33A SHALL stay needsReview with today's reason, with one more sentence before " A person reads it on the invoice. The app does not choose a number.": `Part code "<code>" of invoice line <n> is not in the customer parts list.` when no row matches, the sentence of 46.3 for two or more rows, or `Customer parts list row <r> (part code "<code>") has no usable HTS number ("<text>").` When the invoice number is accepted, a missing or unusable row changes nothing.
6. Country of origin (L<nnn>.10), for an invoice line with one matching row and a usable origin in it: WHEN the invoice origin has no accepted reading, the list origin SHALL be used (copied, the list cell as source, note `From the customer parts list row <r> (part code "<code>").`); WHEN it is accepted and the same country, as today with the list cell added as a source and the note `The customer parts list row <r> (part code "<code>") gives the same country.`; WHEN it is accepted and differs, the invoice line gets its own 7501 line whose 10 is needsReview with no value, both sources and the reason `Invoice line <n> gives origin <invoice code>, and the customer parts list row <r> (part code "<code>") gives <list code>. A person picks the country of origin.` B10 follows the line values as today.
7. MID (B13): WHEN every invoice line that has a 7501 line has one matching row with a usable MID and all are the same, B13 SHALL be that MID, copied, with every MID cell used as a source and the note `From the customer parts list (one MID for every line).` Otherwise, WHEN at least one such line has a usable MID, B13 stays needsReview with today's reason followed by ` The customer parts list gives: invoice line <n> <MID or "none">; invoice line <n> <MID or "none">. A person checks the manufacturer of each line.` (every invoice line that has a 7501 line, in order) and the MID cells as sources.
8. A list source SHALL be a document source with `doc` "partsList", `page` 1, the cell text as quote, the cell's box on the drawn grid, `readingField` "partsList.rows.<r>.<column>" (column: partNo, hts, origin or mid) and `cell`. THE board SHALL show the list as one more document tab "Customer parts list: <file name>", draw it as a sheet page (Requirement 45.8) with a box on every list cell that a draft field uses, and draw threads to those boxes. A person's value for 33A, 10 or B13 replaces the list value as for any other value.
9. WITHOUT a list, and for the sample bundle, the draft SHALL be exactly as today; the sample CSV is unchanged.

---

### Requirement 47 (MUST): Port Codes and the Mode of Transport From Public CBP Code Tables

**User Story:** As an entry writer, I want Blocks 9, 19 and 20 filled from the bill of lading and CBP's own code tables, with Block 6 suggested, so that I do not look up the same port codes by hand for every entry, while every code still shows the table row it came from.

**Background:** B6, B19 and B20 were needsReview with "Schedule D code lookup not built" or "Schedule K code lookup not built" in every draft. The codes are in public CBP tables. The app now ships two tables extracted from the official CBP PDFs (U.S. government works, public domain per the CBP copyright notice): `data/codes/schedule-d.json` (CBP ACE Appendix E, Schedule D, edition 2026-02-03, 522 rows `[code, name]`) and `data/codes/schedule-k.json` (CBP ACE Appendix F, Schedule K, list of 2024-08-27 with the change table of 2026-08-20 applied for the changes up to 04/2026, 3,543 rows `[code, country, name, change]`). Each file names its source address, edition and extraction date. Block 6 can differ from Block 20 when the goods move in bond to an inland port, and the documents do not show that, so a person decides Block 6.

#### Acceptance Criteria

1. `src/core/codeTables.ts` SHALL import the two JSON files (as `page.tsx` imports the tariff table) and export `SCHEDULE_D`, `SCHEDULE_K`, `lookupUsPort(text)` and `lookupForeignPort(text)`. A new source kind `CodeTableSource = { kind: "codeTable"; table: "Schedule D" | "Schedule K"; edition: string; code: string; name: string; country: string | null }` joins `Source`. Its `edition` is "2026-02-03" for Schedule D and "2024-08-27, changes to 04/2026" for Schedule K. Texts are compared after normalizing: Unicode NFKD with accents removed, lower case, every run of characters other than a-z and 0-9 made one space, outer spaces removed.
2. `lookupUsPort(text)` SHALL split the text on commas (outer spaces removed, empty parts dropped), remove a leading "port of " from the first part, drop the last part when it is "US", "USA", "U.S.", "U.S.A.", "United States" or "United States of America", and then take the last part, without a 5-digit ZIP code, as the state when it is the two-letter postal code or the name of one of the 50 states, the District of Columbia, Puerto Rico, the U.S. Virgin Islands, Guam, American Samoa or the Northern Mariana Islands. The city is the part before the state, or the last part when there is no state. A Schedule D row is a port row when its name has exactly two comma parts "<city>, <state name>" and its city part has none of these words: airport, air, airfield, user fee, hub, fedex, ups, dhl, eccf, courier, region, border patrol, cartage, tracking, alternate. A port row matches when the city equals its whole city part or one of the pieces of its city part split on "/" and "-", and, when the text has a state, the row's state name is that state. Two groups always come together: Los Angeles and Long Beach, California (2704, 2709), and New York, New York and Newark, New Jersey (1001, 4601); a text whose city is Los Angeles or Long Beach in California, or New York in New York, or Newark, Port Newark, Elizabeth or Port Elizabeth in New Jersey, matches both rows of its group. The result is `{ kind: "one", row }` when all matching rows have one code, `{ kind: "several", rows }` (one row per code, in table order) when they have two or more, and `{ kind: "none" }` when no row matches.
3. `lookupForeignPort(text)` SHALL split the text on commas and take as the country the last one, two or three parts joined by ", " (tried in that order; the first that names a country wins, because "Bonaire, Sint Eustatius & Saba" and "Southern Asia, N.E.C." have commas) when, normalized, they are a Schedule K country name, that name without its part in brackets ("Madagascar" for "Madagascar (Malagasy)") when that is one country only, or one of these names: "viet nam" Vietnam; "china", "prc", "people s republic of china" China (Mainland); "taiwan" China (Taiwan); "korea", "republic of korea", "korea republic of", "korea south" South Korea; "uk", "united kingdom", "great britain", "england", "scotland", "wales" United Kingdom; "holland", "the netherlands" Netherlands; "burma", "myanmar" Burma (Myanmar); "ivory coast" Cote d'Ivoire; "russian federation" Russia; "turkiye" Turkey; "uae" United Arab Emirates; "macao" Macau; "trinidad and tobago" Trinidad. The port name is the text before those parts (the whole text when no country is named). A row's names are its name split on ";" and, unless the name starts with "All Other", on ",". The rows of the named country (all rows when no country is named) whose names include the port name match; when none match and the port name has a comma, its first part is tried. The result is `{ kind: "one", rows }` when the matching rows have one code, `{ kind: "several", rows }` when they have two or more, and `{ kind: "none", allOther }` otherwise, where `allOther` is the list of the named country's rows whose name starts with "All Other", in table order (empty when there is none or no country is named; 24 countries have more than one).
4. B20 (U.S. port of unlading) SHALL come from the accepted `billOfLading.portOfDischarge` reading with `lookupUsPort`:
   a. one row: computed, value the code, rule "7501 p.12, Schedule D", note `<code> is "<row name>" in Schedule D (CBP Appendix E, 2026-02-03).`, sources the reading and the code table row.
   b. several rows: needsReview with no value, the reading and every row as sources, `candidates` one per row (`{ value: code, label: "<code> <row name>" }`), and the reason `The bill of lading names "<reading value>". Schedule D has more than one code for it: <code> <row name>; <code> <row name>. A person picks the code.`
   c. no row: needsReview with no value, the reading as source, reason `The port of discharge "<reading value>" on the bill of lading is not a port in Schedule D (CBP Appendix E, 2026-02-03). A person looks up the code.`
   d. no accepted reading: needsReview, reason `The port of discharge was not read from the bill of lading. A person looks up the Schedule D code.`
   A value whose reading comes from an image page waits for a person as in Requirement 26.
5. B6 (port code) SHALL always be needsReview, with input B20. When B20 has one row: value the B20 code, the same sources and one candidate, reason `Block 6 is the port where the entry is filed. It is the port of unlading (Block 20) unless the goods moved in bond to another port, so the Block 20 code is suggested. A person confirms it or enters the port of entry.` When B20 has several rows: no value, the same sources and candidates, reason `Block 6 is the port where the entry is filed. Schedule D has more than one code for the port of discharge, so a person picks it.` Otherwise: no value, reason `Block 6 is the port where the entry is filed. The port of discharge gave no Schedule D code, so a person enters it.`
6. B19 (foreign port of lading) SHALL come from the accepted `billOfLading.portOfLoading` reading with `lookupForeignPort`. The table date words are `Schedule K (CBP Appendix F list of 2024-08-27 with the changes to 04/2026 from the table of 2026-08-20; later Army Corps updates not included)`.
   a. one code: computed, value the code, rule "7501 p.11, Schedule K", note `<code> is "<row name>" (<country>) in <table date words>.`, sources the reading and the matching rows.
   b. several codes: needsReview with no value, candidates one per code (`"<code> <row name> (<country>)"`), the reading and the rows as sources, reason `The bill of lading names "<reading value>". <table date words> has more than one code for it: <code> <row name> (<country>); ... A person picks the code.`
   c. no code: needsReview with no value, the reading as source, reason `The port of loading "<reading value>" on the bill of lading is not in <table date words>. A person looks up the code.`; when `allOther` is not empty, its rows are candidates (`"<code> <row name> (<country>)"`) and sources, and the reason goes on ` The 7501 instructions use the country's "All Other" code (<code>, <code>) when the bill of lading names no port; a person decides whether it applies here.`
   d. no accepted reading: needsReview, reason `The port of loading was not read from the bill of lading. A person looks up the Schedule K code.`
7. B9 (mode of transport) SHALL follow the 7501 code table (p.8; 10 is a vessel, not containerized, and is used for a vessel when it is not known whether the goods were containerized). This replaces the not-read case of Requirement 44.3:
   a. accepted container number: as today ("11", computed, rule "7501 p.8", note "Vessel, containerized: the B/L lists a container.", the container reading as source).
   b. no container number reading, or one rejected only because its value is missing (`value_missing`), and an accepted `billOfLading.vessel` reading: "10", computed, rule "7501 p.8", note "Vessel, not containerized: no container number was read on the bill of lading. The 7501 instructions use 10 for a vessel when it is not known whether the goods were containerized.", the vessel reading as source.
   c. a container number reading rejected for any other reason, or not sure: as Requirement 44.3 (needsReview, no value, the same reason).
   d. no container number reading and no accepted vessel reading: needsReview, no value, reason "No vessel and no container number were read from the bill of lading, so the mode of transport is not known. A person checks the transport document."
8. `DraftField` SHALL get an optional `candidates: { value: string; label: string }[]`. For a needsReview field with candidates, the source strip shows one button per candidate (`data-testid="candidate-<value>"`, text `Use <label>`) that applies the value as a person's value, as "Use this value" does. The CSV columns do not change.
9. A code table source SHALL show in the source strip as `<table> (<edition>): <code> <name>` followed by `, <country>` when it has a country, with the grey border of a tariff source, and in the CSV as `<table> <edition> <code> "<name>"` with `, <country>` inside the quotes when it has a country. Tariff and document sources are unchanged.
10. Requirement 15 is updated: with the tables, the sample's B19 is computed ("55201", Haiphong, Vietnam), B20 waits with the candidates 2704 and 2709 (the sample's bill of lading says "Los Angeles, CA, USA"), B6 waits with the same candidates, and B13 follows Requirement 48. So in 15.2 the Needs review list goes from 20 to 16 items, and in 15.3 the CSV is byte-identical to the CSV of the board with Requirements 47 and 48; the verifier records its fingerprint.

---

### Requirement 48 (MUST): Block 13 MID Suggested by the Appendix 2 Rule

**User Story:** As an entry writer, I want the manufacturer ID built from the invoice issuer's name and address by the CBP rule and shown with every part it came from, so that I check and confirm a code instead of building it by hand, and the app still never decides who the manufacturer is.

**Background:** B13 was needsReview with "Invoice names a trading company; manufacturer per line not in bundle." in every draft. The MID rule of the 7501 instructions (Appendix 2, steering P14) builds the code from the manufacturer's name and address. The invoice issuer is the manufacturer or the direct supplier for most goods, but the MID names the manufacturer, and for textiles it must be the actual manufacturer (19 CFR 102.23), so a person always confirms it. Which leading words are generic company words is a person's decision (steering P14).

#### Acceptance Criteria

1. `src/core/mid.ts` SHALL export `midFromParts({ name, street, city, country, province })` (street may be empty; country an ISO 3166 two-letter code; province a Canadian province code or name, or null) giving `{ ok: true, value, parts: { country, name, number, city }, genericPrefix, withoutGeneric, notes }` or `{ ok: false, reason }`, `splitIssuerAddress(address)` giving `{ street, city, countryCode, province }`, and `suggestMid({ name, address, origin })`.
2. Name part (steering P14), in this order: upper case; a hyphen with or without spaces around it joins its two sides; commas, apostrophes and ampersands are removed; the text is split on spaces; a token of single letters separated by periods ("E.K.", "S.P.A.", "O.A.S.I.S.") becomes those letters ("EK", "SPA", "OASIS") and other periods are removed; two or more single-letter tokens in a row become one word ("A B C" gives "ABC"), and a single-letter token alone is dropped; then the words A, AN, AND, OF and THE are dropped. The part is the first three characters of the first word and of the second word (one word: its first three characters).
3. Generic leading words SHALL NOT be dropped by the app. When the words start with PT, CV, JSC, OAO, OOO, ZAO, PJSC, COMPANHIA, COMPANIA, COMPAGNIE, SOCIETE, SOCIEDAD, SOCIETA, or with FABRICA DE ARTIGOS DE VESTUARIO, `genericPrefix` is those words as printed upper case. For PT, JSC, OAO, OOO, ZAO and FABRICA DE ARTIGOS DE VESTUARIO, the words that Appendix 2 itself names, `withoutGeneric` is the MID built without them; otherwise it is null.
4. Number part: in the street text, every run of digits joined only by "," or "-" (no space) is one number with the punctuation removed ("12,34,56" gives 123456, "2-6," gives 26, "8-Chome" gives 8); the part is the first four digits of the largest number (more digits is larger); a street without digits gives an empty part.
5. City part: accents removed, digits removed, upper case, the words A, AN, AND, OF, THE dropped, then the first three letters A to Z. For Hong Kong (HK), Singapore (SG) and Macau (MO) the city part comes from the country name (HON, SIN, MAC), with the note `<country name> is a city-state, so the city part comes from the country name.`
6. Country part: the country code; for Canada (CA) the province code of steering P14 (Ontario or ON gives XO), and without a province `{ ok: false, reason: "A Canadian MID starts with the province code, and the province was not found in the address." }`. With an empty name part or city part: `{ ok: false, reason: "The invoice issuer's name or city gives no letters for the MID." }`. The value is country + name + number + city and is at most 15 characters.
7. `splitIssuerAddress(address)` SHALL split on commas (outer spaces removed, empty parts dropped). When the last part, without its words that contain a digit, is a country name (at least the countries of the 7501 examples and the test documents: France, Venezuela, England, Scotland, Wales, United Kingdom, Great Britain, Australia, Japan, Italy, Greece, Portugal, Canada, Macau, Macao, Hong Kong, Singapore, Vietnam, Viet Nam, China, Taiwan, South Korea, Korea, India, Indonesia, Thailand, Malaysia, Philippines, Mexico, Germany, Spain, Netherlands, Czechia, Czech Republic, Turkey, United States, USA, US) it gives `countryCode` and is removed. Then, when the last part without such words is a US state or a Canadian province (postal code or name), it is removed and gives `province` (and the country US or CA when no country was named). For HK, SG and MO the city is the country name and every part left is the street. Otherwise the city is the last part left, without its words that contain a digit, and the street is the parts before it joined by ", ". With no part left for the city, city is null.
8. `suggestMid({ name, address, origin })` SHALL build the MID with `midFromParts` from `splitIssuerAddress(address)` and the origin as country, and add the note `The goods come from <origin> but the invoice issuer's address is in <countryCode>; the MID starts with the country of origin.` when the address names another country.
9. B13 SHALL be built after the 7501 lines, where the customer parts list rule of Requirement 46 runs; when that rule sets B13 it wins. Otherwise B13 is needsReview, with the accepted `invoice.seller.name` and `invoice.seller.address` readings as sources, input B10, rule "7501 Appendix 2", and:
   a. no accepted name or address: no value, reason `The invoice issuer's name or address was not read, so no MID is suggested. A person enters the manufacturer's MID.`
   b. a line whose 10 has no value: no value, reason `The country of origin of a line is not known, so the first two letters of the MID are not known. A person enters the MID.`
   c. every line's 10 is one code: value the MID of `suggestMid`, candidates the MID and, when `withoutGeneric` is not null, `withoutGeneric` (label `<MID> without "<genericPrefix>"`), note `<country> + <name> + <number> + <city> from "<name reading>" and "<address reading>".` followed by the city-state note when there is one, reason `Suggested from the invoice issuer's name and address by the MID rule of the 7501 instructions (Appendix 2). The MID names the manufacturer: a person checks that the invoice issuer made the goods or sold them directly, and confirms.`, followed by each that applies: ` The name starts with "<genericPrefix>", a word for a kind of company. Appendix 2 leaves out some such words; a person decides whether to leave it out.`, the note of 48.8, and ` Textile goods (chapters 50 to 63): the MID must be the actual manufacturer's (19 CFR 102.23), not a trading company's.` when a line's 33A value starts with 50 to 63.
   d. lines with two or more origin codes: no value, reason `The lines come from more than one country, so the MID differs by line: <MID> for line <nnn>, <nnn>; <MID> for line <nnn>. A person enters MULTI and the MID of each line.` (7501 line numbers, origins in order of their first line).
   e. `midFromParts` not ok: no value, its reason.
10. Of the 13 official examples of Appendix 2 and 19 CFR Part 102 (steering P14 and the research table), the rule SHALL give the official MID for 11 (the Hong Kong one through the city-state rule). For "COMPANHIA TEXTIL KARSTEN" it gives PTCOMTEX2527LIS with `genericPrefix` "COMPANHIA" (the official PTKAR2527LIS drops two words, a person's decision), and for "Fabrica de Artigos de Vestuario TOP JOB" it gives MOFABDE24MAC with `withoutGeneric` MOTOPJOB24MAC, the official one.

---

### Requirement 49 (MUST): The Board Draws Only the Active Documents, and a Sheet Is Not Cut

**User Story:** As an entry writer, I want the board to show the sample's own readings the moment I go back to it, and every cell text of an Excel page, so that nothing on the screen is wrong even for a second.

**Background:** After an upload, "Back to sample" showed for about a second all 11 bill of lading readings of the sample rejected with "quote is not on billOfLading page 1" and no boxes: the sample readings were checked against the uploaded pages until the sample PDFs had loaded. On an Excel page, text that runs on to the right of the last column (row 1 "DEMO / FICTITIOUS ...") was cut at the right edge of the page.

#### Acceptance Criteria

1. THE board SHALL build the draft only from documents loaded for the active source. When "Back to sample" is clicked or an upload is loaded, the documents of the previous source are cleared at once and the loading state shows until the documents of the new source are ready; no reading is ever checked against a page of the other source.
2. A sheet page SHALL be drawn wide enough for the text that runs on past its last column, so no text is cut at the right edge. The page text, the boxes in page units and the page size sent to the reader do not change.

---

### Requirement 50 (MUST): A Value Read From an Image Line That Is Not in the Transcript Waits for a Person

**User Story:** As an entry writer, I want a value the AI reader read from a photo to come to me for a check, with no box, when the reader left that line out of its transcript, so that a right value is not thrown away and I only confirm it instead of typing it.

**Background:** In a real read of test bundle C (photos of the invoice and of the packing list), the AI reader read all 77 values right but gave transcripts of only 6 and 5 lines for pages of 27 and 23 printed rows. `verifyReadings` rejected 58 right values with "quote_not_found", because the page text of an image page is the reader's own transcript; the board then had 47 values for a person to type. On an image page this check only compares the reader with itself. On a text page (PDF text layer or a sheet) the page text does not come from the reader, so the check keeps its meaning there.

#### Acceptance Criteria

1. WHEN the page of a reading has origin "imageTranscript" and its quote (spaces normalized) does not occur in the page text, `verifyReadings` SHALL NOT reject it with "quote_not_found", except as 50.8 says. WHEN its value (spaces normalized) is inside its quote, or the field is `invoice.date` or `billOfLading.onBoardDate` and the date rule of Requirement 35.1 holds for the value and the quote, the reading SHALL get status "uncertain" with `box: null`, `itemIds: []`, origin "imageTranscript", `notInTranscript: true`, no `lineText`, no `cell`, and the message `NOT_IN_TRANSCRIPT_MESSAGE` = "The AI reader read this value from a line that is not in its transcript of the image, so there is no box on the page. A person finds it on the page and checks it." Otherwise it is rejected with "value_not_in_quote" and today's message. The checks before the quote search (document, page, value missing, empty quote) come first as today. This holds for any confidence. Example: bundle C, `invoice.lines.1.description` "Paper lantern, bat print" with the same quote, not in the 6-line transcript: "uncertain", no box; `invoice.seller.address` "Lot 9, Fernlight Industrial Cluster Viet Nam" with the quote "Lot 9, Fernlight Industrial Cluster": rejected with "value_not_in_quote".
2. ON a text page (a PDF text layer or a sheet), a quote that is not on the page SHALL still be rejected with "quote_not_found". On an image page, a quote found in the transcript once or more is checked as today; a value on a line with no box follows Requirement 58.1.
3. THE draft SHALL use a reading with `notInTranscript: true` whose confidence is not "low" like an accepted reading of an image page (Requirements 18.1, 26.1, 26.3 and 30.1): its value goes into every field and check that an accepted reading would reach, and no field built from it is final before a person confirms it. Where Requirement 18.1 or 26.1 gives a field `IMAGE_REVIEW_REASON` or `IMAGE_COMPUTED_REVIEW_REASON` and one of its document sources has `notInTranscript: true`, the field SHALL get instead `UNPLACED_REVIEW_REASON` = "Read from an image by the AI reader, from a line that is not in its transcript, so there is no box on the page. Find it on the page, check it, then confirm it." or `UNPLACED_COMPUTED_REVIEW_REASON` = "Computed from values the AI reader read from an image. At least one is from a line that is not in its transcript, so it has no box on the page. Check them against the page, then confirm it." A field that waits on such a field waits as Requirement 26.3 says. The document source made from such a reading has `box: null` and `notInTranscript: true`. A reading with `notInTranscript: true` and confidence "low" is an "uncertain" reading of Requirement 36 (36.2 and 36.3 apply; its document source has `box: null` and `notInTranscript: true`).
4. THE two reasons of 50.3 SHALL work everywhere the two image reasons work: the "Confirm this value" button, a person's value equal to the shown value (status "copied" or "computed" with `CONFIRMED_NOTE`, Requirements 18.3 and 26.2), the image rule after a person's edit (30.1), the waiting pass (26.3) and the rule for 38 (32.2). Any other person's value is handled as today.
5. THE draft's `rejectedReadings` SHALL NOT list a reading that the draft uses by 50.3; a reading of 50.3 with confidence "low" is listed as other "uncertain" readings are.
6. THE board SHALL draw no box and no thread end for a reading or a document source with no box. It lists the page's readings with `notInTranscript: true` in the "uncertain-readings" block, each with `data-testid` "uncertain-reading-<field>" and `data-not-in-transcript` "true": the field name, the value in quotes, and "not in the AI reader's transcript, so no box; a person finds it on the page and confirms it". The source strip of such a source reads `<document label> p.<n>: "<quote>" (read from an image by the AI reader) Not in its transcript, so there is no box on the page.` The CSV source of such a source is `<doc> p.<page> [no box] "<quote>" (read from an image by the AI reader) (not in its transcript)`.
7. THE sample bundle with or without the demo answers, the upload test recordings, the verifier's expected drafts and the recorded real answers of bundles A and B keep every reading status and every draft field: their image quotes are in the transcripts or are rejected for another reason. (Requirements 58.7 and 60.4 name the readings of the recorded read of bundle B that change.)
8. ON an image page, WHEN a quote is not in the page text and the value occurs in it with a non-empty part of the quote before it and a non-empty part after it, and the part before, one space and the part after (spaces normalized) occur in the page text, the reader's own transcript has that line without the value. `verifyReadings` SHALL reject the reading with "quote_not_found" and today's message, before the rule of 50.1 and whatever its confidence. A value at the start or the end of its quote, and a date that is not written inside its quote, are not checked this way. Example: the sample bundle with every page an image page (Requirement 30.4 and Property 35), `invoice.lines.7.origin` "CN" with the quote "LH-107 Resin raven figurine, 18 cm 3926.40.0090 CN 90 PCS 5.40 486.00": the page has "LH-107 Resin raven figurine, 18 cm 3926.40.0090 90 PCS 5.40 486.00", so the reading is rejected as on the text page, and confirming every image value still gives the text-page draft. None of the 57 values of bundle C in 50.1 is such a reading.
9. Two older examples follow 50.1: in Requirement 36.1, a low reading whose quote is not on an image page waits as 50.1 says, and on a text page it is still rejected with "quote_not_found" before its confidence counts; in Property 28, a quote that is not on an image page, with a value not inside it, is rejected with "value_not_in_quote".

---

### Requirement 51 (MUST): The Reader Writes the Transcripts First and Counts the Packing List Lines

**User Story:** As an entry writer, I want the AI reader to write a photo's lines before it quotes them, and to say how many item lines the packing list has, so that a value is not lost for a short transcript and I know when lines were left out.

**Background:** The output schema asks for "fields" before "transcripts", and structured outputs keep the schema's order of required properties. In bundle C the reader wrote its 74 fields first and then short transcripts; only 5 of its 63 quotes on image pages were in its own transcripts (bundle A: 43 of 43). In bundle B it gave only line 1 of an Excel packing list of 6 item lines (the net weight column is in pounds), and nothing told the app that lines were left out.

#### Acceptance Criteria

1. THE output schema SHALL list its properties in the order "transcripts", "fields", "invoiceLineCount", "packingListLineCount", every one required, so that the reader writes the transcripts before the fields. The schema sent in a request keeps this order.
2. THE system prompt SHALL have, in place of today's transcript paragraph, the paragraph: `For every image page add one transcript, before the fields: every printed line in reading order, one table row per line, each as {"t": the line text, "b": [x, y, w, h]} where x, y, w and h are whole numbers from 0 to 1000 in thousandths of the page width and height, origin top-left. A quote for an image page must be copied from one of your transcript lines, so put every line you quote in the transcript. Text pages get no transcript.`
3. THE system prompt SHALL have, after the "invoiceLineCount" paragraph, the paragraphs: `Give every item row of a packing list as packingList.lines.<n> fields in printed order. When one value of a row cannot be given as asked (for example a weight printed in pounds, LB or LBS, for a kg field), leave out only that field and give the other fields of the row; never convert a unit.` and `Set "packingListLineCount" to the number of item lines printed on the packing list, counting lines whose fields you leave out; use null when no packing list is given.`
4. "packingListLineCount" SHALL follow Requirement 19.2 for "invoiceLineCount": integer or null in the schema; the output validator accepts it absent (older recordings) and otherwise requires null or an integer from 0 to 999 (reason "packingListLineCount: must be null or an integer from 0 to 999"); `readerOutputToAnswer` copies it into the reading answer (optional `packingListLineCount`), `validateReadingAnswer` checks it as it checks `invoiceLineCount`, and the board passes it to `buildDraft` (optional input `packingListLineCount`).
5. WHEN `packingListLineCount` is a number, the draft SHALL add the check "P3.packing.lines" (rule "P3", label "Packing list lines read"): with m the number of packing list lines n from 1 to 8 that have at least one reading of a field `packingList.lines.<n>.*` (any status), ok is true when the count equals m and the detail is "the packing list shows <count> item lines and the draft has readings for <m>"; else ok is false and the detail is "the packing list shows <count> item lines, but the draft has readings for <m>". When the count is more than 8, the detail ends with "; this draft reads only the first 8". With no count (null or absent) the checks are as today.
6. `max_tokens`, the cost line of one call, the input token estimate, the bounds of the output room, the caps, the model and thinking off SHALL stay as they are. The fake reader and its recordings stay as they are (they have no `packingListLineCount`).

---

### Requirement 52 (MUST): Every Country Name and Code, and the Printed Date Forms, Reach the Draft

**User Story:** As an entry writer, I want an accepted country name or code and an accepted printed date to fill their blocks, so that a right value does not wait only because the app does not know its form.

**Background:** In bundle B, B14 waited with "Country not recognized: "Germany"" and B15 with "Invalid date format: "12-NOV-2026"" although both readings were accepted, and L001.10 said that the accepted origin "DE" was "rejected" because its quote was not on the page: `countryCode` knew only VN, PT, CZ, CN and US, and the draft read only MM/DD/YYYY dates, while the quote check of Requirement 35.1 reads the printed date forms.

#### Acceptance Criteria

1. `countryCode` SHALL accept, case-insensitively and with spaces normalized, each of the 249 officially assigned ISO 3166-1 alpha-2 codes and each name that the table `data/codes/iso-3166-1.json` lists for it (the CLDR English name, the CLDR short name where there is one, and the listed aliases), and give the two-letter code. VIETNAM, VIET NAM, PORTUGAL, CZECHIA, CZECH REPUBLIC, CHINA, USA and UNITED STATES still give VN, PT, CZ, CN, US. Text that is not in the table is refused with "Unknown country" as today.
2. THE draft SHALL read the B15 value with `parseDocumentDate`: a value that `parseUsDate` accepts gives what it gives today; else, when the whole value (spaces normalized) is one printed date of Requirement 35.1 ("D Mon YYYY", "D-Mon-YYYY" such as "12-NOV-2026", "Mon D, YYYY", "Month D, YYYY", "YYYY-MM-DD", "DD.MM.YYYY"), the date as MM/DD/YYYY; else the reason of `parseUsDate`. The quote check and `parseDocumentDate` SHALL use one function for the printed date forms (`findPrintedDates`, moved to `parse.ts`).
3. IN the reason of L<nnn>.10, the part for an invoice line whose origin reading is accepted but not a country that `countryCode` knows SHALL read `Invoice line <n>: the AI reader read "<v>", which is not a country name or code the app knows. A person checks it on the invoice.` (today it says that the quote is not on the page and that the reading was rejected).
4. THE sample bundle with or without the demo answers and the verifier's expected drafts SHALL be unchanged.

---

### Requirement 53 (MUST): The Page Comes First, and the Lists of Readings Stay Below It

**User Story:** As an entry writer, I want to see the photo of a page even when many of its readings were not used, so that I can check the values against it.

**Background:** On the photo of the bundle C invoice, the list of 39 rejected readings filled the documents pane and the photo could not be seen.

#### Acceptance Criteria

1. THE "uncertain-readings" and "rejected-readings" blocks SHALL be in one block below the page view, with `data-testid` "reading-lists", at most 30% of the documents pane high and scrolling inside itself. The page view SHALL keep the rest of the pane's height. On the bundle C invoice photo with 39 readings in the lists, the page image is in view and at least half of the documents pane is the page view.
2. EACH list keeps its `data-testid`, its entries and its words.

---

### Requirement 54 (MUST): A Usage Record Is Written Without a Condition, So a Write Sent Again Is Counted Once

**User Story:** As an operator, I want each paid call to leave exactly one usage record or one log line, so that counting the records plus the log lines never counts a call twice.

**Background:** The record was written with `onlyIfNew`. When the store saved the record and then answered 503 or lost the connection, the library sent the same PUT again, got 412 and returned `{ modified: false }`, so the server logged "usage record not written" for a record that was saved: 1 record and 1 log line for one call (agy cross-check 3, R14). A record PUT answered 200 without an ETag also counted as not written.

#### Acceptance Criteria

1. `createBlobsUsageStore().appendRecord` SHALL write the record with `setJSON(key, record)` and no condition (no `onlyIfNew`, no `onlyIfMatch`). The key is new for every call (`usage/<the digits of the timestamp>-<a random UUID>`), so a PUT that the library sends again after a 5xx or a lost connection lands on the same record. IT SHALL count the record as saved WHEN `setJSON` resolves with `modified: true`, with or without an `etag` (for a PUT without a condition the installed `@netlify/blobs` resolves only for status 200 and throws for every other status after its retries). WHEN `setJSON` resolves with `modified: false` or throws, it SHALL throw "usage record write was not confirmed by the store; not written".
2. Through the installed library, as on Netlify (`createBlobsUsageStore()` with the Blobs context and `fetch`): a record PUT that the store saves and then answers 503, or saves and then loses the connection, SHALL leave 1 record and no "usage record not written" line; a record PUT answered 200 without an ETag SHALL leave 1 record and no line; a record PUT answered 403, 503 on every try, or 503 with an ETag on every try SHALL leave no record and 1 line (Requirement 41.2), also for a cap-exceeded record. The cap state writes keep `onlyIfNew` and `onlyIfMatch` as today.

---

### Requirement 55 (MUST): The Store Writes After the Reader Stop in Time

**User Story:** As an operator, I want the request to answer within the time limit of the function even when the store stops answering right after the reader, so that the person gets the answer and a record or a log line is left.

**Background:** After the reader the server topped up the ledger and then wrote the record. When the store answered only 503 right after the reader, the library waited 5 s five times for each write, so the server held the request 50 s after the reader (25 s without a top-up). With the 45 s reader time limit this is past the 60 s limit of a Netlify synchronous function: the person lost the answer and neither the record nor a log line was left (agy cross-check 3, R16).

#### Acceptance Criteria

1. AFTER the reader returns or throws in claude mode, THE server SHALL write the record first and then do the top-up of Requirement 24.3.
2. THE store calls after the reader (the record, and every read and write of the top-up) SHALL end by `intakeConfig.postReadStoreMs` (10,000 ms) after the reader returned or threw. Each store call waits at most for the time that is left; a store call that is still running then counts as failed and the server does not wait for it; a top-up try does not start when no time is left. A record that is not saved in that time gives the line of Requirement 41.2; a top-up that is not written in that time gives "usage cost top-up not written". A write that the store finishes after that time may still be saved; the count is then one too many, never short. The answer to the person does not change. `ReadDeps.postReadStoreMs?: number` (default `intakeConfig.postReadStoreMs`) sets the time, so tests do not wait. The reader time limit (`readerTimeoutMs`, 45,000 ms) and every other limit stay as they are.
3. With the installed library and its 5 s waits, a store that answers only 503 right after the reader SHALL hold the request at most `postReadStoreMs` plus 1 s after the reader, with a top-up and without one, and leave the record line and, with a top-up, the top-up line.

---

### Requirement 56 (MUST): A Usage the Call Cannot Have, and an Answer Without Usage, Are Recorded at the Reserved Worst Case

**User Story:** As an operator, I want a token count that no call can have, or an answer without a usage block, to leave a record at the reserved worst case without moving the ledger, so that one strange answer cannot close the budget or break the ledger.

**Background:** A safe integer token count was used as it came: 1,000,000,000,000 input tokens added 500,000 USD to the ledger (the next request got 429), and 9,000,000,000,000,000 made the ledger larger than a safe integer (every later request got 503) (agy cross-check 3, R17). An SDK answer without `usage`, with `usage: null`, or with `content` that is not a list made the reader throw a TypeError, so the record had no cost (R18).

#### Acceptance Criteria

1. A reported usage SHALL count as one the call can have only WHEN `inputTokens` and `outputTokens` are non-negative safe integers, `outputTokens` is at most the output room of the call (`estimateReaderCall(input).outputTokens`, the `max_tokens` the request sends), and `inputTokens + outputTokens` is at most `intakeConfig.readerContextWindowTokens` (1,000,000, the context window of Claude Haiku 5.5). Any other usage SHALL be handled as Requirement 41.3 says: no throw, the record has `inputTokens: null`, `outputTokens: null` and the reserved worst case as its cost, the ledger gets no top-up, and the answer is the one for that outcome. A usage the call can have is recorded and topped up as today (Requirement 24.3).
2. AFTER the SDK answered, `createClaudeReader` SHALL throw nothing but a `ReaderError`. It SHALL read `input_tokens` and `output_tokens` only WHEN `usage` is an object, and only a count that is a number; any other count is null in the reader's usage (`ReaderUsage` counts are `number | null`), so the record gets the reserved worst case (56.1, 41.3). WHEN the answer is not an object or its `content` is not a list, THE reader SHALL throw `ReaderError("The AI reader returned no answer.", usage)`. Every other answer is handled as today.

---

### Requirement 57 (MUST): The Chapter 99 Reason Says "See" Once

**User Story:** As a licensed person, I want the Chapter 99 reason to read as one sentence, so that the draft does not look careless.

**Background:** The reason was `See ${footnotes}. A person enters …`, and the tariff footnote already reads "See 9903.90.08.", so the sample's L005.ch99 said "See See 9903.90.08.. A person enters the additional duty (0.00 if none)."

#### Acceptance Criteria

1. `chapter99Reason(footnotes: string[]): string`, exported from `draft.ts` and `src/core/index.ts` and used for every L<nnn>.ch99 field, SHALL trim each footnote, remove its trailing periods and a leading "See" (any case) with the spaces after it, put "See " before it, join the footnotes with "; ", end them with one period and add " A person enters the additional duty (0.00 if none)." Examples: ["See 9903.90.08."] gives "See 9903.90.08. A person enters the additional duty (0.00 if none)."; ["9903.88.15", "See 9903.01.25."] gives "See 9903.88.15; See 9903.01.25. A person enters the additional duty (0.00 if none)."
2. In the sample draft only the reason of L005.ch99 changes: in the CSV without the demo answers its "reason" cell, with the demo answers its "note" cell ("Entered by a person. Before: …"), and nothing else. The sample CSV fingerprints of Requirement 4.5 become 4276d1db29164275a6221adbfc284ba8c240ae1b75adea5ce1388c730a16f803 (without the demo answers) and 3312056aa79544807eeea352444ec1105bfe59e39dfe2ae8885ba75243c674a3 (with them).

---

### Requirement 58 (MUST): A Value on a Transcript Line With No Usable Place Waits for a Person

**User Story:** As an entry writer, I want a value that the AI reader read from a line of a photo or scan that it gave no usable place for to come to me for a check, with no box, so that a right value is not thrown away only because the box of its line is missing.

**Background:** In the fourth real read of bundle A (2026-11-26), the AI reader gave 8 of the 16 transcript lines of the scanned packing list no box (`b` null), among them the five item rows and the total row. `verifyReadings` rejected the 28 values read from those lines with "no_source_box" (Requirement 37.3), all of them right, while a value whose line is not in the transcript at all waits for a person (Requirement 50.1). So the board showed no packing list line, and the checks P3.qty.MCA-102 to MCA-105 said "packing list line 1, 2, 3, 4, 5 not fully read". In bundle B the scanned bill of lading had the same for the port of discharge and the gross weight.

#### Acceptance Criteria

1. WHEN the page of a reading has origin "imageTranscript" and `verifyReadings` would take the reading's box from items of which at least one has no box (`noBox`, Requirement 37.2), THE reading SHALL NOT be rejected with "no_source_box". It SHALL get status "uncertain" with `box: null`, `itemIds: []`, origin "imageTranscript", `lineWithoutBox: true`, `lineText` = the texts of those items joined with " " (as Requirement 39.1 says for a box), no `notInTranscript`, no `cell`, and the message `LINE_WITHOUT_BOX_MESSAGE` = "The AI reader read this value from a line of its transcript that it gave no usable place for, so there is no box on the page. A person finds it on the page and checks it." Every check before it (document, page, value missing, empty quote, the quote search, the value inside the quote) comes first as today. This holds for any confidence.
2. A value that no item lines up with ("The value was found, but no line on the page lines up with it, so there is nothing to point to.") is still rejected with "no_source_box". A text page (a PDF text layer or a sheet) has no item without a box, so nothing changes there.
3. THE draft SHALL use a reading with `lineWithoutBox: true` whose confidence is not "low" as Requirement 50.3 uses a reading with `notInTranscript: true`: its value goes into every field and check that an accepted reading of an image page would reach, and no field built from it is final before a person confirms it. Where Requirement 18.1, 26.1 or 30.1 gives a field `IMAGE_REVIEW_REASON` or `IMAGE_COMPUTED_REVIEW_REASON`, one of its document sources has `lineWithoutBox: true` and none has `notInTranscript: true`, the field SHALL get instead `LINE_WITHOUT_BOX_REVIEW_REASON` = "Read from an image by the AI reader, from a transcript line it gave no usable place for, so there is no box on the page. Find it on the page, check it, then confirm it." or `LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON` = "Computed from values the AI reader read from an image. At least one is from a transcript line it gave no usable place for, so it has no box on the page. Check them against the page, then confirm it." With a `notInTranscript` source too, the reasons of 50.3 stay. A field that waits on such a field waits as Requirement 26.3 says. The document source made from such a reading has `box: null` and `lineWithoutBox: true`. A reading with `lineWithoutBox: true` and confidence "low" is an "uncertain" reading of Requirement 36 (36.2 and 36.3 apply; its document source has `box: null` and `lineWithoutBox: true`).
4. THE two reasons of 58.3 SHALL work everywhere the reasons of 50.3 work (Requirement 50.4): `isImageReviewReason`, the "Confirm this value" button, a person's value equal to the shown value (status "copied" or "computed" with `CONFIRMED_NOTE`), the image rule after a person's edit (30.1), the waiting pass (26.3) and the rule for 38 (32.2). Any other person's value is handled as today.
5. THE draft's `rejectedReadings` SHALL NOT list a reading that the draft uses by 58.3; such a reading with confidence "low" is listed as other "uncertain" readings are.
6. THE board SHALL draw no box and no thread end for such a reading or source (as 50.6 says). It lists the page's readings with `lineWithoutBox: true` in the "uncertain-readings" block, each with `data-testid` "uncertain-reading-<field>" and `data-line-without-box` "true": the field name, the value in quotes, and `on a transcript line with no usable place, so no box; a person finds it on the page and confirms it. Its transcript line: "<lineText>"`. The source strip of such a source reads `<document label> p.<n>: "<quote>" (read from an image by the AI reader) Its transcript line has no usable place, so there is no box on the page. Its transcript line: "<lineText>"`. The CSV source of such a source is `<doc> p.<page> [no box] "<quote>" (read from an image by the AI reader) (transcript line with no place)`.
7. Examples on the recorded real reads: the image part of the read of bundle A of 2026-11-26 (`samples/real-reads/test-bundle-a.json`, the scanned packing list and the photo of the bill of lading): the 28 readings of packing list lines 1 to 5 and of the four totals are "uncertain" with `lineWithoutBox` (26 of confidence high; 2 low: `packingList.lines.5.itemNo` and `packingList.totalQuantity`), and no reading is rejected with "no_source_box"; with the readings of the invoice text PDF the checks P3.qty.MCA-102, MCA-103 and MCA-104 are true. Bundle B (both recorded reads): `billOfLading.portOfDischarge` and `billOfLading.grossKg` of the scanned bill of lading are "uncertain" with `lineWithoutBox`, and B20 shows "1601" with `LINE_WITHOUT_BOX_COMPUTED_REVIEW_REASON`. The sample bundle (no image pages), the upload test recordings (every transcript line has a box) and the recorded reads of bundle C keep every reading status.

---

### Requirement 59 (MUST): A Number Written Without Its Thousands Commas Is Inside Its Quote

**User Story:** As an entry writer, I want "1284.0" read from "1,284.0 KGS" to count as the printed number, so that the weight difference between the packing list and the bill of lading is shown instead of a rejected reading.

**Background:** In the fourth real read of bundle A, the reader wrote `billOfLading.grossKg` as "1284.0" with the quote "1,284.0 KGS" (the read before wrote "1,284.0"). `verifyReadings` rejected it with "value_not_in_quote", so the 34A fields did not name the bill of lading weight.

#### Acceptance Criteria

1. THE number fields are `invoice.lines.<n>.quantity`, `invoice.lines.<n>.unitPrice`, `invoice.lines.<n>.amount`, `invoice.subtotal`, `invoice.total`, `packingList.lines.<n>.cartons`, `packingList.lines.<n>.quantity`, `packingList.lines.<n>.netKg`, `packingList.lines.<n>.grossKg`, `packingList.totalCartons`, `packingList.totalQuantity`, `packingList.totalNetKg`, `packingList.totalGrossKg` and `billOfLading.grossKg`. A printed number with thousands commas is a part of the quote made of one to three digits, one or more groups of a comma and three digits, and optionally a period and one or more digits, with no digit, comma or period right before it and none right after it.
2. FOR a reading of a number field whose value (spaces normalized) is one or more digits, optionally followed by a period and one or more digits, WHEN its value is not inside its quote by today's checks, THE value SHALL count as inside its quote at the first printed number with thousands commas of the quote that is the value when its commas are removed. Every digit and the period must be the same: for the quote "1,284.0 KGS", "1284.0" is inside; "1284", "1284.00", "1248.0", "12840" and "1284.1" are not.
3. The box and items are those of the printed number, as for a value inside its quote today (the printed number takes the place of the value). On an image page whose quote is not in the transcript (Requirement 50.1), this rule also decides whether the value is inside the quote, and the check of 50.8 uses the printed number in place of the value. On an image page the reading waits for a person as every image reading does. The value stays as the reader wrote it.
4. The rule does not apply to a value with a comma, a sign, a currency, a unit or a space, to a quote with no printed number with thousands commas, to a decimal comma ("9.299,00"), or to any field that is not a number field of 59.1 (item, invoice, packing list, bill of lading and container numbers, HTS numbers, `billOfLading.packages`, dates and every text field). Every other reading is checked as today.
5. Example: the recorded read of bundle A (`samples/real-reads/test-bundle-a.json`), `billOfLading.grossKg` "1284.0" with the quote "1,284.0 KGS" on the transcript line "ZZZU 418207 3 / SMPL-0000 77 CTNS Ceramic and glass home decor, tin lanterns, artificial stems 1,284.0 KGS 9.8 CBM" of the photo: accepted with the box of that line. With Requirement 58 the 34A fields say "The packing list total gross weight (1248.0 kg) differs from the bill of lading (1284.0 kg). A person decides." and the check X.bl.gross is false with "B/L gross = 1284.0, packing gross = 1248.0".

---

### Requirement 60 (MUST): An Address Printed Over Several Lines Under Its Quote Is Inside Its Quote

**User Story:** As an entry writer, I want the invoice issuer's address that the AI reader wrote from its printed lines to reach the draft, so that Block 13 gets its MID suggestion.

**Background:** In the fourth real reads of bundles A, B and C, the reader wrote `invoice.seller.address` as its printed lines joined with ", " but quoted only the first line (A: "Rua das Corujas 12, Vila Nevoa"; C: "Lot 9, Fernlight Industrial Cluster"), or quoted the lines with the text of the next column between them (B: "Nebelgasse 5 Datum / Date: 09.11.2026 00000 Kraehenfeld, Germany"). `verifyReadings` rejected each with "value_not_in_quote", and B13 said "The invoice issuer's name or address was not read, so no MID is suggested." In the read before, the reader quoted both lines of A and Requirements 35.3 and 35.4 accepted the same value.

#### Acceptance Criteria

1. FOR a reading of `invoice.seller.address`, `invoice.buyer.address` or `invoice.shipTo.address` whose quote is found on the page as today, but not as a stacked run of Requirement 35.3, WHEN its value is not inside its quote by today's checks, THE value SHALL count as inside its quote when all of these hold:
   a. the quote starts where a page item S starts;
   b. the lines under S are: on a text page (a PDF text layer or a sheet), the items below S found as Requirement 35.3 builds a run (each next item the nearest one below the item before, its left edge within 2 points of the left edge of S, its top more than 0 and at most twice the height of the item before below that item's bottom), up to three of them; on an image page, the transcript lines right after S in transcript order, up to three of them;
   c. for some k from 2 to 4, the texts (spaces normalized) of S and the first k − 1 lines under it, joined with ", ", are the value (spaces normalized), and the last character of the quote is inside one of these k items.
   The reading then gets the box made of these k items (the union of their boxes) and their item ids, as a quote over two lines does today. On an image page it gets origin "imageTranscript" and `lineText` = their texts joined with " ", and when one of them has no box Requirement 58.1 applies.
2. Otherwise the reading is rejected with "value_not_in_quote" and today's message. A value with a part that is not one of these lines, whole and in this order, is rejected even when that part is printed elsewhere on the page. A quote that is not on the page is not checked by this rule (on an image page Requirement 50.1 rejects such a value with "value_not_in_quote" as today). "Same as importer" written out as the importer's name or address is rejected.
3. A reading of an image page kept by this rule waits for a person as every image reading does. The checks of 35.3 and 35.4 and every other field are unchanged.
4. Examples: the invoice text PDF of bundle A, items "Rua das Corujas 12, Vila Nevoa" and "0000-000 Portugal" below it: "Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal" with the quote "Rua das Corujas 12, Vila Nevoa" is accepted with the box of both items, and B13 then gives the MID suggestion of Requirement 48.9 ("PTMOTCER12VIL for line 001, 002, 003; CNMOTCER12VIL for line 004"). The invoice text PDF of bundle B (both recorded reads): "Nebelgasse 5" and "00000 Kraehenfeld, Germany" below it, with the date of the next column between them in the quote, give "Nebelgasse 5, 00000 Kraehenfeld, Germany". The invoice photo of bundle C of 2026-11-26: transcript lines "Lot 9, Fernlight Industrial Cluster" and "Viet Nam" give "Lot 9, Fernlight Industrial Cluster, Viet Nam", accepted from the image and waiting for a person. Not kept: "Rua das Corujas 12, Vila Nevoa, Portugal" (no such line under it), "Rua das Corujas 12, Vila Nevoa, Terms: FOB Leixoes, Portugal" (the next column, not below), the read of bundle C of 2026-11-24 (its quote is not in its transcript), and `invoice.shipTo.name` "Bramblewick Home Goods LLC" or `invoice.shipTo.address` with the quote "Same as importer".

---

### Requirement 61 (MUST): A Number Inside a Longer Printed Number Is Not Inside Its Quote

**User Story:** As an entry writer, I want a number that the AI reader cut short ("980" from "4,980") to be rejected, so that a wrong number never stands in the draft with the box of the longer number.

**Background:** `verifyReadings` counted a value as inside its quote when the value's text was anywhere in the quote. For a number field, "980" was inside "4,980", "200" inside "1,200" and "160,00" inside "2.160,00", so a reading that dropped the first digits was accepted with the box of the longer number (open limit of implementation session 28). In the six recorded real reads (the third and fourth reads of bundles A, B and C) and the sample bundle, the rule below changes no reading (counted 2026-11-26 from the recorded answers, no AI call).

#### Acceptance Criteria

1. FOR a reading of a number field of Requirement 59.1, a place of its value (spaces normalized) in a text is inside a longer printed number WHEN the character right before it is a digit, or is a comma or a period with a digit right before that, or WHEN the character right after it is a digit, or is a comma or a period with a digit right after that.
2. WHERE `verifyReadings` looks for the value as text (in the quote after the quote search, in the joined text of a stacked run of Requirement 35.3, in the quote over several rows of 35.4, and on an image page in the test of 50.1 that the value is inside its own quote), THE value SHALL count as found there only at a place that is not inside a longer printed number, and the first such place is the value's place (its box and items as today). WHEN every place is inside a longer printed number, the value is not found by that search; the other checks of today (dates of 35.1, printed numbers with thousands commas of 59) still run, and when none finds it the reading is rejected with "value_not_in_quote" as today.
3. A comma or a period that has no digit on its far side (the end of a sentence "Total 77.", a list "77, 80") does not make a place inside a longer number. The check of 50.8 is not changed. Fields that are not number fields of 59.1 (item, invoice, packing list, bill of lading and container numbers, HTS numbers, `billOfLading.packages`, dates and every text field) are checked as today: "MCA-101" inside "MCA-1012" is judged as before.
4. Every reading that is not a number field reading found only inside longer printed numbers gets the same status, reason, message, box, item ids, line text and cell as before this requirement.
5. Examples on a text page: "980" with the quote "TOTAL 77 4,980": rejected with "value_not_in_quote". "980" with the quote "980 PCS 4,980": accepted with the box of the first "980". "200" with the quote "1,200": rejected. "1200" with the quote "1,200": accepted by 59.2 as today. "160,00" with the quote "2.160,00": rejected. "77" with the quote "Total 77.": accepted. "468" with the quote "468.0 KGS": rejected (fewer digits than printed). The recorded reads of bundles A, B and C and the sample bundle give the same readings, drafts and CSVs as before.

---

### Requirement 62 (MUST): The Lines for a Record or a Top-Up Not Written Name the Record Key and the Missing Amount

**User Story:** As an operator, I want the log line of a record that was not written to name its record key, and the line of a top-up that was not written to name the amount, so that I can drop a line whose record did arrive and add the missing amount to the ledger count.

**Background:** agy cross-check 4 (R22, R20): a record write that runs out of time may still be saved later, and the line "usage record not written" did not say which record key it was, so a count of records plus lines could not drop it. The line "usage cost top-up not written" did not say how much the cap ledger is short.

#### Acceptance Criteria

1. `src/server/usageStore.ts` SHALL export `newUsageRecordKey(timestamp: string): string`, which gives `usage/<the digits of the timestamp>-<a random UUID>` (the key of Requirement 54.1). `UsageStore.appendRecord` SHALL take an optional second argument `key?: string`. `createBlobsUsageStore().appendRecord(r, key)` SHALL write the record under `key` when it is given and under `newUsageRecordKey(r.timestamp)` when it is not; everything else of 54.1 stays. The file and memory stores ignore the key.
2. IN claude mode THE server SHALL make the key of each record with `newUsageRecordKey(record.timestamp)` before it writes the record, pass it to `appendRecord`, and WHEN the record is not saved (Requirements 41.2 and 55.2) log `usage record not written: ` followed by the JSON of `{ key, timestamp, model, outcome, inputTokens, outputTokens, estimatedCostNanoUsd }`, with `key` the key it passed.
3. WHEN the top-up of Requirement 24.3 is not written (the tries of Requirement 42 fail or the time of 55.2 runs out), THE server SHALL log `usage cost top-up not written: ` followed by the JSON of `{ missingNanoUsd }`, the actual cost minus the reserved cost that was not added to the ledger. WHEN the actual cost could not be computed, the line is `usage cost top-up not written: {"missingNanoUsd":null}`.
4. Only the two lines and the key passed to `appendRecord` change. The order (the record first, then the top-up), the deadline of 55.2, the tries and waits of 42, the caps, the reservation, the costs, the record itself, the ledger, the answer to the person, the prompt and the reader stay as they are. The lines carry no file hash, no document text, no error message, no provider key and no environment value.

---

### Requirement 63 (MUST): A Person's Exchange Rate Converts the Amounts of an Invoice That Is Not in USD

**User Story:** As an entry writer, I want to enter the exchange rate I have chosen, with its date and where it came from, so that the entered values, the duties and the totals of an invoice in another currency are computed from it with their threads, while the app still never chooses a rate.

**Background:** With an invoice currency other than USD, every 36A waited with "Currency is not USD.", and with it every 38, B39, FEE.MPF, B41, B43 and B44 (28 values a person typed for the recorded read of bundle B of 2026-11-26). 19 CFR 159.31 allows only a proclaimed or certified rate; 159.32 and 152.1(c) fix the date of exportation (the day the goods finally leave the country of exportation for the United States); 159.34 and 159.35 say when the quarterly or the daily certified rate applies. 159 Subpart C and the CBP Form 7501 instructions (11/26) give no rounding for the conversion step; the instructions round 36A to whole dollars (P4). The recorded invoice of bundle B prints its amounts with a decimal comma ("2.160,00"), which today's money reading does not take, so a rate alone computes nothing; with the reading of 63.4 the recorded reads of bundle B have 13 fewer values a person types (28 to 15 and 36 to 23, counted 2026-11-26 by replaying the recorded answers, no AI call; CHK.INVOICE still waits, since P2 reads the subtotal as today).

#### Acceptance Criteria

1. `buildDraft` SHALL take an optional `exchangeRate: { rate: string; date: string; source: string } | null`. The rate is usable only WHEN all of these hold: (a) `invoiceForeignCurrency` of the readings is not null: the `invoice.currency` reading that the draft counts as accepted has a value and that value (spaces normalized, in capitals) is not "USD"; (b) the rate, trimmed, matches `^\d{1,6}(\.\d{1,8})?$` and is greater than 0; (c) the date, trimmed, is a real date written `YYYY-MM-DD`; (d) the source, spaces normalized, has 1 to 200 characters. `exchangeRateProblem` gives the reason why a rate, a date or a source does not pass, or null. WHEN the rate is not usable (no rate, a currency that is USD, not read, not sure or rejected, or a rate, a date or a source that does not pass), THE draft and its CSV SHALL be exactly the draft and the CSV built without it.
2. WHEN the rate is usable, THE header SHALL end with the field `FX.RATE`: block "FX", line null, label "Exchange rate (USD per 1 <currency>)", value the trimmed rate, unit null, status "personEdited", rule null, note "Entered by a person: 1 <currency> = <rate> USD, rate date <date>, source "<source>". The app does not choose, suggest or look up a rate.", reason null, sources one exchange rate source `{ kind: "exchangeRate", currency, rate, date, source }`, and no inputs. A person value (override) for `FX.RATE` is ignored: the rate changes only through `exchangeRate`.
3. WHEN the rate is usable, a line's 36A SHALL follow the rules of a USD invoice with these changes, in this order: the P1 case of the P1 checks (unchanged); the case of mixed number forms of 63.4; the P1 case of an invoice line of the group that has no P1 check because its unit price or its amount is printed with a decimal comma, checked the same way with the readings of 63.4 (its quantity by today's count reading times its unit price against its amount, within 1 cent; the reason "P1 mismatch: quantity × unitPrice = <x>, amount = <y>, diff = <z>. A person decides."; the checks list is not changed); the missing amount case of 27.1; then the value, where the amounts are in the invoice currency and are read by 63.4; the exact value is the sum of the group's amounts, in cents of the invoice currency, times the rate, computed exactly with whole numbers (no floating point), and P4 is applied once to it with no rounding before (the exact product's whole cents rounded down, given to `roundEnteredValue`, give the same whole dollars as P4 of the exact product); the field is "computed", rule "P4", inputs `FX.RATE`, sources the group's amount readings, then the currency reading, then the exchange rate source, and note "<amount> <currency> × <rate> = <exact USD> USD, rounded to whole dollars (P4).[ Invoice line <n> amount printed "<text>", read as <amount> (decimal comma).] Nothing was deducted. A person confirms the entered value." (<amount> with two decimals, "(<a> + <b>)" for several invoice lines; <exact USD> with every digit of the exact product and at least two after the point; one bracketed sentence for each amount read with a decimal comma). The value waits for a person by Requirement 26.1 when one of these readings came from an image page, and a person's 36A value comes first as today. 38, B39, FEE.MPF and B41 to B44 follow from 36A as today.
4. WHEN the rate is usable, an amount text that today's money reading (`parseMoneyToCents`) takes keeps its value. An amount text it does not take SHALL be read by `decimalCommaCents` only when the text, spaces normalized, is `^\d{1,3}(\.\d{3})+,\d{2}$` or `^\d+,\d{2}$` (a decimal comma with exactly two digits after it, and periods only between groups of three digits); its cents are its digits. This reading is used only for the 36A of 63.3; P1, P2, CHK.INVOICE, quantities, weights, the packing list and the bill of lading are read as today. WHEN the invoice mixes number forms (`mixesNumberForms`: among the values of every `invoice.lines.<n>.amount`, `invoice.lines.<n>.unitPrice`, `invoice.subtotal` and `invoice.total` reading of any status, each with one leading or trailing three-capital-letter code, "€" or "$" removed, one is in a decimal comma form above and another has a comma or a period and is not), every 36A SHALL get, after the P1 case of the P1 checks, status "needsReview", value null, the group's amount readings as sources, and reason "The invoice prints its amounts both with a decimal comma and in another form, so the draft does not convert them. A person enters the entered value."
5. WHEN the board's invoice currency (`invoiceForeignCurrency` of the board's readings) is not null, THE board SHALL show an exchange rate box right above the line items with the label "Exchange rate (USD per 1 <currency>)", the text "Customs converts foreign currency only at a proclaimed or certified rate (19 CFR 159.31), for the date of exportation: the day the goods finally left the country of exportation for the United States (159.32, 152.1(c)). 159.34 and 159.35 say when the quarterly or the daily certified rate applies. Enter the rate, its date and where it came from. The app does not choose, suggest or look up a rate.", three empty inputs (the rate, the rate date, where the rate came from) and "Use this rate". A rate, date or source that does not pass shows the reason of `exchangeRateProblem` and changes nothing. With a usable rate the box shows the `FX.RATE` value (clicking it selects the field: its note, its source and the threads), the rate date, the source and "Clear rate". `FX.RATE` is shown only in this box, not with the header blocks. "Clear rate", Undo on `FX.RATE`, and a new upload give back the draft without the rate. The app never fills the box: no suggested, sample, remembered or looked-up rate.
6. THE CSV SHALL give an exchange rate source as `Exchange rate entered by a person: 1 <currency> = <rate> USD, rate date <date>, source "<source>"` (a quote inside the source doubled, as in a document quote), on the `FX.RATE` row and on every 36A row computed with the rate.
7. Not done: an invoice with more than one currency, a rate for each line, a rate the app chooses, suggests or looks up, other number forms (periods between thousands with a decimal point, three decimals, spaces between thousands), and any change to the reader, the prompt, the answer shape, the field list, the HTS numbers or the duty rates.
8. Examples (the recorded read of bundle B of 2026-11-26 with the rate 1.0835, the date 2026-11-09 and the source "Demo rate for this video, not a certified rate", a person's test value and not a value of the app): L001.36A "2340" from "2.160,00" (2160.00 EUR × 1.0835 = 2340.36 USD), L003.36A "1679" from "1.550,00" (1679.425), L004.36A "829" from "765,00" (828.8775), B39 "10074"; the values a person types go from 28 to 15 (L006.38, B41, B43, B44 and CHK.INVOICE still wait: 37A of line 006, FEE.HMF and the Chapter 99 duty of line 001 are not given, and P2 does not read the subtotal "EUR 9.299,00"). Without the rate the draft and the CSV are as before; with the currency "USD" the same rate changes nothing. `decimalCommaCents` gives null for "1.800", "1,800" (today's reading takes it as 1800.00), "1.80", "2.160,0", "2,160.00" and "EUR 2.160,00".

---

### Requirement 64 (MUST): Three Screen Texts Read as Sentences and Equations

**User Story:** As an entry writer, I want the notes and reasons that the board shows first to be whole sentences and equations that hold, so that I can trust what they say at a glance.

**Background:** A review of the screens for the demo video found three texts: the note of the sample's L001.35 "120 + 96 Dz Pcs" adds pieces but names dozens, the reason of L003.35 "says 240 PCS, the packing list says 216 PCS. A person decides." has no subject, and the reason of L004.36A "… diff = 12.00 A person decides." has no full stop.

#### Acceptance Criteria

1. THE note of a computed 35 of a 7501 line made of two or more invoice lines whose units are all piece units (PCS, PC, EA, PIECES, NO.) SHALL be "<q1> <u1> + <q2> <u2>[ + …] = <sum> PCS", followed by " = <value> <HTS unit>" when the field has an HTS unit; each q and u is the invoice line's quantity and its unit as read (spaces normalized, in capitals), the sum is the quantities added up, and the value and the unit are those of the field. A 35 of one invoice line, or of lines with another unit, keeps today's note. Example: the sample's L001.35 "120 PCS + 96 PCS = 216 PCS = 18 Dz Pcs" (it was "120 + 96 Dz Pcs").
2. THE reason of an invoice quantity that is not the packing list sum (the last case of Requirement 33.2) SHALL be "Invoice line <n> says <q> PCS; the packing list says <sum> PCS. A person decides." Example: the sample's L003.35 "Invoice line 3 says 240 PCS; the packing list says 216 PCS. A person decides."
3. THE reason of a 36A whose group failed a P1 check SHALL be "P1 mismatch: <the P1 detail>. A person decides." Example: the sample's L004.36A "P1 mismatch: quantity × unitPrice = 480.00, amount = 468.00, diff = 12.00. A person decides."
4. Only these texts change: the sample CSVs differ from before only in the note of L001.35 and the reasons of L003.35 and L004.36A (with the demo answers, the note of L001.35 and the "Before:" notes of L003.35 and L004.36A). Values, statuses, sources, checks and every other text stay.

---

## Requirements Summary (MUST/NICE Tags)

**MUST (needed for demo by 2026-11-29):**

1. (MUST) File Input and Validation
2. (MUST) Browser-Side Document Processing
3. (MUST) Reader Input and Output Contracts
4. (MUST) Source Traceability for Image Pages
5. (MUST) Confidence and Validation Rules
6. (MUST) Field Scope and Line Limits
7. (MUST) Reader Modes and Server-Side Control
8. (MUST) Real Reader — Claude Haiku 5.5
9. (MUST) Fake Reader for Testing
10. (MUST) Usage Logging and Cost Tracking
11. (MUST) Reader Call Caps
12. (MUST) Security — No Uploads Retained
13. (MUST) UI — Upload Control and Board Integration
14. (MUST) Tests — Property-Based
15. (MUST) Sample Bundle Unchanged
16. (MUST) Local Test Documents
17. (MUST) Size and Cost Limit for One Reader Call
18. (MUST) Values Read from Images Are Confirmed by a Person
19. (MUST) Invoice Lines Checked Against the Invoice
20. (MUST) Every Accepted Value Points to Its Place
21. (MUST) Time Limit for the Reader Call
22. (MUST) Reader Errors Never Carry Document Text
23. (MUST) A Cap Reservation Counts Only When the Store Confirms It
24. (MUST) The Worst Case Counts Every Byte, and the Ledger Gets the Actual Cost
25. (MUST) The Reader Uses Only the App's Own Key and the Anthropic Address
26. (MUST) Values Computed from Image Readings Wait for a Person
27. (MUST) Missing Amounts, Currency and Gross Weight Go to a Person
28. (MUST) Small Guards on Requests, CSV Cells and Day Counts
29. (MUST) The Reader's Answer Fits in One Call
30. (MUST) A Value Computed Again After a Person's Edit Still Waits
31. (MUST) An Edited HTS Number Derives the Line's Quantity by the First Rule
32. (MUST) A Value That Cannot Be Computed From What the Draft Has Now Waits
33. (MUST) A Quantity That Was Not Read Is Not Zero
34. (MUST) A Value That Repeats on the Page Is Checked in Its Own Line
35. (MUST) A Date in the Asked Form and a Quote Over Two Lines Are Checked Against the Page
36. (MUST) A Value the Reader Was Not Sure Of Is Shown, Not Used
37. (MUST) One Bad Transcript Line Does Not Throw Away the Answer
38. (MUST) A Draft Value Waits for What Was Not Read, With the Right Reason
39. (MUST) A Box on a Photo or Scan Shows the AI Reader's Estimated Place
40. (MUST) A Weight or Package Count With Thousands Commas Is Read
41. (MUST) A Paid Call Always Leaves a Usage Record
42. (MUST) The Cost Top-Up Waits and Tries Again, and a Store Error Is Judged by Its Status
43. (MUST) The "AI estimate" Label Does Not Cover the Page Text
44. (MUST) A CSV Number Keeps Its Sign, and Block 9 Waits Without a Container Number
45. (MUST) An Excel Document Is Read With Cell Addresses
46. (MUST) A Customer Parts List Gives the HTS Number, Origin and MID From the Office's Own Rows
47. (MUST) Port Codes and the Mode of Transport From Public CBP Code Tables
48. (MUST) Block 13 MID Suggested by the Appendix 2 Rule
49. (MUST) The Board Draws Only the Active Documents, and a Sheet Is Not Cut
50. (MUST) A Value Read From an Image Line That Is Not in the Transcript Waits for a Person
51. (MUST) The Reader Writes the Transcripts First and Counts the Packing List Lines
52. (MUST) Every Country Name and Code, and the Printed Date Forms, Reach the Draft
53. (MUST) The Page Comes First, and the Lists of Readings Stay Below It
54. (MUST) A Usage Record Is Written Without a Condition, So a Write Sent Again Is Counted Once
55. (MUST) The Store Writes After the Reader Stop in Time
56. (MUST) A Usage the Call Cannot Have, and an Answer Without Usage, Are Recorded at the Reserved Worst Case
57. (MUST) The Chapter 99 Reason Says "See" Once
58. (MUST) A Value on a Transcript Line With No Usable Place Waits for a Person
59. (MUST) A Number Written Without Its Thousands Commas Is Inside Its Quote
60. (MUST) An Address Printed Over Several Lines Under Its Quote Is Inside Its Quote
61. (MUST) A Number Inside a Longer Printed Number Is Not Inside Its Quote
62. (MUST) The Lines for a Record or a Top-Up Not Written Name the Record Key and the Missing Amount
63. (MUST) A Person's Exchange Rate Converts the Amounts of an Invoice That Is Not in USD
64. (MUST) Three Screen Texts Read as Sentences and Equations

**NICE (if time is left):**

- The reader suggests the document kind for each file.
- An optional access code (environment variable) that the public site asks for before an AI read.
- A durable cap store on the deployment platform (Netlify Blobs).
- HEIC photos, rotated photos, more than 8 invoice lines, the full HTS table.
