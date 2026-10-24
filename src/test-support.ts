import { gunzipSync } from "node:zlib";

// Test-only helper (not a tsup entry): decodes single-event JSON and NDJSON batch bodies.
export function decodeEvents(init: RequestInit | undefined): Record<string, any>[] {
  const body = init?.body;
  if (body === undefined || body === null) return [];

  const headers = (init?.headers ?? {}) as Record<string, string>;
  const text = body instanceof ArrayBuffer || ArrayBuffer.isView(body)
    ? (headers["content-encoding"] === "gzip"
      ? gunzipSync(Buffer.from(body as ArrayBuffer)).toString("utf8")
      : Buffer.from(body as ArrayBuffer).toString("utf8"))
    : String(body);

  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).event);
}

export function deliveredEvents(calls: ReadonlyArray<readonly unknown[]>): Record<string, any>[] {
  return calls.flatMap((call) => decodeEvents(call[1] as RequestInit | undefined));
}
