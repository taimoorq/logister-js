import type { LogisterClient } from "./client";
import { createTraceContext, parseTraceparent, traceHeaders, traceOptions, type TraceContext } from "./trace";

export class LogisterFetchError extends Error {
  constructor(cause: unknown, readonly traceContext: TraceContext | undefined) {
    super("Application HTTP request failed", { cause });
    this.name = "LogisterFetchError";
  }
}

/** Uses manual redirects so caller credentials and trace headers cannot be forwarded
 * to another origin. Use only for application traffic; SDK exports use their own fetch. */
export function createTracedFetch(client: LogisterClient, options: { allowedOrigins: readonly string[]; excludedUrls?: readonly string[]; fetch?: typeof fetch; currentTrace?: () => TraceContext | undefined }) {
  const transport = options.fetch ?? fetch;
  return async (input: RequestInfo | URL, init?: RequestInit, parent?: TraceContext): Promise<{ response: Response; traceContext: TraceContext | undefined }> => {
    const request = new Request(input, { ...init, redirect: "manual" });
    const parsed = parseTraceparent(request.headers.get("traceparent") ?? undefined);
    const fresh = createTraceContext(parent ?? options.currentTrace?.());
    const requestId = request.headers.get("x-request-id");
    const candidate = parsed ? Object.freeze({ ...fresh, ...parsed, parentSpanId: undefined,
      requestId: requestId && /^[A-Za-z0-9._:-]{1,200}$(?![\s\S])/.test(requestId) ? requestId : fresh.requestId }) : fresh;
    const headers = client.isTelemetryUrl(request.url) || options.excludedUrls?.some(value => sameEndpoint(value, request.url)) ? {} : traceHeaders(candidate, request.url, options.allowedOrigins);
    const trace = Object.keys(headers).length ? candidate : undefined;
    if (!trace) ["traceparent", "tracestate", "x-request-id"].forEach(name => request.headers.delete(name));
    Object.entries(headers).forEach(([name, value]) => request.headers.set(name, value));
    const startedAt = new Date();
    const start = performance.now();
    let failed = false;
    try {
      const response = await transport(request);
      failed = response.status >= 500;
      return { response, traceContext: trace };
    } catch (error) {
      failed = true;
      throw new LogisterFetchError(error, trace);
    } finally {
      if (trace) void client.captureSpan("HTTP request", performance.now() - start, {
        ...traceOptions(trace), kind: "http", status: failed ? "error" : "ok", startedAt
      }).catch(() => undefined);
    }
  };
}

function sameEndpoint(first: string, second: string): boolean {
  try { const a = new URL(first); const b = new URL(second); return a.origin === b.origin && a.pathname === b.pathname; } catch { return false; }
}
