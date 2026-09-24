import { AsyncLocalStorage } from "node:async_hooks";
import type { LogisterClient } from "./client";
import { traceFields, type TraceContext } from "./trace";

// Share the storage across the package's independently bundled CJS/ESM entries.
const key = Symbol.for("logister.traceScope.v1");
const registry = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<TraceContext> };
export const traceScope = registry[key] ??= new AsyncLocalStorage<TraceContext>();
export const currentTraceContext = (): TraceContext | undefined => traceScope.getStore();
export function enableNodeRequestContext(client: LogisterClient): void {
  client.setRequestContextProvider(() => traceFields(currentTraceContext()));
}
export function withTraceContext<T>(trace: TraceContext, callback: () => T): T {
  return traceScope.run(trace, callback);
}
