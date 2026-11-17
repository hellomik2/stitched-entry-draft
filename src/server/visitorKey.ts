import { createHash } from "node:crypto";

export function visitorKey(ip: string | null, salt: string | null, dayUtc: string): string {
  if (!ip || ip.length === 0 || !salt || salt.length === 0) {
    return "unknown";
  }

  const input = `${salt}|${dayUtc}|${ip}`;
  return createHash("sha256").update(input).digest("hex");
}

export function clientIp(headers: { get(name: string): string | null }): string | null {
  // Check x-nf-client-connection-ip first (Netlify platform header, connecting address)
  const xNfClient = headers.get("x-nf-client-connection-ip");
  if (xNfClient) {
    const trimmed = xNfClient.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  // Fall back to first x-forwarded-for entry
  const xForwardedFor = headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  return null;
}
