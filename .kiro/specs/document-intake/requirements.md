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

1. WHEN a reader returns a field with `confidence: "low"`, the draft builder SHALL reject the reading with `reason: "low_confidence"` (a new `RejectReason` value).
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
2. WHEN a person enters 480 as the value of line 004 Column 36A (entered value), THE computed Column 38 duty of line 004 SHALL be 28.80 and the Needs review list SHALL go from 21 to 17 items.
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
3. AFTER a reader call that reports token usage (a valid answer, an invalid answer, or a ReaderError that carries usage), THE server SHALL compute the actual cost with `estimateCostNanoUsd(inputTokens, outputTokens)`. IF it is above the worst case reserved for the call, THE server SHALL add the difference to `reservedCostNanoUsd`: read the state, apply `addReservedCost`, write it, up to 3 tries; if all fail, log "usage cost top-up not written" (no document text). The answer to the person does not change.
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
2. THE output schema SHALL ask for each transcript line as an object with exactly two properties: "t" (string, the line text) and "b" (array of integers: x, y, w, h of the line box in thousandths of the page width and height, origin top-left). The schema keeps `additionalProperties: false` and uses no `minimum`, `maximum`, `minItems` or `maxItems` (the API does not accept numeric and complex array constraints). `createClaudeReader` SHALL turn every line into the existing `{ text, box: { x, y, w, h } }` with each number divided by 1000 before `validateReaderOutput`. A line whose "b" is not exactly 4 integers from 0 to 1000 makes the answer invalid with the reason "transcripts[<i>].lines[<j>].b: must be 4 integers from 0 to 1000" (positions and fixed words only, Requirement 22.1). `ReaderOutput`, the fake reader, the recordings and every step after the reader stay as they are.
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

**NICE (if time is left):**

- Excel invoices and packing lists (.xlsx): sources are cell addresses instead of page boxes.
- The reader suggests the document kind for each file.
- An optional access code (environment variable) that the public site asks for before an AI read.
- A durable cap store on the deployment platform (Netlify Blobs).
- HEIC photos, rotated photos, more than 8 invoice lines, the full HTS table.
