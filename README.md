# logister-js

JavaScript and TypeScript SDK for sending errors, logs, metrics, transactions, spans, and scheduled-job check-ins to Logister.

Install it from npm as `logister-js`.

Use this package in Node.js services, TypeScript applications, Express servers, workers, and scripts. Browser timing capture is available through a separate entry point.

Requires Node.js 22 or newer for Node-based applications and build tooling.

- Main Logister app: https://github.com/taimoorq/logister
- JavaScript integration docs: https://logister.org/docs/integrations/javascript/
- Insights guide: https://logister.org/docs/product/#insights
- npm package: https://www.npmjs.com/package/logister-js

## Quick start

Create a project in Logister and generate a project API key under **Project settings → API keys**.

```bash
npm install logister-js

export LOGISTER_API_KEY="<project-api-key>"
export LOGISTER_BASE_URL="https://logister.example.com"
export LOGISTER_ENVIRONMENT="development"
```

Send a test error:

```ts
import { LogisterClient } from "logister-js";

const client = new LogisterClient({
  apiKey: process.env.LOGISTER_API_KEY ?? "",
  baseUrl: process.env.LOGISTER_BASE_URL ?? "https://logister.example.com",
  environment: process.env.LOGISTER_ENVIRONMENT,
  defaultContext: { service: "checkout-api" }
});

await client.captureException(new Error("README test error"), {
  fingerprint: "readme-test-error",
  context: { component: "checkout" }
});
```

Open the project inbox and confirm that **README test error** appears. A rejected promise with status `401` usually means the API key or base URL is wrong; use the [JavaScript integration guide](https://logister.org/docs/integrations/javascript/) for setup and troubleshooting.

## Package links

- npm package: https://www.npmjs.com/package/logister-js
- GitHub repo: https://github.com/taimoorq/logister-js
- GitHub releases: https://github.com/taimoorq/logister-js/releases
- Integration docs: https://logister.org/docs/integrations/javascript/
- Insights guide: https://logister.org/docs/product/#insights

## Table Of Contents

- [Quick start](#quick-start)
- [Status](#status)
- [What This Package Is For](#what-this-package-is-for)
- [Install From npm](#install-from-npm)
- [Base client example](#base-client-example)
- [Express quick start](#express-quick-start)
- [Console logging](#console-logging)
- [Core API](#core-api)
- [Using project Insights](#using-project-insights)
- [GitHub source context and deployments](#github-source-context-and-deployments)
- [Node helpers](#node-helpers)
- [Environment variables](#environment-variables)
- [Development](#development)
- [Publishing](#publishing)
- [Documentation](#documentation)

This package is Node-first and supports both ESM and CommonJS consumers.

## Status

`logister-js` is a published npm package with a shared client, Express integration, console capture, structured exception reporting, and Node runtime helpers.
Framework-specific integrations like NestJS and Next.js server-side support can build on top of the package shape that is already in place.

## What This Package Is For

Use `logister-js` when you want a published npm package that drops into Node and TypeScript services for:

- request and job visibility in server-side JavaScript
- uncaught exception reporting with structured stack frames
- Express middleware and error handling
- console capture for scripts, workers, and operational services
- shared custom metrics, logs, transactions, spans, and check-ins

The npm package is the canonical distribution for JavaScript users. `npm`, `yarn`, `pnpm`, and `bun` all consume the same published package.

## Install From npm

```bash
npm install logister-js
```

```bash
yarn add logister-js
```

```bash
pnpm add logister-js
```

```bash
bun add logister-js
```

Package registry: https://www.npmjs.com/package/logister-js

## Base client example

Use the base client when you want direct control from a script, worker, background job, or framework hook.

```ts
import { LogisterClient } from "logister-js";

const client = new LogisterClient({
  apiKey: process.env.LOGISTER_API_KEY ?? "",
  baseUrl: process.env.LOGISTER_BASE_URL ?? "https://logister.org"
});

await client.captureMessage("SDK booted", {
  level: "info",
  context: { runtime: "node" }
});
```

The client throws when Logister returns a non-2xx response, so failed delivery remains visible to your application. Decide at the call site whether to retry, log locally, or continue without telemetry.

## Express quick start

This is the fastest path if your JavaScript service is already organized around Express middleware and error handlers.

```ts
import express from "express";
import { LogisterClient } from "logister-js";
import {
  createLogisterMiddleware,
  createLogisterErrorHandler,
  getLogisterRequestContext
} from "logister-js/express";

const app = express();
const logister = new LogisterClient({
  apiKey: process.env.LOGISTER_API_KEY ?? "",
  baseUrl: process.env.LOGISTER_BASE_URL ?? "https://logister.org",
  environment: process.env.LOGISTER_ENVIRONMENT,
  release: process.env.LOGISTER_RELEASE
});

app.use(createLogisterMiddleware({ client: logister, captureRequestSpans: true }));

app.get("/orders/:id", async (req, res) => {
  const context = getLogisterRequestContext(req);

  await logister.captureMessage("orders route reached", {
    context: {
      request_id: context?.requestId,
      route: context?.route
    }
  });

  res.json({ ok: true, requestId: context?.requestId });
});

app.get("/boom", () => {
  throw new Error("BROKEN");
});

app.use(createLogisterErrorHandler({ client: logister }));

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message });
});

app.listen(3000, () => {
  console.log("Listening on http://localhost:3000");
});
```

What this gives you by default:

- uncaught Express route errors sent as Logister `error` events
- completed requests sent as Logister `transaction` events
- optional completed-request `server` spans for request load waterfall charts
- adopted or generated request IDs
- request context you can reuse in custom logs and metrics

## Console logging

This is the lowest-friction path when your app already leans on `console.warn()` and `console.error()` during jobs, scripts, or server-side troubleshooting.

```ts
import { LogisterClient } from "logister-js";
import { instrumentConsole } from "logister-js/console";

const client = new LogisterClient({
  apiKey: process.env.LOGISTER_API_KEY ?? "",
  baseUrl: process.env.LOGISTER_BASE_URL ?? "https://logister.org"
});

const restoreConsole = instrumentConsole(client, {
  context: { service: "worker" }
});

console.warn("Queue backlog rising", { queue: "emails" });

restoreConsole();
```

What this records:

- `console.debug/info/log/warn/error` as Logister `log` events
- `console.error()` calls that include an `Error` object as Logister `error` events
- console method metadata plus serialized arguments in event context

Recommended middleware order:

1. `createLogisterMiddleware()` near the top of the stack
2. your routes and app middleware
3. `createLogisterErrorHandler()` after routes
4. your final Express error response middleware last

## Core API

- `captureException(error, options)`
- `captureMessage(message, options)`
- `captureMetric(name, value, options)`
- `captureTransaction(name, durationMs, options)`
- `captureSpan(name, durationMs, options)`
- `checkIn(slug, status, options)`
- `prepareEvents(payloads)`
- `sendEvent(payload)`
- `sendEvents(payloads)`

Capture options support per-event `environment`, `release`, `traceId`, `requestId`, `sessionId`, and `userId`. Metric options also accept `unit`; span options add `spanId`, `parentSpanId`, `kind`, `status`, `startedAt`, and `endedAt`; check-in options accept `release`, `durationMs`, `expectedIntervalSeconds`, `traceId`, and `requestId`.

`sendEvent` assigns a stable UUID when one is not supplied and retries transient
network, `429`, and `5xx` failures with that same identifier. Use `sendEvents` for
high-volume producers; it chunks events, sends gzip/NDJSON to the batch endpoint, and
falls back to stable single-event delivery for an older Logister server:

```ts
await client.sendEvents([
  { event_type: "metric", message: "queue.depth", context: { value: 12 } },
  { event_type: "metric", message: "queue.latency", context: { value: 48 } }
]);
```

If your application may repeat an entire call after partial delivery, prepare the
events once and reuse the returned payloads. This keeps generated UUIDs stable even
when the retry happens outside the SDK's internal retry loop:

```ts
const events = client.prepareEvents([
  { event_type: "metric", message: "queue.depth", context: { value: 12 } },
  { event_type: "metric", message: "queue.latency", context: { value: 48 } }
]);

try {
  await client.sendEvents(events);
} catch {
  await client.sendEvents(events);
}
```

The same client also remembers generated UUIDs when the same source event objects are
passed again. `prepareEvents` is preferable when events cross a queue, serialization,
or process boundary because the identifiers are explicit in the returned payloads.

Tune `batchSize`, `batchCompression`, `maxRetries`, `retryBaseDelayMs`,
`maxRetryDelayMs`, and `retryJitterRatio` in the `LogisterClient` constructor when the
defaults are not appropriate. `requestTimeoutMs` bounds each fetch attempt and
`totalTimeoutMs` bounds all chunks, splits, fallbacks, retry waits, and attempts in one
public send call. Retryable responses honor numeric or HTTP-date `Retry-After` values,
subject to the configured total and per-delay caps.
The defaults are 5 seconds per attempt, 65 seconds total, a 30-second retry-delay
cap, and 20% positive jitter.

Browser apps can record navigation and resource timing with the browser entrypoint. A browser cannot keep an ingest key secret: anyone who can load the page can inspect and reuse it. Use a write-only project key only if that abuse risk is acceptable, or send browser telemetry through your own backend.

```ts
import { LogisterClient } from "logister-js";
import { capturePageLoad } from "logister-js/browser";

const apiKey = document.querySelector<HTMLMetaElement>(
  'meta[name="logister-ingest-key"]'
)?.content;

if (!apiKey) throw new Error("Missing Logister browser ingest key");

const client = new LogisterClient({
  apiKey,
  baseUrl: "https://logister.example.com"
});

await capturePageLoad(client, {
  route: window.location.pathname,
  includeResources: true,
  maxResources: 20
});
```

## Using project Insights

The Logister project Insights tab combines Inbox, Activity, and Performance data into live dashboard views. Node and TypeScript services get the most useful Insights view when they send consistent `environment`, `release`, and stable top-level context attributes.

Configure deployment context once, then attach low-cardinality dimensions to metrics, transactions, logs, and check-ins:

```ts
import { LogisterClient } from "logister-js";

const logister = new LogisterClient({
  apiKey: process.env.LOGISTER_API_KEY ?? "",
  baseUrl: process.env.LOGISTER_BASE_URL ?? "https://logister.org",
  environment: process.env.LOGISTER_ENVIRONMENT,
  release: process.env.LOGISTER_RELEASE
});

await logister.captureMetric("queue.depth", 42, {
  unit: "jobs",
  context: {
    service: "billing-worker",
    queue: "billing",
    region: "us-east-1",
    tenant_tier: "enterprise"
  }
});

await logister.captureTransaction("POST /checkout", 182.4, {
  requestId: "req_123",
  context: {
    service: "billing-api",
    route: "POST /checkout",
    feature_flag: "new_checkout",
    tenant_tier: "enterprise"
  }
});

await logister.captureSpan("render checkout", 82.1, {
  kind: "render",
  status: "ok",
  traceId: "trace_123",
  parentSpanId: "span_root",
  context: {
    route: "POST /checkout"
  }
});

await logister.captureMessage("payment provider retry", {
  level: "warn",
  context: {
    service: "billing-worker",
    provider: "stripe",
    queue: "billing"
  }
});

await logister.checkIn("nightly-reconcile", "ok", {
  expectedIntervalSeconds: 3600,
  durationMs: 842.7,
  context: {
    service: "billing-worker",
    queue: "reconcile"
  }
});
```

Practical Insights recipes:

- Release validation: set `LOGISTER_RELEASE`, then filter Insights to the new release and compare error count, transaction P95, and custom metrics.
- Queue monitoring: report metrics such as `queue.depth`, `queue.latency`, `jobs.retry_count`, and `worker.active_jobs` with stable `queue` and `service` context keys.
- Express performance triage: enable `captureRequestSpans` in `createLogisterMiddleware()` to feed request load waterfall charts, then add matching `route`, `tenant_tier`, or `feature_flag` context to custom logs and metrics.
- Instrumentation audit: open Insights after deploy and confirm errors, logs, metrics, transactions, spans, and check-ins all appear in the recent stream.

Keep custom attributes stable and low-cardinality. Good top-level context keys include `service`, `region`, `queue`, `route`, `tenant_tier`, `provider`, and `feature_flag`. Avoid raw IDs, emails, request bodies, SQL text, and per-user values as Insights dimensions.

## GitHub source context and deployments

When a Logister project is connected to a GitHub repository, send source context so stack frames and releases can resolve to the exact commit:

```ts
const logister = new LogisterClient({
  apiKey: process.env.LOGISTER_API_KEY ?? "",
  baseUrl: process.env.LOGISTER_BASE_URL ?? "https://logister.org",
  environment: process.env.LOGISTER_ENVIRONMENT,
  release: process.env.LOGISTER_RELEASE,
  repository: process.env.LOGISTER_REPOSITORY,
  commitSha: process.env.LOGISTER_COMMIT_SHA ?? process.env.GITHUB_SHA,
  branch: process.env.LOGISTER_BRANCH ?? process.env.GITHUB_REF_NAME,
  defaultContext: { service: "checkout-web" }
});
```

CI/CD can also record the release-to-commit mapping directly:

```ts
await logister.recordDeployment({
  release: process.env.LOGISTER_RELEASE ?? "checkout@2026.06.18",
  environment: process.env.LOGISTER_ENVIRONMENT ?? "production",
  repository: process.env.LOGISTER_REPOSITORY ?? "acme/checkout",
  commitSha: process.env.LOGISTER_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "",
  branch: process.env.LOGISTER_BRANCH ?? process.env.GITHUB_REF_NAME,
  workflowRunUrl: process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined
});
```

## Node helpers

Use the Node helpers when you want runtime metadata without hand-building it into every event.

```ts
import { LogisterClient } from "logister-js";
import { getNodeRuntimeContext } from "logister-js/node";

const client = new LogisterClient({
  apiKey: process.env.LOGISTER_API_KEY ?? "",
  baseUrl: process.env.LOGISTER_BASE_URL ?? "https://logister.org"
});

await client.captureException(new Error("Boom"), {
  context: getNodeRuntimeContext({ service: "worker" })
});
```

`captureException()` now includes structured stack frames plus chained causes when JavaScript errors use `cause`.

## Environment variables

- `LOGISTER_API_KEY`
- `LOGISTER_BASE_URL`
- `LOGISTER_ENVIRONMENT`
- `LOGISTER_RELEASE`
- `LOGISTER_REPOSITORY`
- `LOGISTER_COMMIT_SHA`
- `LOGISTER_BRANCH`

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

## Publishing

Publishing targets the npm registry. npm is the canonical registry consumed by npm, Yarn, pnpm, and Bun.

`package.json` is the package version source of truth. Update it, `package-lock.json`, and `CHANGELOG.md` together. After CI passes on `main`, the release-from-main workflow creates the matching version tag. Pushing `vX.Y.Z` verifies tag/version parity, runs the full checks, publishes the missing npm version with trusted publishing, and only then creates or updates the GitHub Release.

### Manual publish

```bash
npm login
npm run check
npm publish --access public --provenance
```

### GitHub Actions publish with trusted publishing

This repo is configured to publish with npm trusted publishing over GitHub Actions OIDC.
No `NPM_TOKEN` secret is required.

Before the workflow can publish, configure a trusted publisher on npmjs.com for:

- GitHub owner: `taimoorq`
- Repository: `logister-js`
- Workflow file: `.github/workflows/release.yml`
- Environment: leave blank unless you later gate publishes through a GitHub environment

Trusted publishing requires GitHub-hosted runners and npm CLI 11.5.1 or newer. The workflow upgrades npm before publishing.

Recommended rollout:

1. Configure the trusted publisher on npm.
2. Merge the version bump to `main` or push a matching `vX.Y.Z` tag and let GitHub Actions publish the package and GitHub Release together.
3. After the first successful publish, go to the package settings on npm and set publishing access to require 2FA and disallow tokens.

npm versions are immutable. If a version has already been accepted, make corrections in a new patch version and do not move its tag.

Verify both release surfaces:

```bash
npm view logister-js@X.Y.Z version engines --json
gh release view vX.Y.Z
```

## Documentation

- Product docs: https://logister.org/docs/
- JavaScript integration: https://logister.org/docs/integrations/javascript/
- Insights guide: https://logister.org/docs/product/#insights
- HTTP API reference: https://logister.org/docs/http-api/
- Ruby integration: https://logister.org/docs/integrations/ruby/
- CFML integration: https://logister.org/docs/integrations/cfml/
