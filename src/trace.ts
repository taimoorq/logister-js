import type { CaptureOptions, LogisterContext } from "./types";

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly requestId: string;
  readonly flags: string;
}

const hex = (length: number): string => crypto.randomUUID().replaceAll("-", "").slice(0, length);
export function parseTraceparent(value: string | undefined): Pick<TraceContext, "traceId" | "spanId" | "flags"> | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value ?? "");
  if (value?.length !== 55 || !match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return undefined;
  return { traceId: match[1]!, spanId: match[2]!, flags: match[3]! };
}
export function createTraceContext(parent?: TraceContext): TraceContext {
  return Object.freeze({ traceId: parent?.traceId ?? hex(32), spanId: hex(16), parentSpanId: parent?.spanId,
    requestId: parent?.requestId ?? crypto.randomUUID(), flags: parent?.flags ?? "01" });
}
export function incomingTraceContext(traceparent?: string, requestId?: string, legacyTraceId?: string): TraceContext {
  const parsed = parseTraceparent(traceparent);
  const traceId = parsed?.traceId ?? (legacyTraceId && /^[A-Za-z0-9._:-]{1,128}$(?![\s\S])/.test(legacyTraceId) ? legacyTraceId : hex(32));
  return Object.freeze({ traceId, spanId: hex(16), parentSpanId: parsed?.spanId,
    requestId: requestId && /^[A-Za-z0-9._:-]{1,200}$(?![\s\S])/.test(requestId) ? requestId : crypto.randomUUID(), flags: parsed?.flags ?? "01" });
}
export function traceFields(trace: TraceContext | undefined): LogisterContext {
  return trace ? { trace_id: trace.traceId, span_id: trace.spanId, parent_span_id: trace.parentSpanId, request_id: trace.requestId } : {};
}
export function traceOptions(trace: TraceContext): CaptureOptions {
  return { traceId: trace.traceId, spanId: trace.spanId, parentSpanId: trace.parentSpanId, requestId: trace.requestId };
}
export function traceHeaders(trace: TraceContext, url: string | URL, allowedOrigins: readonly string[]): Record<string, string> {
  const origin = safeOrigin(url);
  if (!origin || !allowedOrigins.some(value => safeOrigin(value) === origin) || !parseTraceparent(`00-${trace.traceId}-${trace.spanId}-${trace.flags}`) || !/^[A-Za-z0-9._:-]{1,200}$(?![\s\S])/.test(trace.requestId)) return {};
  return { traceparent: `00-${trace.traceId}-${trace.spanId}-${trace.flags}`, "x-request-id": trace.requestId };
}
function safeOrigin(value: string | URL): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : undefined;
  } catch { return undefined; }
}
