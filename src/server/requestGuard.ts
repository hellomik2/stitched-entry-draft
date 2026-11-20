// Requirement 28.1: browsers cannot send application/json to another site without asking first, so a page on another
// site cannot use a visitor's browser to spend the demo's AI reads.
export type RequestRefusal = { status: 403 | 415; message: string };

export function readRequestRefusal(headers: { get(name: string): string | null }): RequestRefusal | null {
  const type = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return { status: 415, message: "Send the documents as JSON." };
  }

  const site = headers.get("sec-fetch-site");
  if (site !== null) {
    const siteNorm = site.trim().toLowerCase();
    if (siteNorm !== "same-origin" && siteNorm !== "none") {
      return { status: 403, message: "Requests from other sites are not accepted." };
    }
  }

  return null;
}
