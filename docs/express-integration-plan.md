# Express integration plan

This document describes the first framework-specific integration for `logister-js`.
The goal is to make Express the first polished Node.js path for Logister because it has the strongest combination of popularity, clear centralized error handling, and easy request lifecycle instrumentation.

## Goals

- Ship a first-party Express integration on top of the base `LogisterClient`.
- Capture uncaught request errors with useful HTTP and request context.
- Capture request timings as `transaction` events.
- Preserve enough request-scoped metadata to attach logs and custom events to the same request.
- Keep the first release small enough to document and support confidently.

## Non-goals for v0.1

- Browser SDK support.
- Automatic frontend error boundaries.
- Deep ORM-specific instrumentation.
- OpenTelemetry bridge.
- Framework-specific support for NestJS or Next.js in the first Express release.

## Recommended package shape

Start inside the same package rather than splitting immediately.

### Exports

- `logister-js`
  - base `LogisterClient`
- `logister-js/node`
  - runtime helpers
- `logister-js/express`
  - Express middleware, error handler, and request context helpers

This keeps npm distribution simple while still giving framework-specific entrypoints.

## Proposed Express API

```ts
import express from "express";
import {
  createLogisterMiddleware,
  createLogisterErrorHandler,
  getLogisterRequestContext
} from "logister-js/express";
import { LogisterClient } from "logister-js";

const app = express();
const logister = new LogisterClient({
  apiKey: process.env.LOGISTER_API_KEY ?? "",
  baseUrl: process.env.LOGISTER_BASE_URL ?? "https://logister.org",
  environment: process.env.LOGISTER_ENVIRONMENT,
  release: process.env.LOGISTER_RELEASE
});

app.use(createLogisterMiddleware({ client: logister }));

app.get("/", async (req, res) => {
  const context = getLogisterRequestContext(req);

  await logister.captureMessage("route reached", {
    context: {
      request_id: context.requestId,
      route: context.route
    }
  });

  res.send("ok");
});

app.use(createLogisterErrorHandler({ client: logister }));
```

## Middleware responsibilities

### 1. Request middleware

Runs early in the Express stack.

Responsibilities:

- Generate or adopt a request ID.
- Record request start time.
- Capture request metadata:
  - method
  - original URL
  - path
  - route pattern when available
  - headers subset
  - query params
  - remote IP
  - user agent
- Store request-scoped context on `req`.
- Optionally expose AsyncLocalStorage-backed access for downstream code.
- On response finish, send a `transaction` event.

### 2. Error handler middleware

Runs after application routes and middleware.

Responsibilities:

- Capture uncaught exceptions that reach Express error middleware.
- Attach request context from the request middleware.
- Include HTTP status when available.
- Avoid double-reporting if the error was already marked as captured.
- Re-throw or delegate according to Express conventions.

### 3. Manual request context helper

Provide a helper like:

- `getLogisterRequestContext(req)`
- or `getCurrentLogisterContext()` if AsyncLocalStorage is enabled

This lets developers attach request IDs and route names to custom logs or metrics without rebuilding context manually.

## Event mapping

### Error events

Map uncaught Express errors to Logister `error` events.

Suggested context payload:

```json
{
  "exception": {
    "class": "Error",
    "message": "Something broke",
    "stack": "..."
  },
  "request": {
    "method": "GET",
    "url": "https://example.com/orders/1",
    "path": "/orders/1",
    "route": "/orders/:id",
    "headers": {
      "user-agent": "..."
    },
    "query": {},
    "request_id": "...",
    "remote_ip": "..."
  },
  "http": {
    "status_code": 500
  }
}
```

### Transaction events

Map completed requests to `transaction` events.

Suggested payload rules:

- `message`: route pattern or method + path fallback
- `context.transaction_name`: same value
- `context.duration_ms`: total request duration
- `context.request.method`: request method
- `context.http.status_code`: response code
- `context.request.request_id`: request ID

### Log events

Use manual `captureMessage()` or a future logger bridge.

First release recommendation:

- do not build a logger transport yet
- document how to call `captureMessage()` with request context

### Metric events

Use manual `captureMetric()` in v0.1.

Later candidates:

- outbound HTTP timings
- DB query timing hooks for specific ORMs
- event loop lag / process health metrics

### Check-ins

Leave as client-only in v0.1.

Docs can show Express or worker-side examples, but this does not need Express-specific middleware.

## Context propagation strategy

Use both approaches:

### Required

- attach context to `req`

### Optional but recommended

- `AsyncLocalStorage` for request-scoped access outside handlers

Why this split works:

- `req` attachment is the most explicit and easiest to debug
- `AsyncLocalStorage` improves DX for deeper service layers and background utilities triggered during request handling

## Configuration surface

```ts
interface LogisterExpressOptions {
  client: LogisterClient;
  captureTransactions?: boolean;
  captureErrors?: boolean;
  requestIdHeader?: string;
  headerAllowList?: string[];
  ignoreRoutes?: Array<string | RegExp>;
  transactionNamer?: (req: Request, res: Response) => string;
  shouldCaptureError?: (error: unknown, req: Request, res: Response) => boolean;
}
```

## Suggested v0.1 implementation order

### Phase 1

- `logister-js/express` export
- request middleware
- error middleware
- request context typing
- docs with a minimal Express setup

### Phase 2

- AsyncLocalStorage support
- request ID adoption from incoming headers
- route ignore list
- custom transaction namer

### Phase 3

- logger integration helpers
- NestJS docs built on top of the same Node client
- Next.js server-side docs built on top of the same Node client

## Documentation plan

Add public docs for:

- Installing `logister-js`
- Express quick start
- Error handler placement in Express
- Transaction event shape
- Request context fields captured by default
- Manual custom logs and metrics inside a request
- Troubleshooting double-reporting and ignored routes

## Testing plan

### Unit tests

- error normalization
- request context serialization
- transaction duration calculation
- route naming behavior

### Integration tests

- Express app with one success route
- Express app with one failing route
- assert outgoing payloads for:
  - `transaction`
  - `error`

### Compatibility

- Node 18+
- Express 4
- Express 5 if practical during the initial release window

## Risks to watch

- double-reporting errors when app code manually calls `captureException()` and error middleware also reports
- leaking sensitive request headers if header capture is too broad
- high-cardinality transaction names if raw URLs are used instead of route patterns
- AsyncLocalStorage assumptions across all user middleware stacks

## Recommendation

Build Express first as the canonical server-side Node integration.
Once this is stable, reuse the base client and event mapping for NestJS and Next.js server-side support instead of forking separate SDKs too early.
