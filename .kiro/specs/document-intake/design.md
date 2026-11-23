# Design Document: Document Intake

## Overview

The Document Intake feature adds the missing front door to the 7501 draft helper: users upload their own shipping documents (invoices, packing lists, bills of lading) via the browser, an AI reader reads them (or a fake reader provides test answers), and the result flows into the existing pipeline (`verifyReadings` → `buildDraft` → review lists → `draftToCsv`), displayed on StitchBoard. Documents are processed in the browser; only page text, page images, metadata, and file hashes are sent to the server. All server state is configuration-driven: reader mode (off/fake/claude) and caps are environment-controlled; usage and cap state persist across restarts. The sample bundle remains the first screen and continues to work exactly as today.

**Key Design Principles:**
- **Browser-First Processing**: Files are extracted and validated in the browser before any upload
- **Configuration Driven**: Limits, caps, pricing, and modes come from configuration, never hardcoded
- **Pure Core**: Browser-safe pure modules (no node:*, no pdf.js import, no network) are reusable in tests and share configuration with the server
- **Single Reader Boundary**: Real and fake readers implement one shape; tests inject fake clients without network calls
- **Source Traceability**: Every value carries a source; image-page sources are distinct and labeled
- **Fail Closed**: If the server cannot store state or reach a requirement, it refuses the AI call rather than proceeding optimistically
- **Correctness by Construction**: Caps, costs, and state transitions are pure functions verified by property tests
- **Sample Unmodified**: The frozen reader and sample bundle behave identically to today

---

## Architecture

### Module Organization

**Pure, Browser-Safe Modules** (imported by `src/app/` and also by server-only code in tests):

```
src/core/
├── intakeConfig.ts           # Configuration: maxFiles, maxFileBytes, maxPdfPages, maxImagePages, maxImageLongSide, minTextChars, jpegQuality, maxRequestBytes, readerModel, prices
├── fieldCatalog.ts           # List of field names the reader may return (invoice header, lines 1–8, packing list header, lines 1–8, bill of lading header)
├── transcript.ts             # transcriptToPageText(docId, page, width, height, lines: TranscriptLine[]): PageText (with origin: "imageTranscript")
├── pdfText.ts                # Add optional origin?: "textLayer" | "imageTranscript" to PageText
├── reading.ts                # FieldReading gets optional confidence?: "high" | "low"; RejectReason gets "low_confidence"; verifyReadings adds confidence check
├── draft.ts                  # DocSource gets optional origin?: "imageTranscript"
├── csv.ts                    # formatSource appends " (read from an image by the AI reader)" when origin === "imageTranscript"
├── readerContract.ts         # ReaderInput, ReaderOutput, ReaderPage, TranscriptPage, validation, composition functions
├── budget.ts                 # UsageState, Caps, decideCall, remainingCalls, estimateCostMicroUsd, formatUsd
└── index.ts                  # Re-exports the above
```

**Server-Only Modules** (`src/server/`, never imported by 'use client' code):

```
src/server/
├── readerEnv.ts              # resolveReaderSetup(env): mode, reason, caps, store, storeDir, visitorSalt, apiKey
├── usageStore.ts             # UsageStore interface; createFileUsageStore, createMemoryUsageStore
├── visitorKey.ts             # visitorKey(ip, salt, dayUtc): string (SHA-256 hex or "unknown")
├── fakeReader.ts             # createFakeReader(recordings): DocumentReader-like; loadRecordings(dir)
├── claudeReader.ts           # createClaudeReader({ apiKey, client? }): DocumentReader-like
└── intakeService.ts          # handleReadRequest, handleStatusRequest
```

**Browser-Side UI Modules**:

```
src/app/
├── intake/
│   ├── prepareFiles.ts       # prepareUpload(files, limits): ReaderInput, textDocs, views
│   └── UploadPanel.tsx       # Upload panel component
└── StitchBoard.tsx           # Add source state (sample | upload), tabs, image drawing, backward compat
```

### Data Flow

1. **Browser**: User picks files, selects document kind per file
2. **Browser**: `prepareFiles` validates against limits, extracts text, renders image pages, computes SHA-256, builds `ReaderInput`
3. **Browser**: POST to `/api/read` with `ReaderInput`
4. **Server**: `handleReadRequest` checks caps and mode; if mode is "off" or caps would exceed, reject immediately
5. **Server**: Reserve cap state to durable store (fail closed if write fails); call reader (fake or Claude)
6. **Server**: On success, append usage record; return 200 with output
7. **Browser**: Call `composeDocumentTexts(textDocs, input, output)` to merge text layers with transcripts (image pages get `transcriptToPageText`)
8. **Browser**: Call existing `verifyReadings` on the combined texts (no changes to that function)
9. **Browser**: Call existing `buildDraft` (only `DocSource` gets optional `origin` for image pages)
10. **Browser**: CSV includes source labels with " (read from an image by the AI reader)" when origin === "imageTranscript"

### Configuration Ownership

**`intakeConfig.ts`** (shared, read by browser and server):
- `maxUploadFiles`: 3
- `maxFileBytes`: 10_000_000 (10 MB)
- `maxPdfPages`: 4
- `maxImagePages`: 6
- `maxImageLongSide`: 1600
- `minTextChars`: 20 (below this, a PDF page is treated as an image)
- `jpegQuality`: 0.85
- `maxRequestBytes`: 4_500_000 (deployment platform max)
- `readerModel`: "claude-haiku-5-5"
- `prices: { inputUsdPerMTok: 0.10, outputUsdPerMTok: 0.50, upToPromptTokens: 100_000, source: "Anthropic model pricing table", checked: "2026-11-18" }`

**Environment Variables** (server only, never in browser code):
- `DOCUMENT_INTAKE_MODE`: "fake" or unset (default)
- `DOCUMENT_INTAKE_KILL_SWITCH`: any non-empty value to turn off AI
- `DOCUMENT_INTAKE_ANTHROPIC_KEY`: Claude API key (read only on server, never logged)
- `DOCUMENT_INTAKE_STORE`: "file" (local use, default)
- `DOCUMENT_INTAKE_TOTAL_CAP`: integer, default 300
- `DOCUMENT_INTAKE_DAILY_CAP`: integer, default 0 (no limit)
- `DOCUMENT_INTAKE_VISITOR_DAILY_CAP`: integer, default 3
- `DOCUMENT_INTAKE_VISITOR_SALT`: string for visitor key hash salt; if unset, per-visitor key is "unknown"
- `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` are never read (Requirement 25).

### Reader Interface

All readers (real or fake) implement the same shape:

```typescript
type ReaderPage = {
  page: number;
  width: number;
  height: number;
  text: string | null;
  image: { mediaType: "image/jpeg"; base64: string } | null;
};

type ReaderDocument = {
  docId: string;
  kind: DocKind;
  fileName: string;
  fileSha256: string;
  pages: ReaderPage[];
};

type ReaderInput = {
  bundle: string;
  documents: ReaderDocument[];
};

type TranscriptLine = {
  text: string;
  box: { x: number; y: number; w: number; h: number };  // 0..1, origin top-left
};

type TranscriptPage = {
  doc: string;
  page: number;
  lines: TranscriptLine[];
};

type ReaderOutput = {
  reader: string;
  fields: FieldReading[];  // with optional confidence?: "high" | "low"
  transcripts: TranscriptPage[];
};
```

Validation functions:
- `validateReaderInput(json, limits)`: shape, limits, page counts, request size
- `validateReaderOutput(json, input)`: shape, docs and pages exist, image pages have transcripts, boxes inside 0..1, only catalog field names
- `readerOutputToAnswer(input, output): ReadingAnswer`: compose a complete `ReadingAnswer` (schemaVersion 1, bundle, documents, fields)
- `composeDocumentTexts(textLayerDocs, input, output): DocumentText[]`: merge browser-extracted text with server transcript; image pages get `transcriptToPageText`

---

## Components and Interfaces

### 1. Intake Config Module (`src/core/intakeConfig.ts`)

**Purpose**: Define all upload and reader limits in one place.

```typescript
export const intakeConfig = {
  maxUploadFiles: 3,
  maxFileBytes: 10_000_000,
  maxPdfPages: 4,
  maxImagePages: 6,
  maxImageLongSide: 1600,
  minTextChars: 20,
  jpegQuality: 0.85,
  maxRequestBytes: 4_500_000,
  readerModel: "claude-haiku-5-5",
  prices: {
    inputNanoUsdPerToken: 100,          // 0.10 USD per million tokens
    outputNanoUsdPerToken: 500,         // 0.50 USD per million tokens
    inputNanoUsdPerTokenOver: 500,      // 0.50 USD per million tokens (over upToPromptTokens)
    outputNanoUsdPerTokenOver: 2500,    // 2.50 USD per million tokens (over upToPromptTokens)
    upToPromptTokens: 100_000,
    source: "Anthropic model pricing table",
    checked: "2026-11-18",
  },
};
```

### 2. Field Catalog Module (`src/core/fieldCatalog.ts`)

**Purpose**: Define the complete list of fields the reader may return, generated from the sample bundle pattern.

```typescript
export interface FieldDefinition {
  name: string;
  description: string;
}

export const fieldCatalog: FieldDefinition[] = [
  { name: "invoice.number", description: "Invoice number from the header" },
  { name: "invoice.date", description: "Date the invoice was issued" },
  // ... invoice header fields ...
  { name: "invoice.lines.1.itemNo", description: "Item number on line 1" },
  { name: "invoice.lines.1.description", description: "Description on line 1" },
  { name: "invoice.lines.1.hts", description: "HTS number on line 1" },
  { name: "invoice.lines.1.origin", description: "Country of origin on line 1" },
  { name: "invoice.lines.1.quantity", description: "Quantity on line 1" },
  { name: "invoice.lines.1.unit", description: "Unit of measure on line 1" },
  { name: "invoice.lines.1.unitPrice", description: "Unit price on line 1" },
  { name: "invoice.lines.1.amount", description: "Total amount on line 1" },
  // ... lines 2–8 follow the same pattern ...
  { name: "invoice.subtotal", description: "Subtotal on the invoice" },
  { name: "invoice.total", description: "Total on the invoice" },
  // ... packing list fields and lines 1–8 ...
  // ... bill of lading fields ...
];

export function validateFieldName(name: string): boolean {
  return fieldCatalog.some((f) => f.name === name);
}
```

### 3. Transcript Module (`src/core/transcript.ts`)

**Purpose**: Convert image-page transcripts to the same `PageText` structure as text layers.

```typescript
export type TranscriptLine = {
  text: string;
  box: { x: number; y: number; w: number; h: number };  // 0..1, origin top-left
};

export function transcriptToPageText(
  docId: string,
  page: number,
  width: number,
  height: number,
  lines: TranscriptLine[]
): PageText {
  // Filter empty lines
  const nonEmpty = lines.filter((line) => normalizeSpace(line.text).length > 0);

  // Create items (one per line)
  const items: TextItem[] = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    const line = nonEmpty[i];
    const text = normalizeSpace(line.text);
    const id = `${docId}:p${page}:i${i + 1}`;
    
    // Convert box from 0..1 page-relative to PDF points
    const box: Box = {
      x: line.box.x * width,
      y: line.box.y * height,
      w: line.box.w * width,
      h: line.box.h * height,
    };
    
    // Clamp box inside page
    const clampedBox: Box = {
      x: Math.max(0, Math.min(box.x, width)),
      y: Math.max(0, Math.min(box.y, height)),
      w: Math.max(0, Math.min(box.w, width - box.x)),
      h: Math.max(0, Math.min(box.h, height - box.y)),
    };

    items.push({ id, str: text, box: clampedBox });
  }

  // Build text and spans (same logic as buildPageText)
  const textParts: string[] = [];
  const spans: Span[] = [];

  for (const item of items) {
    const start = textParts.join(" ").length + (textParts.length > 0 ? 1 : 0);
    textParts.push(item.str);
    const end = start + item.str.length;
    spans.push({ itemId: item.id, start, end });
  }

  const text = textParts.join(" ");

  return {
    page,
    width,
    height,
    items,
    text,
    spans,
    origin: "imageTranscript",
  };
}
```

### 4. PdfText Update (`src/core/pdfText.ts`)

Add optional origin field to `PageText`:

```typescript
export type PageText = {
  page: number;
  width: number;
  height: number;
  items: TextItem[];
  text: string;
  spans: Span[];
  origin?: "textLayer" | "imageTranscript";  // "textLayer" if absent
};
```

### 5. Reading Update (`src/core/reading.ts`)

Update `FieldReading` to include optional confidence:

```typescript
export type FieldReading = {
  field: string;
  value: string | null;
  quote: string;
  doc: string;
  page: number;
  confidence?: "high" | "low";
};

export type RejectReason =
  | "unknown_document"
  | "page_out_of_range"
  | "value_missing"
  | "empty_quote"
  | "quote_not_found"
  | "quote_not_unique"
  | "value_not_in_quote"
  | "low_confidence";

export type VerifiedReading = FieldReading &
  (
    | { status: "accepted"; box: Box; itemIds: string[]; origin?: "imageTranscript" }
    | { status: "rejected"; reason: RejectReason; message: string }
  );
```

Update `verifyReadings` to add a confidence check as the first validation:

```typescript
export function verifyReadings(answer: ReadingAnswer, documents: DocumentText[]): VerifiedReading[] {
  const docMap = new Map<string, DocumentText>();
  for (const doc of documents) {
    docMap.set(doc.docId, doc);
  }

  return answer.fields.map((field) => {
    // NEW: Check confidence
    if (field.confidence === "low") {
      return {
        ...field,
        status: "rejected" as const,
        reason: "low_confidence" as const,
        message: "The reader marked this value as uncertain.",
      };
    }

    // 1. Check document exists
    // ... (existing checks unchanged) ...
    
    // 7. Accepted: ...
    const verified: VerifiedReading = {
      ...field,
      status: "accepted" as const,
      box: unionBox || { x: 0, y: 0, w: 0, h: 0 },
      itemIds: selectedItems.map((item) => item.id),
    };

    // Copy origin if reading came from an image page
    if (page.origin === "imageTranscript") {
      verified.origin = "imageTranscript";
    }

    return verified;
  });
}
```

### 6. Draft Update (`src/core/draft.ts`)

Update `DocSource` to include optional origin:

```typescript
export type DocSource = {
  kind: "document";
  doc: string;
  page: number;
  quote: string;
  box: Box;
  readingField: string;
  origin?: "imageTranscript";
};

function docSource(reading: VerifiedReading): DocSource {
  if (reading.status !== "accepted") throw new Error("Cannot create DocSource from rejected reading");
  const source: DocSource = {
    kind: "document",
    doc: reading.doc,
    page: reading.page,
    quote: normalizeSpace(reading.quote),
    box: reading.box,
    readingField: reading.field,
  };
  if (reading.origin === "imageTranscript") {
    source.origin = "imageTranscript";
  }
  return source;
}
```

### 7. CSV Update (`src/core/csv.ts`)

Update `formatSource` to append image label:

```typescript
export function formatSource(s: Source): string {
  if (s.kind === "document") {
    const docS = s as DocSource;
    const x = docS.box.x.toFixed(1);
    const y = docS.box.y.toFixed(1);
    const w = docS.box.w.toFixed(1);
    const h = docS.box.h.toFixed(1);
    const quote = docS.quote.replace(/"/g, '""');
    let result = `${docS.doc} p.${docS.page} [${x},${y},${w},${h}] "${quote}"`;
    if (docS.origin === "imageTranscript") {
      result += " (read from an image by the AI reader)";
    }
    return result;
  } else {
    const htsS = s as HtsSource;
    return `HTS ${htsS.revision} ${htsS.htsno}`;
  }
}
```

### 8. Reader Contract Module (`src/core/readerContract.ts`)

Define all reader input/output shapes and validation:

```typescript
export type ReaderPage = {
  page: number;
  width: number;
  height: number;
  text: string | null;
  image: { mediaType: "image/jpeg"; base64: string } | null;
};

export type ReaderDocument = {
  docId: string;
  kind: DocKind;
  fileName: string;
  fileSha256: string;
  pages: ReaderPage[];
};

export type ReaderInput = {
  bundle: string;
  documents: ReaderDocument[];
};

export type TranscriptLine = {
  text: string;
  box: { x: number; y: number; w: number; h: number };
};

export type TranscriptPage = {
  doc: string;
  page: number;
  lines: TranscriptLine[];
};

export type ReaderOutput = {
  reader: string;
  fields: FieldReading[];
  transcripts: TranscriptPage[];
};

export function validateReaderInput(
  json: unknown,
  limits: typeof intakeConfig
): RuleResult<ReaderInput> {
  // Validate shape, document kinds, file counts, page counts, request size
  // Return NeedsReview with a plain message for any violation
}

export function validateReaderOutput(
  json: unknown,
  input: ReaderInput
): RuleResult<ReaderOutput> {
  // Validate shape, field names against catalog, docs and pages exist
  // For every image page, require exactly one transcript
  // For every transcript item, box must be 0..1 range
  // Return NeedsReview for any violation
}

export function readerOutputToAnswer(
  input: ReaderInput,
  output: ReaderOutput
): ReadingAnswer {
  return {
    schemaVersion: 1,
    bundle: input.bundle,
    reader: output.reader,
    documents: input.documents.map((d) => ({ docId: d.docId, kind: d.kind })),
    fields: output.fields,
  };
}

export function composeDocumentTexts(
  textLayerDocs: DocumentText[],
  input: ReaderInput,
  output: ReaderOutput
): DocumentText[] {
  // For each document in input:
  //   - Get text-layer pages from textLayerDocs (unchanged)
  //   - For image pages (text=null), get transcript from output.transcripts
  //   - Call transcriptToPageText to create PageText with origin: "imageTranscript"
  // Return combined DocumentText array
}
```

### 9. Budget Module (`src/core/budget.ts`)

Define state and decision logic for caps and usage tracking:

```typescript
export type UsageState = {
  totalCalls: number;
  days: Record<
    string, // YYYY-MM-DD UTC
    {
      calls: number;
      visitors: Record<string, number>; // visitorKey -> call count
    }
  >;
};

export type Caps = {
  total: number;
  daily: number; // 0 = no limit
  perVisitorDaily: number;
};

export type UsageRecord = {
  timestamp: string; // ISO 8601
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostMicroUsd: number | null;
  filesSha256: string[]; // sorted
  readerMode: "claude" | "fake" | "off";
  outcome: "success" | "error" | "cap-exceeded" | "kill-switch";
  errorMessage: string | null;
};

export function decideCall(
  state: UsageState,
  caps: Caps,
  nowIso: string, // ISO 8601
  visitorKey: string | null
): { allowed: true; next: UsageState; remaining: number } | { allowed: false; reason: string } {
  // Extract today's UTC day from nowIso
  // Check total cap: if state.totalCalls >= caps.total, return { allowed: false, reason: "total_cap" }
  // Check daily cap: if today's calls >= caps.daily and caps.daily > 0, return { allowed: false, reason: "daily_cap" }
  // Check per-visitor daily cap: if today's visitor call count >= caps.perVisitorDaily, return { allowed: false, reason: "visitor_cap" }
  // Return { allowed: true, next: incremented state (never mutate input), remaining: estimated calls left today }
  // Keep only today's and yesterday's day entries in state for cleanup
}

export function remainingCalls(
  state: UsageState,
  caps: Caps,
  nowIso: string,
  visitorKey: string | null
): number {
  // Compute how many calls would be allowed starting now
  // Never negative; return 0 if next call would be refused
}

export function estimateCostNanoUsd(
  inputTokens: number,
  outputTokens: number,
  prices: typeof intakeConfig.prices
): number {
  // Nano-USD = billionths of a dollar
  // Prices are already in nano-USD per token:
  //   inputNanoUsdPerToken: 100 (0.10 USD per million tokens = 100 nano-USD per token)
  //   outputNanoUsdPerToken: 500 (0.50 USD per million tokens = 500 nano-USD per token)
  // For prompts exceeding upToPromptTokens (100K tokens), use higher tiers
  // Formula: inputTokens * (inputTokens > upToPromptTokens ? inputNanoUsdPerTokenOver : inputNanoUsdPerToken)
  //        + outputTokens * outputNanoUsdPerToken (no tier for output yet)
  // Result is exact integer nano-USD; no rounding, fully additive
}

export function formatUsd(nanoUsd: number): string {
  // Format nano-USD as dollars with 6 decimal places
  // 100_000_000 nano-USD = $0.100000
  // 50_000_000_000 nano-USD = $50.000000
}
```

### 10. Reader Environment Module (`src/server/readerEnv.ts`)

Parse environment variables into setup configuration:

```typescript
export type ReaderSetup = {
  mode: "off" | "fake" | "claude";
  reason: string | null; // short plain message when mode is "off"
  caps: Caps;
  store: "file" | null; // only "file" supported; null means no durable store
  storeDir: string;
  visitorSalt: string | null;
  apiKey: string | null; // never logged; only passed to SDK
};

export function resolveReaderSetup(env: Record<string, string | undefined>): ReaderSetup {
  // Logic order (Requirement 7.1):
  // 1. If DOCUMENT_INTAKE_KILL_SWITCH set, mode "off" with reason "kill switch is on"
  // 2. Else if DOCUMENT_INTAKE_MODE === "fake", mode "fake"
  // 3. Else if DOCUMENT_INTAKE_ANTHROPIC_KEY set AND DOCUMENT_INTAKE_STORE === "file", mode "claude"
  // 4. Else mode "off" with appropriate reason

  // Parse caps from env (default to 300 total, 0 daily, 3 per-visitor)
  // Parse DOCUMENT_INTAKE_VISITOR_SALT
  // Read API key only if mode will use it
  // Return setup
}
```

### 11. Usage Store Module (`src/server/usageStore.ts`)

Abstract interface for persisting cap state and usage logs:

```typescript
export interface UsageStore {
  readState(): Promise<UsageState>;
  writeState(s: UsageState): Promise<void>;
  appendRecord(r: UsageRecord): Promise<void>;
}

export function createFileUsageStore(dir: string = "logs/"): UsageStore {
  // Read/write caps.json; append usage.jsonl
  // Create dir if needed; handle read-nonexistent gracefully (return empty state)
}

export function createMemoryUsageStore(): UsageStore {
  // For tests and fake mode: keep state in memory only
  // Usage records printed to console but not stored
}
```

### 12. Visitor Key Module (`src/server/visitorKey.ts`)

Compute salted per-day visitor key:

```typescript
export function visitorKey(
  ip: string | null,
  salt: string | null,
  dayUtc: string // YYYY-MM-DD
): string {
  // If salt or ip is missing, return "unknown"
  // Otherwise, SHA-256(salt + dayUtc + ip) hex encoded
  // Keys from different days are unlinked
}

export function extractVisitorIp(request: Request): string | null {
  // Return first x-forwarded-for entry, else x-nf-client-connection-ip, else null
}
```

### 13. Fake Reader Module (`src/server/fakeReader.ts`)

Test-only reader that looks up pre-recorded answers:

```typescript
export type Recording = {
  name: string;
  filesSha256: string[]; // sorted alphabetically
  output: ReaderOutput;
};

export function createFakeReader(recordings: Recording[]): {
  read(input: ReaderInput): Promise<{ output: ReaderOutput; usage: { inputTokens: 0; outputTokens: 0 } }>;
} {
  // Accept a ReaderInput, extract sorted file SHA-256 values
  // Look up exact matching recording in the list
  // If found, return the recorded output with zero tokens
  // If not found, throw an error "no recorded answer for these files"
}

export async function loadRecordings(dir: string): Promise<Recording[]> {
  // Read all .json files from `${dir}/recordings/`
  // Parse as Recording objects; return array
}
```

### 14. Claude Reader Module (`src/server/claudeReader.ts`)

Real reader using Claude API:

```typescript
export function createClaudeReader(config: {
  apiKey: string;
  client?: InstanceType<typeof Anthropic>; // for testing
}): {
  read(input: ReaderInput): Promise<{ output: ReaderOutput; usage: { inputTokens: number; outputTokens: number } }>;
} {
  // Create SDK client: new Anthropic({ apiKey, maxRetries: 0 })
  // Inject client if provided (for tests)
  // Return a read function that:
  //   - Constructs messages: per page, text block for text pages or text + image block for image pages
  //   - Calls client.messages.create({
  //       model: "claude-haiku-5-5",
  //       max_tokens: 16000,
  //       output_config: { effort: "low", format: { type: "json_schema", schema: READER_OUTPUT_SCHEMA } },
  //       system: SYSTEM_PROMPT,
  //       messages: [...]
  //     })
  //   - Check response.stop_reason: if not "end_turn", reject with a plain message (refusal, max_tokens)
  //   - Parse and validate response JSON as ReaderOutput
  //   - Return { output, usage: { inputTokens, outputTokens } }
  //   - On SDK errors (auth, rate limit, API error), reject with a plain user-facing message
  // Usage is returned even if validation fails (so it can be recorded)
}
```

### 15. Intake Service Module (`src/server/intakeService.ts`)

Orchestrate the read request:

```typescript
export async function handleReadRequest(deps: {
  setup: ReaderSetup;
  store: UsageStore;
  fakeStore?: UsageStore;
  readers: { fake?: ReturnType<typeof createFakeReader>; claude?: ReturnType<typeof createClaudeReader> };
  nowIso: string;
  ip: string | null;
  bodyBytes: number;
  body: unknown;
}): Promise<{ status: number; json: unknown }> {
  // 1. If mode is "off", return 503 with { ok: false, reason }
  // 2. Validate ReaderInput and limits using validateReaderInput
  // 3. If fake mode:
  //    - Call fake reader
  //    - Record in fakeStore (in-memory, separate from paid caps)
  //    - Return 200 { ok: true, mode: "fake", output, remaining: null }
  // 4. If claude mode:
  //    - Read state from store
  //    - Compute visitorKey
  //    - Call decideCall(state, caps, nowIso, visitorKey)
  //    - If refused, record outcome "cap-exceeded" usage line (no API call), return 429 { ok: false, message, remaining }
  //    - WRITE reserved state first (if write fails, return 503, do NOT call model)
  //    - Call claude reader
  //    - Compute cost: estimateCostMicroUsd(output.usage.inputTokens, output.usage.outputTokens, prices)
  //    - Append usage record (outcome: "success" or "error")
  //    - Return 200 { ok: true, mode: "claude", output, remaining: call the remaining function }
  //    - On any error during API call, record outcome "error", return 502 { ok: false, message }
}

export async function handleStatusRequest(deps: {
  setup: ReaderSetup;
  store: UsageStore;
  nowIso: string;
  ip: string | null;
}): Promise<{ status: number; json: unknown }> {
  // Return 200 { mode, reason, callsRemaining }
  // If mode is "off", callsRemaining is null
  // Otherwise, read state, compute remaining
}
```

### 16. Browser: Prepare Files (`src/app/intake/prepareFiles.ts`)

Orchestrate file extraction and upload input building:

```typescript
export interface UploadedView {
  docId: string;
  kind: DocKind;
  pages: Array<{
    pageNumber: number;
    width: number;
    height: number;
    pdf?: PDFDocumentProxy;
    imageUrl?: string; // object URL or data URL
  }>;
}

export async function prepareUpload(
  files: Array<{ file: File; kind: DocKind }>,
  limits: typeof intakeConfig
): Promise<{
  input: ReaderInput;
  textDocs: DocumentText[];
  views: UploadedView[];
}> {
  // Validation (throw plain message errors):
  //   - File count <= maxUploadFiles
  //   - Each file size <= maxFileBytes
  //   - Each PDF page count <= maxPdfPages
  //   - Total image pages <= maxImagePages
  //   - Total request bytes <= maxRequestBytes

  // For each file:
  //   - If PDF: load with pdfjs, extract text, count pages with text, render image-only pages, compute SHA-256
  //   - If JPEG/PNG: create ImageBitmap or canvas, downscale to maxImageLongSide, encode as JPEG base64, compute SHA-256

  // Build ReaderDocument for each with ReaderPage[] (each page is either text or image, never both)
  // Build ReaderInput
  // Keep textDocs for later merge with transcripts
  // Build views for drawing on the board
  // Return all three
}
```

### 17. Browser: Upload Panel (`src/app/intake/UploadPanel.tsx`)

UI component for file upload and status:

```typescript
export function UploadPanel(props: {
  onSuccess: (bundle) => void;
  onError: (message: string) => void;
}) {
  // Show file picker, kind selection per file, validation errors
  // Fetch /api/reader-status on open
  // Display mode and calls remaining
  // Show security notice
  // On "Read documents" click:
  //   - prepareUpload
  //   - POST /api/read
  //   - composeDocumentTexts
  //   - verifyReadings
  //   - buildDraft
  //   - draftToCsv
  //   - Call onSuccess with bundle data
}
```

### 18. Browser: StitchBoard Update (`src/app/StitchBoard.tsx`)

Add source state and upload mode:

```typescript
type SourceState =
  | { kind: "sample" }
  | {
      kind: "upload";
      views: UploadedView[];
      answer: ReadingAnswer;
      documentTexts: DocumentText[];
      title: string;
    };

export default function StitchBoard(...) {
  const [source, setSource] = useState<SourceState>({ kind: "sample" });

  // Render upload panel in title bar (mode selector + status + upload button)
  // Sample path unchanged
  // Upload path: tabs per document, draw image or PDF pages as today, same threads/boxes logic
  // "Back to sample" button/tab
  // In fake mode, show label "Test mode: recorded answers, no AI call"
  // CSV file name: if sample, today's name; if upload, "uploaded-7501-draft.csv"
}
```

---

## Data Models

### ReaderInput and ReaderOutput (Shared Contract)

**ReaderInput** (browser → server):
```typescript
{
  bundle: "my-upload",
  documents: [
    {
      docId: "invoice",
      kind: "invoice",
      fileName: "invoice.pdf",
      fileSha256: "abc123...",
      pages: [
        { page: 1, width: 612, height: 792, text: "Invoice No. 123...", image: null },
        { page: 2, width: 612, height: 792, text: null, image: { mediaType: "image/jpeg", base64: "..." } }
      ]
    }
  ]
}
```

**ReaderOutput** (reader → server → browser, then composed into ReadingAnswer):
```typescript
{
  reader: "claude",
  fields: [
    { field: "invoice.number", value: "123", quote: "Invoice No. 123", doc: "invoice", page: 1, confidence: "high" },
    { field: "invoice.lines.1.hts", value: "1234.56.7890", quote: "1234.56.7890", doc: "invoice", page: 1, confidence: "low" }
  ],
  transcripts: [
    {
      doc: "invoice",
      page: 2,
      lines: [
        { text: "Page 2 Header", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.05 } },
        { text: "Item description", box: { x: 0.1, y: 0.2, w: 0.8, h: 0.04 } }
      ]
    }
  ]
}
```

### UsageState and Caps

**UsageState** (persisted in store):
```typescript
{
  totalCalls: 42,
  reservedCostNanoUsd: 52000000,
  days: {
    "2026-11-28": {
      calls: 10,
      visitors: {
        "9f86d081884c7d6d9ffd60bb3d": 3,
        "unknown": 7
      }
    },
    "2026-11-29": {
      calls: 32,
      visitors: {
        "9f86d081884c7d6d9ffd60bb3d": 2,
        "unknown": 30
      }
    }
  }
}
```

**Caps** (from config):
```typescript
{
  total: 300,
  daily: 0,
  perVisitorDaily: 3
}
```

**Cost cap:** `setup.costCapNanoUsd` = floor(costKrw x 1e9 / krwPerUsd), 6,666,666,666 for the public site.

---

## Independent Review Fixes (2026-11-18)

**Requirement 17 (Size and Cost Limit for One Reader Call):** Configuration limits in `intakeConfig.ts` (`perCall` object with `maxPageTextChars`, `maxTotalTextChars`, `maxImageBase64Chars`, `imageTokensPerPage`, `promptOverheadTokens`, `maxCallCostNanoUsd`, `readerMaxOutputTokens`, `readerTimeoutMs`; also `krwPerUsd`, `costKrw` in both public and local cap sets). Input validation in `readerContract.ts` (`validateReaderInput` size limits). Cost estimation in `budget.ts` (`estimateReaderCall` function), new `UsageState.reservedCostNanoUsd` field, new optional cost parameter and "cost_cap" reason in `decideCall` and `remainingCalls`. Environment variable `costCapNanoUsd` in `readerEnv.ts` with `DOCUMENT_INTAKE_COST_CAP_KRW` override. Route handler `intakeService.ts` returns 413 before any store access and reserves worst-case cost atomically with the call.

**Requirement 18 (Values Read from Images Are Confirmed by a Person):** After values are built in `draft.ts`, copied values with image-origin sources become `needsReview` with a confirmation message. StitchBoard adds a "Confirm this value" button in the source strip to apply the field's own value as a person edit, changing status to "personEdited".

**Requirement 19 (Invoice Lines Checked Against the Invoice):** Reader schema and prompt in `claudeReader.ts` include `invoiceLineCount`. Contract type and validator in `readerContract.ts`. Reading answer type in `reading.ts` includes optional `invoiceLineCount`. New "CHK.INVOICE" check field in `draft.ts` combining P2 checks, subtotal parsing, and line count comparison. Board passes `invoiceLineCount` to `buildDraft`.

**Requirement 20 (Every Accepted Value Points to Its Place):** Fallback box logic in `reading.ts` (`verifyReadings`) when quote is part of one item: use items that overlap the value. New reject reason "no_source_box" when no items overlap.

**Requirement 21 (Time Limit for the Reader Call) and Requirement 22 (Reader Errors Never Carry Document Text):** Claude reader in `claudeReader.ts` passes `timeout` (45,000 ms) to `messages.create`, maps `APIConnectionTimeoutError` before other connection errors, generates error message "The AI reader took longer than 45 seconds and was stopped. Try fewer pages." Validation reasons in `readerContract.ts` contain only positions and fixed words, never model-provided strings. Output schema in `claudeReader.ts` constrains "doc" field enum to the request document IDs. Configuration: `intakeConfig.ts` defines `readerMaxOutputTokens` (16,000) and `readerMinOutputTokens` (8,000) and `readerTimeoutMs` (45,000 ms). Tests get the SDK error classes through the export `SDK_ERRORS` of `claudeReader.ts`, because the SDK may be imported only in that file.

**UsageState Update:** Add `reservedCostNanoUsd: 52000000` (52 million nano-USD) to the example. Add line: "Cost cap: `setup.costCapNanoUsd` = floor(costKrw x 1e9 / krwPerUsd), 6,666,666,666 for the public site."

---

## Cross-Check Fixes (2026-11-20)

**Requirement 23 (A Cap Reservation Counts Only When the Store Confirms It):** `usageStoreBlobs.ts` (`writeState` requires `modified: true` and a non-empty `etag`); throw "usage state write was not confirmed by the store; not written" otherwise. Server answers 503 "Usage store unavailable; the AI reader was not called." when the write fails.

**Requirement 24 (The Worst Case Counts Every Byte, and the Ledger Gets the Actual Cost):** `intakeConfig.ts` adds `perCall.perPageOverheadTokens: 160`. `budget.ts` adds `utf8Bytes(s)` function (1 byte per code point below U+0080, 2 below U+0800, 3 below U+10000, 4 otherwise); byte-based `estimateReaderCall(input)` computing inputTokens from UTF-8 bytes of every text and file name in the request plus image page overhead; `addReservedCost(state, extraNanoUsd)` returning new state with incremented `reservedCostNanoUsd` without mutating input. `intakeService.ts` true-up logic after every call with token usage: compute actual cost, if above worst case add difference to `reservedCostNanoUsd`, read-apply-write up to 3 tries, log "usage cost top-up not written" (no document text) if all fail.

**Requirement 25 (The Reader Uses Only the App's Own Key and the Anthropic Address):** `readerEnv.ts` reads the key from `DOCUMENT_INTAKE_ANTHROPIC_KEY` only, never `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` (an environment with `ANTHROPIC_API_KEY` but without `DOCUMENT_INTAKE_ANTHROPIC_KEY` gives mode "off" with reason "no API key"). `claudeReader.ts` exports constant `ANTHROPIC_API_BASE_URL: "https://api.anthropic.com"` and exports function `createAnthropicClient(apiKey)` building the SDK client with `baseURL: ANTHROPIC_API_BASE_URL`, `maxRetries: 0`, `logLevel: "off"`, `openTelemetry: false`. `.kiro/steering/tech.md` references the new variable name `DOCUMENT_INTAKE_ANTHROPIC_KEY`.

**Requirement 26 (Values Computed from Image Readings Wait for a Person):** `draft.ts` defines `IMAGE_COMPUTED_REVIEW_REASON: "Computed from values the AI reader read from an image. Check them against the page, then confirm it."`. In the step of 18.1, computed values with image-origin sources get `needsReview` with this reason; confirming (applying own value) returns to "computed" with reason null and note "Confirmed by a person against the page.". After `recomputeTotals` and before Needs review list, a pass marks fields with "computed" or "copied" status that depend on image-waiting fields (those with `IMAGE_REVIEW_REASON` or `IMAGE_COMPUTED_REVIEW_REASON`) as `needsReview` with reason "Waiting on <ids>: values read from an image are not confirmed yet." where <ids> are the waiting fields in draft order, joined by ", ". `StitchBoard.tsx` shows the confirm button for both `IMAGE_REVIEW_REASON` and `IMAGE_COMPUTED_REVIEW_REASON`.

**Requirement 27 (Missing Amounts, Currency and Gross Weight Go to a Person):** `draft.ts` adds three cases in `buildDraft`: (1) no accepted invoice currency reading → all 36A get `needsReview` with "No invoice currency was read. A person checks that the amounts are in USD and enters the entered value." (2) no accepted amount for a 7501 line after currency is read and no P1 check failed → 36A for that line gets `needsReview` with "No accepted amount for invoice line <n>[, <m> ...]. A person enters the entered value." (3) no accepted packing-list total gross weight → all 34A get `needsReview` with "No total gross weight was read from the packing list. A person enters the gross weight."

**Requirement 28 (Small Guards on Requests, CSV Cells and Day Counts):** `src/server/requestGuard.ts` (`readRequestRefusal`, called first in `src/app/api/read/route.ts`), `csv.ts` (`escapeCsvCell` puts ' in front of =, +, -, @, tab, CR), `budget.ts` (`decideCall` keeps the previous, current and next UTC day).

---

## First Real Call Fixes (2026-11-23)

**Requirement 29 (The Reader's Answer Fits in One Call):** `intakeConfig.ts`: `readerMaxOutputTokens: 16000`, new `readerMinOutputTokens: 8000`. `budget.ts`: `estimateReaderCall` computes the output room under `perCall.maxCallCostNanoUsd` with the price of its input tokens, clamped to 8,000..16,000. `claudeReader.ts`: `buildReaderRequest` sends `thinking: { type: "disabled" }`, `max_tokens` from `estimateReaderCall`, and a schema whose transcript lines are `{ t, b }` (b: 4 integers, thousandths); the system prompt names "t" and "b" and asks for the JSON on one line; `createClaudeReader` converts `{ t, b }` to `{ text, box }` (each number / 1000) before `validateReaderOutput` and refuses a "b" that is not 4 integers from 0 to 1000.

**Requirement 30 (A Value Computed Again After a Person's Edit Still Waits):** `draft.ts`: after `recomputeTotals` and before the waiting pass of 26.3, the image rule of 18.1 and 26.1 runs again on fields whose note is not `CONFIRMED_NOTE`, so a value computed again from image readings (for example a line's 35 after its 33A is edited) waits. Totals carry no document sources and are not touched by this pass; they wait through 26.3 as before.

---

## Correctness Properties

*Properties are numbered to validate specific requirements and are verified by property-based and example tests. Property tests use fast-check to generate random inputs; example tests use concrete data. Properties 1 to 28 are defined above, 29 to 32 are defined in tasks 17 and 22, and 33 to 47 are defined below (47 in total).*

### Property 1: Transcript Structure Preservation

For any transcript (array of non-empty lines with text and boxes in 0..1), the resulting `PageText` SHALL satisfy:
- Every item's span slices correctly back to its text (no misalignment)
- Every box is within page bounds [0, 1] × [0, 1]
- Text is items joined by single spaces
- All non-empty lines are preserved

**Validates: Requirements 4.1**

### Property 2: Confidence Always Rejects Low

For any reading with `confidence: "low"`, `verifyReadings` SHALL reject the reading with `reason: "low_confidence"` and never become a copied value in the draft.

**Validates: Requirements 5.1**

### Property 3: Absent Confidence Treated as Passed

For any reading without a `confidence` field (undefined), `verifyReadings` SHALL NOT reject based on confidence.

**Validates: Requirements 5.3**

### Property 4: Every Copied Value Has Source

For any reading that `verifyReadings` accepts, the draft builder SHALL create a copied value with a `DocSource` carrying doc, page, and a box inside the page.

**Validates: Requirements 4.2, 14.2**

### Property 5: Image-Origin Sources Labelled Distinctly

For any `DocSource` with `origin === "imageTranscript"`, the CSV `formatSource` SHALL append " (read from an image by the AI reader)".

**Validates: Requirements 4.3**

### Property 6: Image-Origin Sources Only for Image Pages

For any reading from a text-layer page (where `PageText.origin` is absent or "textLayer"), the returned `DocSource` SHALL NOT have `origin` set.

**Validates: Requirements 4.4**

### Property 7: Cap Enforcement Never Exceeds Limit

For any sequence of `decideCall` invocations with a given `total`, `daily`, and `perVisitorDaily` cap setting, the number of calls where `allowed: true` SHALL NOT exceed any cap for any visitor or day.

**Validates: Requirements 11.1, 11.2, 11.3**

### Property 8: Cap Counters Equal Allowed Calls

For any sequence of decisions, the count of `allowed: true` results SHALL equal the increment to `UsageState.totalCalls` and to the day's and visitor's call counts.

**Validates: Requirements 11.7, 11.8**

### Property 9: Cap State Not Mutated

For any invocation of `decideCall`, the input `UsageState` SHALL never be mutated; the output `next` state is a new object.

**Validates: Requirement 11 (design principle)**

### Property 10: Remaining Calls Never Negative

For any call to `remainingCalls`, the result SHALL be >= 0 and SHALL be 0 exactly when the next `decideCall` would return `allowed: false`.

**Validates: Requirement 11**

### Property 11: Cost Estimate Monotonic in Tokens

For any two pairs of token counts (t1_input, t1_output) and (t2_input, t2_output) where t1_input <= t2_input AND t1_output <= t2_output, the estimated cost for the first pair SHALL be <= the cost for the second pair.

**Validates: Requirement 10.1, property tests**

### Property 12: Cost Estimate Additive

For any two calls, the sum of individual cost estimates SHALL equal the cost estimate for the combined token counts.

**Validates: Requirement 10.1**

### Property 13: Resolver Mode Respects Kill Switch

For any environment where `DOCUMENT_INTAKE_KILL_SWITCH` is set to a non-empty value, `resolveReaderSetup` SHALL return mode "off" regardless of other environment variables.

**Validates: Requirements 7.1**

### Property 14: Resolver Mode Fake Needs No Key

For any environment where `DOCUMENT_INTAKE_MODE=fake`, `resolveReaderSetup` SHALL return mode "fake" without requiring `DOCUMENT_INTAKE_ANTHROPIC_KEY`.

**Validates: Requirements 7.1**

### Property 15: Resolver Mode Claude Needs Key and Store

For any environment where mode would be "claude", both `DOCUMENT_INTAKE_ANTHROPIC_KEY` and a durable store (`DOCUMENT_INTAKE_STORE=file`) SHALL be set.

**Validates: Requirements 7.1**

### Property 16: Resolver Provides Reason When Off

For any environment where mode is "off", the `reason` field SHALL contain a short plain message explaining why (e.g., "no API key", "kill switch is on", "no durable usage store configured").

**Validates: Requirements 7.1**

### Property 17: Visitor Key Day-Specific

For any visitor with a given IP and salt, the visitor key for day D1 SHALL differ from the visitor key for day D2 (when D1 ≠ D2).

**Validates: Requirements 11.4**

### Property 18: Visitor Key Missing Salt Fallback

For any visitor when `DOCUMENT_INTAKE_VISITOR_SALT` is not set, the visitor key SHALL be "unknown" (a shared key, making all visitors counted together).

**Validates: Requirements 11.3**

### Property 19: Fake Reader SHA-256 Matching

For any pre-recorded set of files matching the reader input files exactly (sorted SHA-256 set), the fake reader SHALL return the recorded answer. For any other file set, the fake reader SHALL reject with "no recorded answer for these files".

**Validates: Requirements 9.1**

### Property 20: Claude Reader No Retries

For the Claude reader, the SDK client SHALL be created with `maxRetries: 0`, so failed API calls do not retry.

**Validates: Requirements 8.1, 8.2**

### Property 21: Claude Reader Stop Reason Check

For the Claude reader, if `response.stop_reason` is not "end_turn", the reader SHALL reject with a plain message (not throw an exception).

**Validates: Requirements 8.5**

### Property 22: Claude Reader Request Shape

For the Claude reader constructing a request, images SHALL be base64-encoded, all field names SHALL be from the field catalog, the system prompt SHALL instruct the reader never to choose HTS numbers, and the output_config SHALL enforce JSON schema with additionalProperties: false.

**Validates: Requirements 3.1, 5.5, 8.1**

### Property 23: Handle Read Request Reserves Before Call

For the `handleReadRequest` function when mode is "claude", cap state SHALL be written to the durable store BEFORE the reader is called. If the write fails, the model SHALL NOT be called.

**Validates: Requirements 10.5, 11.5**

### Property 24: Handle Read Request No Echo

For any error in `handleReadRequest`, the response SHALL NOT echo the request body.

**Validates: Requirement 12.3**

### Property 25: Prepare Upload Validation Errors

For any file that fails validation in `prepareUpload` (file size, PDF pages, image count, request size), the function SHALL throw a plain error message and NEVER upload the file.

**Validates: Requirements 1.2, 1.3**

### Property 26: Prepare Upload No Persistence

For the `prepareUpload` function, files and rendered images SHALL NOT be written to disk or stored in localStorage after processing.

**Validates: Requirement 2.3**

### Property 27: Sample Bundle CSV Byte-Identical

For the sample bundle, running the pipeline exactly as today (frozen reader, same documents, no AI call) and exporting to CSV SHALL produce the same byte sequence as today.

**Validates: Requirements 15.3**

### Property 28: Transcript Round-Trip

For any transcript item used as a whole quote, with a value extracted from inside that line, and when that line text is unique on the page, `verifyReadings` SHALL accept the reading and return a box inside the page.

**Validates: Requirements 4.2, 14.3**

### Property 33: Per-Call Line Holds Before Any Spending

For any valid reader input, `estimateReaderCall` never decreases when page text or an image page is added; when its worst-case cost is above `maxCallCostNanoUsd`, `handleReadRequest` answers 413 and calls neither the reader nor the store's `writeState`.

**Validates: Requirements 17.2, 17.3, 17.7**

### Property 34: Cost Ledger Never Exceeds the Won Cap

For any sequence of calls with worst-case costs c_i under a cost cap C, the allowed calls satisfy sum(c_i) <= C, `reservedCostNanoUsd` equals that sum, and a call is refused with "cost_cap" exactly when reserved + c > C (other caps permitting).

**Validates: Requirements 17.4, 17.5**

### Property 35: Image Values Wait for a Person

For any draft built from readings with image origins, no field with an image-origin document source has status "copied" or "computed"; confirming every image-waiting field (reason `IMAGE_REVIEW_REASON` or `IMAGE_COMPUTED_REVIEW_REASON`) with its own value gives every field the status, value, reason and rule it has in the draft built without image origins, and each confirmed field keeps its sources and gets the note "Confirmed by a person against the page."

**Validates: Requirements 18.1, 18.3, 26.1, 26.2, 26.3**

### Property 36: A Missing Invoice Line Is Flagged

Removing every reading of any one invoice line while the subtotal stays, removing the subtotal, or giving a line count that differs from the lines read always puts "CHK.INVOICE" in Needs review; the sample bundle never gets it.

**Validates: Requirements 19.1, 19.3**

### Property 37: Partial Quotes Keep a Box

For any accepted reading the box has positive width and height and lies on its page; a quote that is part of one text item gets that item's box; readings that had a box keep it.

**Validates: Requirements 20.1, 20.2, 20.3**

### Property 38: Reader Call Limits and No Document Text in Errors

The Claude reader sends `max_tokens` 8,000 and a 45,000 ms timeout; a timeout maps to the fixed message; for any reader answer with arbitrary strings in "field" and "doc", a failed validation reason contains none of those strings.

**Validates: Requirements 21, 22**

### Property 39: Unconfirmed Cap Writes Stop the Call

For any number of requests against a usage store whose conditional writes answer `{ modified: true }` with an empty or missing `etag`, `handleReadRequest` answers 503 every time and never calls the reader; with a store that answers real etags, at most `caps.total` requests reach the reader.

**Validates: Requirements 23.1, 23.2**

### Property 40: The Byte Count Bounds Any Text

For any valid reader input whose texts may hold any code point, `estimateReaderCall(input).inputTokens` equals `promptOverheadTokens` + for every page (`perPageOverheadTokens` + utf8Bytes(fileName) + 4 x utf8Bytes(docId) + utf8Bytes(text) or `imageTokensPerPage`), utf8Bytes equals `new TextEncoder().encode(s).length` for strings without lone surrogates, and every input whose worst case passes the per-call line has at most 68,000 input tokens.

**Validates: Requirements 24.1, 24.2**

### Property 41: The Ledger Holds the Actual Cost

For any reserved worst case w and reported usage (input i, output o) of a call, after the call `reservedCostNanoUsd` has grown by max(w, `estimateCostNanoUsd(i, o)`); `addReservedCost` never lowers the total and leaves the rest of the state unchanged.

**Validates: Requirements 24.3, 24.4**

### Property 42: Platform Variables Cannot Turn the Reader On

For any environment, the mode, reason and apiKey of `resolveReaderSetup` do not change when `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` is added or removed; the client from `createAnthropicClient` has `baseURL` "https://api.anthropic.com" whatever `ANTHROPIC_BASE_URL` says.

**Validates: Requirements 25.1, 25.2**

### Property 43: Waiting Fields Name What They Wait On

For any draft built from readings with image origins, no field with status "computed" or "copied" depends on an image-waiting field, and every field whose reason ends with "values read from an image are not confirmed yet." names exactly the image-waiting fields it depends on.

**Validates: Requirements 26.3**

### Property 44: A Missing Amount, Currency or Gross Weight Is Never Computed

Removing any non-empty set of invoice line amounts, the invoice currency, or the packing list total gross weight from the sample readings never gives a "computed" 36A for a line that lost an amount (or any 36A without a currency), a "computed" 34A without a total gross weight, or a "computed" 38, B39 or total with value 0 or 0.00 that the full sample does not have; the full sample is unchanged.

**Validates: Requirements 27.1 to 27.5**

### Property 45: Small Guards Hold

For any content type other than "application/json" (with or without parameters) `readRequestRefusal` gives 415, for any `sec-fetch-site` other than "same-origin" and "none" it gives 403, and a same-origin JSON request gives null; for any string, the CSV cell `draftToCsv` writes never starts with =, +, -, @, tab or CR; for any state and any time, `decideCall` keeps every stored count of the previous, current and next UTC day.

**Validates: Requirements 28.1, 28.2, 28.3**

### Property 46: The Answer Room Stays Under the Line
For any valid reader input, `estimateReaderCall(input).outputTokens` is between 8,000 and 16,000; the worst case is at most `perCall.maxCallCostNanoUsd` exactly when the input tokens are at most 68,000, and then outputTokens is the largest number up to 16,000 that keeps it so; `buildReaderRequest(input).max_tokens` equals outputTokens and the request has `thinking: { type: "disabled" }`; the Claude reader turns any transcript line whose "b" is 4 integers from 0 to 1000 into a box with each number divided by 1000, and refuses any other "b".
**Validates: Requirements 29.1, 29.2, 29.4**

### Property 47: An Edit Never Makes an Unchecked Image Value Final
For the sample bundle with every page marked as an image transcript and any single person edit (a line's 33A to another number of the HTS subset, a line's 10 to another country code, or a line's 36A to another whole-dollar amount), no field has status "computed" or "copied" with a document source of origin "imageTranscript" unless its note is "Confirmed by a person against the page."; with the text pages, the same edits give no field the reason `IMAGE_REVIEW_REASON` or `IMAGE_COMPUTED_REVIEW_REASON`.
**Validates: Requirements 30.1, 30.3**

---

## Error Handling

### Result Type Pattern

All core modules return `RuleResult<T>` for business-logic issues and throw `Error` for programmer violations (matching the entry-math pattern):

```typescript
// Business logic: return NeedsReview
if (fileSize > maxFileBytes) {
  return { ok: false, reason: `File too large (${fileSize / 1e6} MB, max ${maxFileBytes / 1e6} MB)` };
}

// Programmer error: throw
if (typeof input !== "object" || !input) {
  throw new Error(`Expected object, got ${typeof input}`);
}

// Success: return OkResult
return { ok: true, value: result };
```

### Server Error Responses

| Scenario | Status | Response | Rationale |
|----------|--------|----------|-----------|
| Mode "off" | 503 | `{ ok: false, reason }` | Service unavailable; user retries later |
| Invalid ReaderInput | 400 | `{ ok: false, message }` | Client error; user fixes and retries |
| Cap exceeded | 429 | `{ ok: false, message, remaining }` | Too many requests; user retries tomorrow |
| State write fails | 503 | `{ ok: false, message }` | Fail closed; cannot record the call |
| Reader call fails | 502 | `{ ok: false, message }` | Bad gateway (AI service error); user retries |
| Success | 200 | `{ ok: true, mode, output, remaining }` | Proceed with draft |

### Validation Errors (Plain Messages)

All validation errors thrown or returned are plain, user-facing:
- "PDF file too large (15 MB, max 10 MB)"
- "JPEG photo exceeds max image pages (7, max 6)"
- "Too many files (4, max 3)"
- "API error: authentication failed; check your key"
- "no recorded answer for these files"
- "The reader marked this value as uncertain."

---

## Testing Strategy

### Property-Based Tests (fast-check, one per property)

Each `.property.test.ts` file validates one correctness property with randomly generated inputs:

- `transcript.property.test.ts`: Property 1 (transcript structure, 100 iterations)
- `reading.property.test.ts`: Properties 2–6 (confidence, sources, labeling)
- `budget.property.test.ts`: Properties 7–12 (caps, remaining, cost)
- `readerEnv.property.test.ts`: Properties 13–16 (mode logic, kill switch, reason)
- `visitorKey.property.test.ts`: Properties 17–18 (day-specific, fallback)
- `intakeService.property.test.ts`: Properties 23–24 (reserve-before-call, no echo)
- `prepareUpload.property.test.ts`: Properties 25–26 (validation, no disk)

### Example Tests (for concrete, mandatory cases)

- `fakeReader.test.ts`: Property 19 (recording lookup by SHA-256)
- `claudeReader.test.ts`: Properties 20–22 (no retries, stop reason, request shape, injected fake client)
- `intakeService.test.ts`: Property 23 (reserve-before-call), Property 24 (cap refusal), status endpoint
- `stitch.test.ts`: Property 27 (sample bundle CSV byte-identical)

### No Network Calls

All tests are offline:
- Real reader uses an injected fake Anthropic client (mock `messages.create`)
- Fake reader uses pre-recorded data
- All server tests are synchronous and in-memory or file-based

---

## Module Layout Summary

**Pure, Browser-Safe** (re-exported from `src/core/index.ts`):
- `intakeConfig.ts`: limits, prices
- `fieldCatalog.ts`: field names and descriptions
- `transcript.ts`: `transcriptToPageText`
- `pdfText.ts`: `PageText` with optional `origin`
- `reading.ts`: `FieldReading` with `confidence`, new `"low_confidence"` reason
- `draft.ts`: `DocSource` with optional `origin`
- `csv.ts`: `formatSource` with image label
- `readerContract.ts`: input/output shapes and validators
- `budget.ts`: cap decision, cost estimation

**Server-Only** (`src/server/`):
- `readerEnv.ts`: environment resolution
- `usageStore.ts`: state persistence interface
- `visitorKey.ts`: salted IP hashing
- `fakeReader.ts`: test reader
- `claudeReader.ts`: real reader
- `intakeService.ts`: request orchestration

**Browser UI** (`src/app/`):
- `intake/prepareFiles.ts`: file preparation
- `intake/UploadPanel.tsx`: upload panel
- `StitchBoard.tsx`: source state, upload mode

---

## Section Count

**Sections:** Overview, Architecture, Components and Interfaces (18 modules/functions), Data Models, Correctness Properties (47 properties: 1 to 28, 33 to 47 here, 29 to 32 in tasks 17 and 22), Error Handling, Testing Strategy.

**Total Correctness Properties:** 47
