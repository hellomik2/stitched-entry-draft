import * as path from "node:path";
import {
  resolveReaderSetup,
  createFileUsageStore,
  createBlobsUsageStore,
  clientIp,
  handleStatusRequest,
  type UsageStore,
} from "../../../server/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const setup = resolveReaderSetup(process.env);

  // Set up store (only needed for claude mode)
  let store: UsageStore | null = null;
  if (setup.mode === "claude" && setup.store === "file") {
    store = createFileUsageStore(path.join(/*turbopackIgnore: true*/ process.cwd(), setup.storeDir));
  } else if (setup.mode === "claude" && setup.store === "netlify-blobs") {
    store = createBlobsUsageStore();
  }

  // Call the service
  const result = await handleStatusRequest({
    setup,
    store,
    nowIso: new Date().toISOString(),
    ip: clientIp(request.headers),
  });

  return Response.json(result.json, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
}
