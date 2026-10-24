import { incomingTraceContext } from "./trace";
import { enableNodeRequestContext, withTraceContext } from "./node-context";

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

import { LogisterClient } from "./client";
import type { LogisterContext } from "./types";

const REQUEST_CONTEXT_KEY = Symbol.for("logister.requestContext");
const ERROR_CAPTURED_KEY = Symbol.for("logister.errorCaptured");
// Frozen or non-extensible errors cannot carry the marker property.
const capturedErrors = new WeakSet<object>();

export interface LogisterRequestContext {
  requestId: string;
  method: string;
  url: string;
  path: string;
  route?: string | undefined;
  query: unknown;
  headers: Record<string, string>;
  remoteIp?: string | undefined;
  userAgent?: string | undefined;
  startedAt: number;
  traceId?: string | undefined;
  spanId?: string | undefined;
  parentSpanId?: string | undefined;
  flags?: string | undefined;
}

export interface LogisterExpressOptions {
  client: LogisterClient;
  captureTransactions?: boolean | undefined;
  captureRequestSpans?: boolean | undefined;
  captureErrors?: boolean | undefined;
  /** Include `req.ip` as `remote_ip`. Off by default because an IP address is personal data. */
  captureRemoteIp?: boolean | undefined;
  /** Fraction of requests, from 0 to 1, recorded as transactions and request spans. Default 1. */
  transactionSampleRate?: number | undefined;
  requestIdHeader?: string | undefined;
  headerAllowList?: string[] | undefined;
  ignoreRoutes?: Array<string | RegExp> | undefined;
  transactionNamer?: ((req: Request, res: Response) => string) | undefined;
  shouldCaptureError?: ((error: unknown, req: Request, res: Response) => boolean) | undefined;
}

export function createLogisterMiddleware(options: LogisterExpressOptions): RequestHandler {
  const settings = withDefaults(options);
  enableNodeRequestContext(settings.client);

  return function logisterMiddleware(req: Request, res: Response, next: NextFunction) {
    let context: LogisterRequestContext;
    try {
      context = buildRequestContext(req, settings);
      setLogisterRequestContext(req, context);
      if (isSampled(settings.transactionSampleRate)) recordOnFinish(req, res, context, settings);
      res.setHeader("x-request-id", context.requestId);
    } catch (error) {
      settings.client.reportInternalError(error);
      next();
      return;
    }

    withTraceContext({traceId: context.traceId!, spanId: context.spanId!, parentSpanId: context.parentSpanId,
      requestId: context.requestId, flags: context.flags!}, next);
  };
}

function recordOnFinish(req: Request, res: Response, context: LogisterRequestContext, settings: NormalizedExpressOptions): void {
  if (!settings.captureTransactions && !settings.captureRequestSpans) return;

  res.on("finish", () => {
    try {
      const latestContext = getLogisterRequestContext(req) ?? context;
      if (matchesIgnoredRoute(settings.ignoreRoutes, req, latestContext)) return;

      const transactionName = settings.transactionNamer?.(req, res) ?? defaultTransactionName(req, latestContext);
      const durationMs = Math.max(0, Date.now() - context.startedAt);

      if (settings.captureTransactions) {
        settings.client.enqueueTransaction(transactionName, durationMs, {
          traceId: latestContext.traceId,
          requestId: latestContext.requestId,
          spanId: latestContext.spanId,
          parentSpanId: latestContext.parentSpanId,
          context: {
            request: serializeRequestContext(latestContext),
            http: {
              status_code: res.statusCode
            }
          }
        });
      }

      if (settings.captureRequestSpans) {
        settings.client.enqueueSpan(transactionName, durationMs, {
          kind: "server",
          status: res.statusCode >= 500 ? "error" : "ok",
          traceId: latestContext.traceId ?? latestContext.requestId,
          requestId: latestContext.requestId,
          spanId: latestContext.spanId,
          parentSpanId: latestContext.parentSpanId,
          context: {
            route: transactionName,
            request: serializeRequestContext(latestContext),
            http: {
              status_code: res.statusCode
            }
          }
        });
      }
    } catch (error) {
      settings.client.reportInternalError(error);
    }
  });
}

export function createLogisterErrorHandler(options: LogisterExpressOptions): ErrorRequestHandler {
  const settings = withDefaults(options);

  return function logisterErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction) {
    try {
      captureRouteError(error, req, res, settings);
    } catch (captureError) {
      settings.client.reportInternalError(captureError);
    }

    next(error);
  };
}

function captureRouteError(error: unknown, req: Request, res: Response, settings: NormalizedExpressOptions): void {
  if (!settings.captureErrors || isCapturedError(error)) return;

  const context = getLogisterRequestContext(req) ?? buildRequestContext(req, settings);
  setLogisterRequestContext(req, context);

  if (matchesIgnoredRoute(settings.ignoreRoutes, req, context)) return;
  if (settings.shouldCaptureError && !settings.shouldCaptureError(error, req, res)) return;

  markErrorCaptured(error);

  settings.client.enqueueException(error, {
    traceId: context.traceId, spanId: context.spanId, parentSpanId: context.parentSpanId, requestId: context.requestId,
    context: {
      request: serializeRequestContext(context),
      http: {
        status_code: currentStatusCode(res)
      }
    }
  });
}

export function getLogisterRequestContext(req: Request): LogisterRequestContext | undefined {
  const stored = (req as RequestWithLogisterContext)[REQUEST_CONTEXT_KEY];
  if (!stored) return undefined;

  if (!stored.route) {
    const route = routePattern(req);
    if (route) {
      const enriched = { ...stored, route };
      (req as RequestWithLogisterContext)[REQUEST_CONTEXT_KEY] = enriched;
      return enriched;
    }
  }

  return stored;
}

interface NormalizedExpressOptions {
  client: LogisterClient;
  captureTransactions: boolean;
  captureRequestSpans: boolean;
  captureErrors: boolean;
  captureRemoteIp: boolean;
  transactionSampleRate: number;
  requestIdHeader: string;
  headerAllowList: string[];
  ignoreRoutes: Array<string | RegExp>;
  transactionNamer?: ((req: Request, res: Response) => string) | undefined;
  shouldCaptureError?: ((error: unknown, req: Request, res: Response) => boolean) | undefined;
}

interface RequestWithLogisterContext extends Request {
  [REQUEST_CONTEXT_KEY]?: LogisterRequestContext;
}

function withDefaults(options: LogisterExpressOptions): NormalizedExpressOptions {
  return {
    client: options.client,
    captureTransactions: options.captureTransactions ?? true,
    captureRequestSpans: options.captureRequestSpans ?? false,
    captureErrors: options.captureErrors ?? true,
    captureRemoteIp: options.captureRemoteIp ?? false,
    transactionSampleRate: sampleRate(options.transactionSampleRate),
    requestIdHeader: options.requestIdHeader?.toLowerCase() ?? "x-request-id",
    headerAllowList: (options.headerAllowList ?? ["user-agent", "x-request-id"]).map((value) => value.toLowerCase()),
    ignoreRoutes: options.ignoreRoutes ?? [],
    transactionNamer: options.transactionNamer,
    shouldCaptureError: options.shouldCaptureError
  };
}

function buildRequestContext(req: Request, options: NormalizedExpressOptions): LogisterRequestContext {
  const trace = incomingTraceContext(headerValue(req, "traceparent"), headerValue(req, options.requestIdHeader), headerValue(req, "x-trace-id"));

  return compact({
    ...trace,
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path || req.url,
    route: routePattern(req),
    query: req.query,
    headers: allowedHeaders(req, options.headerAllowList),
    remoteIp: options.captureRemoteIp ? req.ip : undefined,
    userAgent: headerValue(req, "user-agent"),
    startedAt: Date.now()
  });
}

function setLogisterRequestContext(req: Request, context: LogisterRequestContext): void {
  (req as RequestWithLogisterContext)[REQUEST_CONTEXT_KEY] = context;
}

function allowedHeaders(req: Request, allowList: string[]): Record<string, string> {
  return allowList.reduce<Record<string, string>>((headers, key) => {
    const value = headerValue(req, key);
    if (value) headers[key] = value;
    return headers;
  }, {});
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.get(name);
  return value || undefined;
}

function routePattern(req: Request): string | undefined {
  const routePath = req.route?.path;
  if (!routePath) return undefined;

  const joined = `${req.baseUrl ?? ""}${String(routePath)}`;
  return joined || undefined;
}

function defaultTransactionName(req: Request, context: LogisterRequestContext): string {
  return context.route ?? `${req.method} ${context.path}`;
}

function matchesIgnoredRoute(ignoreRoutes: Array<string | RegExp>, req: Request, context: LogisterRequestContext): boolean {
  const candidates = [context.route, context.path, req.originalUrl, req.url].filter((value): value is string => Boolean(value));

  return ignoreRoutes.some((matcher) => {
    if (typeof matcher === "string") {
      return candidates.includes(matcher);
    }

    return candidates.some((candidate) => matcher.test(candidate));
  });
}

function serializeRequestContext(context: LogisterRequestContext): LogisterContext {
  return compact({
    request_id: context.requestId,
    trace_id: context.traceId,
    span_id: context.spanId,
    parent_span_id: context.parentSpanId,
    method: context.method,
    url: context.url,
    path: context.path,
    route: context.route,
    query: context.query,
    headers: context.headers,
    remote_ip: context.remoteIp,
    user_agent: context.userAgent
  });
}

function currentStatusCode(res: Response): number {
  return res.statusCode >= 400 ? res.statusCode : 500;
}

function markErrorCaptured(error: unknown): void {
  if (!error || typeof error !== "object") return;

  capturedErrors.add(error);
  if (!Object.isExtensible(error)) return;
  try {
    Object.defineProperty(error, ERROR_CAPTURED_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: true
    });
  } catch {
    // Proxies and exotic objects can refuse the marker; the WeakSet still records it.
  }
}

function isCapturedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (capturedErrors.has(error)) return true;
  try {
    return ERROR_CAPTURED_KEY in error;
  } catch {
    return false;
  }
}

function sampleRate(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function isSampled(rate: number): boolean {
  return rate >= 1 || (rate > 0 && Math.random() < rate);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
