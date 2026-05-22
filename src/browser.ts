import { LogisterClient } from "./client";
import type { LogisterContext } from "./types";

export interface BrowserPageLoadOptions {
  traceId?: string | undefined;
  route?: string | undefined;
  context?: LogisterContext | undefined;
  includeResources?: boolean | undefined;
  maxResources?: number | undefined;
  performance?: Performance | undefined;
}

export async function capturePageLoad(client: LogisterClient, options: BrowserPageLoadOptions = {}): Promise<void> {
  const performanceRef = options.performance ?? globalThis.performance;
  if (!performanceRef?.getEntriesByType) return;

  const navigation = performanceRef.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const traceId = options.traceId ?? randomTraceId();
  const route = options.route ?? globalThis.location?.pathname ?? "page.load";
  const rootSpanId = randomSpanId();
  const totalDuration = navigation?.duration ?? performanceRef.now();
  const startedAt = new Date(Date.now() - Math.max(0, totalDuration)).toISOString();

  await client.captureSpan(route, totalDuration, {
    kind: "browser",
    traceId,
    spanId: rootSpanId,
    startedAt,
    context: {
      ...options.context,
      route,
      navigation: navigation ? navigationBreakdown(navigation) : undefined
    }
  });

  if (options.includeResources === false) return;

  const resources = performanceRef
    .getEntriesByType("resource")
    .filter((entry): entry is PerformanceResourceTiming => entry.entryType === "resource")
    .sort((a, b) => b.duration - a.duration)
    .slice(0, options.maxResources ?? 20);

  await Promise.all(resources.map((resource) => client.captureSpan(resourceName(resource.name), resource.duration, {
    kind: "resource",
    traceId,
    parentSpanId: rootSpanId,
    startedAt: new Date(Date.now() - Math.max(0, totalDuration - resource.startTime)).toISOString(),
    context: {
      route,
      resource: {
        name: resource.name,
        initiator_type: resource.initiatorType,
        transfer_size: resource.transferSize,
        encoded_body_size: resource.encodedBodySize,
        decoded_body_size: resource.decodedBodySize
      }
    }
  })));
}

function navigationBreakdown(entry: PerformanceNavigationTiming): LogisterContext {
  return {
    dns_ms: entry.domainLookupEnd - entry.domainLookupStart,
    connect_ms: entry.connectEnd - entry.connectStart,
    tls_ms: entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0,
    request_ms: entry.responseStart - entry.requestStart,
    response_ms: entry.responseEnd - entry.responseStart,
    dom_interactive_ms: entry.domInteractive,
    dom_content_loaded_ms: entry.domContentLoadedEventEnd,
    load_event_ms: entry.loadEventEnd,
    transfer_size: entry.transferSize,
    encoded_body_size: entry.encodedBodySize,
    decoded_body_size: entry.decodedBodySize
  };
}

function resourceName(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return value;
  }
}

function randomTraceId(): string {
  return randomHex(16);
}

function randomSpanId(): string {
  return randomHex(8);
}

function randomHex(bytes: number): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.getRandomValues) {
    const values = cryptoRef.getRandomValues(new Uint8Array(bytes));
    return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, bytes * 2);
}
