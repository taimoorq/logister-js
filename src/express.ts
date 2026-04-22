import { randomUUID } from "node:crypto";

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

import { LogisterClient } from "./client";
import type { LogisterContext } from "./types";

const REQUEST_CONTEXT_KEY = Symbol.for("logister.requestContext");
const ERROR_CAPTURED_KEY = Symbol.for("logister.errorCaptured");

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
}

export interface LogisterExpressOptions {
  client: LogisterClient;
  captureTransactions?: boolean | undefined;
  captureErrors?: boolean | undefined;
  requestIdHeader?: string | undefined;
  headerAllowList?: string[] | undefined;
  ignoreRoutes?: Array<string | RegExp> | undefined;
  transactionNamer?: ((req: Request, res: Response) => string) | undefined;
  shouldCaptureError?: ((error: unknown, req: Request, res: Response) => boolean) | undefined;
}

export function createLogisterMiddleware(options: LogisterExpressOptions): RequestHandler {
  const settings = withDefaults(options);

  return function logisterMiddleware(req: Request, res: Response, next: NextFunction) {
    const context = buildRequestContext(req, settings);
    setLogisterRequestContext(req, context);

    if (settings.captureTransactions) {
      res.on("finish", () => {
        const latestContext = getLogisterRequestContext(req) ?? context;
        if (matchesIgnoredRoute(settings.ignoreRoutes, req, latestContext)) return;

        const transactionName = settings.transactionNamer?.(req, res) ?? defaultTransactionName(req, latestContext);
        const durationMs = Math.max(0, Date.now() - context.startedAt);

        void settings.client.captureTransaction(transactionName, durationMs, {
          context: {
            request: serializeRequestContext(latestContext),
            http: {
              status_code: res.statusCode
            }
          }
        });
      });
    }

    next();
  };
}

export function createLogisterErrorHandler(options: LogisterExpressOptions): ErrorRequestHandler {
  const settings = withDefaults(options);

  return function logisterErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction) {
    if (!settings.captureErrors || isCapturedError(error)) {
      next(error);
      return;
    }

    const context = getLogisterRequestContext(req) ?? buildRequestContext(req, settings);
    setLogisterRequestContext(req, context);

    if (matchesIgnoredRoute(settings.ignoreRoutes, req, context)) {
      next(error);
      return;
    }

    if (settings.shouldCaptureError && !settings.shouldCaptureError(error, req, res)) {
      next(error);
      return;
    }

    markErrorCaptured(error);

    void settings.client.captureException(error, {
      context: {
        request: serializeRequestContext(context),
        http: {
          status_code: currentStatusCode(res)
        }
      }
    });

    next(error);
  };
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
  captureErrors: boolean;
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
    captureErrors: options.captureErrors ?? true,
    requestIdHeader: options.requestIdHeader?.toLowerCase() ?? "x-request-id",
    headerAllowList: (options.headerAllowList ?? ["user-agent", "x-request-id", "x-forwarded-for"]).map((value) => value.toLowerCase()),
    ignoreRoutes: options.ignoreRoutes ?? [],
    transactionNamer: options.transactionNamer,
    shouldCaptureError: options.shouldCaptureError
  };
}

function buildRequestContext(req: Request, options: NormalizedExpressOptions): LogisterRequestContext {
  const requestId = headerValue(req, options.requestIdHeader) ?? randomUUID();

  return compact({
    requestId,
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path || req.url,
    route: routePattern(req),
    query: req.query,
    headers: allowedHeaders(req, options.headerAllowList),
    remoteIp: req.ip,
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
  if (error && typeof error === "object") {
    Object.defineProperty(error, ERROR_CAPTURED_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: true
    });
  }
}

function isCapturedError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && ERROR_CAPTURED_KEY in error);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
