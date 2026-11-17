import * as path from "node:path";
import { intakeConfig } from "../../../core/intakeConfig";
import {
  resolveReaderSetup,
  createFileUsageStore,
  createMemoryUsageStore,
  createFakeReader,
  loadRecordings,
  clientIp,
  handleReadRequest,
  type IntakeReader,
  type UsageStore,
} from "../../../server/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Module-level cache for readers and stores
let cachedFakeReader: IntakeReader | null = null;
let cachedMemoryFakeStore: UsageStore | null = null;

async function getFakeReader(): Promise<IntakeReader | null> {
  if (cachedFakeReader) {
    return cachedFakeReader;
  }

  const recordingsPath = path.join(/*turbopackIgnore: true*/ process.cwd(), "samples", "upload-test", "recordings");
  const recordings = await loadRecordings(recordingsPath);

  if (recordings.length === 0) {
    return null;
  }

  cachedFakeReader = createFakeReader(recordings);
  return cachedFakeReader;
}

function getMemoryFakeStore(): UsageStore {
  if (!cachedMemoryFakeStore) {
    cachedMemoryFakeStore = createMemoryUsageStore();
  }
  return cachedMemoryFakeStore;
}

export async function POST(request: Request): Promise<Response> {
  const setup = resolveReaderSetup(process.env);

  // Check content-length header
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > intakeConfig.maxRequestBytes) {
      return Response.json(
        {
          ok: false,
          message: "The request is too large.",
        },
        { status: 413, headers: { "cache-control": "no-store" } },
      );
    }
  }

  // Read request body as text
  let text: string;
  try {
    text = await request.text();
  } catch (e) {
    return Response.json(
      {
        ok: false,
        message: "Failed to read request body.",
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  // Check request size
  const bodyBytes = Buffer.byteLength(text, "utf8");
  if (bodyBytes > intakeConfig.maxRequestBytes) {
    return Response.json(
      {
        ok: false,
        message: "The request is too large.",
      },
      { status: 413, headers: { "cache-control": "no-store" } },
    );
  }

  // Parse JSON
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return Response.json(
      {
        ok: false,
        message: "The request is not valid JSON.",
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  // Set up readers
  const readers: { fake?: IntakeReader; claude?: IntakeReader } = {};

  if (setup.mode === "fake") {
    const fakeReader = await getFakeReader();
    if (fakeReader) {
      readers.fake = fakeReader;
    }
  }

  // Set up stores
  let store: UsageStore | null = null;
  if (setup.mode === "claude" && setup.store === "file") {
    store = createFileUsageStore(path.join(/*turbopackIgnore: true*/ process.cwd(), setup.storeDir));
  }

  const fakeStore = getMemoryFakeStore();

  // Call the service
  const result = await handleReadRequest({
    setup,
    store,
    fakeStore,
    readers,
    nowIso: new Date().toISOString(),
    ip: clientIp(request.headers),
    bodyBytes,
    body,
    log: (m) => console.error(`[document-intake] ${m}`),
  });

  return Response.json(result.json, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
}
