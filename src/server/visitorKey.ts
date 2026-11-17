import { createHash } from "node:crypto";

export function visitorKey(ip: string | null, salt: string | null, dayUtc: string): string {
  if (!ip || ip.length === 0 || !salt || salt.length === 0) {
    return "unknown";
  }

  const input = `${salt}|${dayUtc}|${ip}`;
  return createHash("sha256").update(input).digest("hex");
}

export function clientIp(headers: { get(name: string): string | null }): string | null {
  // Try x-forwarded-for first
  const xForwardedFor = headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  // Fall back to x-nf-client-connection-ip
  const xNfClient = headers.get("x-nf-client-connection-ip");
  if (xNfClient) {
    return xNfClient;
  }

  return null;
}
