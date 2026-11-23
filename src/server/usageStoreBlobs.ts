import { randomUUID } from "node:crypto";
import type { UsageState } from "../core/budget";
import { emptyUsageState } from "../core/budget";
import type { UsageRecord } from "./readerTypes";
import type { UsageStore } from "./usageStore";
import { parseUsageState, UsageStateConflictError } from "./usageStore";

export type BlobsLike = {
  getWithMetadata(key: string): Promise<{ data: unknown; etag?: string } | null>;
  setJSON(key: string, data: unknown, options?: { onlyIfMatch?: string; onlyIfNew?: boolean }): Promise<{ modified: boolean; etag?: string }>;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// Requirement 42.2: an answer that is not 2xx never carries an ETag, so the library cannot report it as a confirmed write.
export function dropEtagOnError(base?: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await (base ?? globalThis.fetch)(input, init);
    if ((res.status >= 200 && res.status <= 299) || !res.headers.has("etag")) {
      return res;
    }
    const headers = new Headers(res.headers);
    headers.delete("etag");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

export const BLOBS_STORE_NAME = "document-intake-usage";
export const BLOBS_STATE_KEY = "caps-state";

async function openNetlifyBlobs(name: string): Promise<BlobsLike> {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name, consistency: "strong", fetch: dropEtagOnError() as typeof fetch });
  return {
    getWithMetadata: (key) => store.getWithMetadata(key, { type: "json" }),
    setJSON: (key, data, options) =>
      store.setJSON(key, data, options?.onlyIfMatch ? { onlyIfMatch: options.onlyIfMatch } : options?.onlyIfNew ? { onlyIfNew: true } : {}),
  };
}

export function createBlobsUsageStore(options: { blobs?: BlobsLike; storeName?: string } = {}): UsageStore {
  // One instance per request. writeState is a conditional write against the version this instance read,
  // so two requests that read the same state cannot both reserve a call: the second write fails and
  // the service does not call the reader.

  let blobsPromise: Promise<BlobsLike> | null = null;
  let lastRead: { exists: false } | { exists: true; etag: string | null } | null = null;

  async function getBlobs(): Promise<BlobsLike> {
    if (options.blobs) {
      return options.blobs;
    }
    if (!blobsPromise) {
      blobsPromise = openNetlifyBlobs(options.storeName ?? BLOBS_STORE_NAME);
    }
    return blobsPromise;
  }

  return {
    async readState(): Promise<UsageState> {
      const blobs = await getBlobs();
      const entry = await blobs.getWithMetadata(BLOBS_STATE_KEY);

      if (entry === null) {
        lastRead = { exists: false };
        return emptyUsageState();
      }

      const state = parseUsageState(entry.data);
      lastRead = { exists: true, etag: entry.etag ?? null };
      return state;
    },

    async writeState(s: UsageState): Promise<void> {
      if (lastRead === null) {
        throw new Error("usage state must be read before it is written");
      }

      const blobs = await getBlobs();
      let r: { modified: boolean; etag?: string };

      if (!lastRead.exists) {
        r = await blobs.setJSON(BLOBS_STATE_KEY, s, { onlyIfNew: true });
      } else if (lastRead.etag) {
        r = await blobs.setJSON(BLOBS_STATE_KEY, s, { onlyIfMatch: lastRead.etag });
      } else {
        throw new Error("usage state has no version tag; not written");
      }

      if (!r.modified) {
        throw new UsageStateConflictError();
      }

      // Requirement 23: the installed @netlify/blobs answers a conditional write with
      // { modified: true, etag: "" } for every HTTP status other than 412 (403, 429, 5xx after
      // its retries), so modified alone does not prove the write was confirmed by the store.
      if (typeof r.etag !== "string" || r.etag.length === 0) {
        throw new Error("usage state write was not confirmed by the store; not written");
      }

      lastRead = { exists: true, etag: r.etag };
    },

    async appendRecord(r: UsageRecord): Promise<void> {
      const blobs = await getBlobs();
      const key = `usage/${r.timestamp.replace(/[^0-9]/g, "")}-${randomUUID()}`;
      const result = await blobs.setJSON(key, r, { onlyIfNew: true });
      
      if (!result.modified || typeof result.etag !== "string" || result.etag.length === 0) {
        throw new Error("usage record write was not confirmed by the store; not written");
      }
    },
  };
}
