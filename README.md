# logister-js

JavaScript and TypeScript SDK for sending errors, logs, metrics, transactions, spans, and check-ins to Logister.

Install it from npm as `logister-js`.

Use this package when you want a Node, TypeScript, or server-side JavaScript app to send telemetry into the Logister backend.

- Main Logister app: https://github.com/taimoorq/logister
- JavaScript integration docs: https://docs.logister.org/integrations/javascript/
- Insights beta guide: https://docs.logister.org/product/#insights-beta
- npm package: https://www.npmjs.com/package/logister-js

## Package links

- npm package: https://www.npmjs.com/package/logister-js
- GitHub repo: https://github.com/taimoorq/logister-js
- GitHub releases: https://github.com/taimoorq/logister-js/releases
- Integration docs: https://docs.logister.org/integrations/javascript/
- Insights beta guide: https://docs.logister.org/product/#insights-beta

## Table Of Contents

- [What This Package Is For](#what-this-package-is-for)
- [Install From npm](#install-from-npm)
- [Quick start](#quick-start)
- [Express quick start](#express-quick-start)
- [Console logging](#console-logging)
- [Core API](#core-api)
- [Using project Insights beta](#using-project-insights-beta)
- [Node helpers](#node-helpers)
- [Environment variables](#environment-variables)
- [Development](#development)
- [Publishing](#publishing)
- [Documentation](#documentation)

This package is designed for Node.js runtimes first, especially the kinds of JavaScript projects that mix HTTP handlers, background jobs, console output, and custom operational code.

## Status

`logister-js` is a published npm package with a shared client, Express integration, console capture, structured exception reporting, and Node runtime helpers.
Framework-specific integrations like NestJS and Next.js server-side support can build on top of the package shape that is already in place.

Current framework roadmap:

- Express integration plan: ./docs/express-integration-plan.md

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

Why install from npm:

- versioned package installs instead of copying code from GitHub
- standard dependency resolution for `npm`, `yarn`, `pnpm`, and `bun`
- package metadata, release history, and install commands in one place
- provenance-enabled publishes configured in this repo

## Quick start

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
- `sendEvent(payload)`

Capture options support per-event `environment`, `release`, `traceId`, `requestId`, `sessionId`, and `userId`. Metric options also accept `unit`; span options add `spanId`, `parentSpanId`, `kind`, `status`, `startedAt`, and `endedAt`; check-in options accept `release`, `durationMs`, `expectedIntervalSeconds`, `traceId`, and `requestId`.

Browser apps can record navigation and resource timing with the browser entrypoint:

```ts
import { LogisterClient } from "logister-js";
import { capturePageLoad } from "logister-js/browser";

const client = new LogisterClient({
  apiKey: window.LOGISTER_API_KEY,
  baseUrl: "https://logister.org"
});

await capturePageLoad(client, {
  route: window.location.pathname,
  includeResources: true,
  maxResources: 20
});
```

## Using project Insights beta

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

## Development

```bash
npm install
npm run check
```

## Publishing

Publishing targets the npm registry. npm is the canonical registry consumed by npm, Yarn, pnpm, and Bun.

GitHub releases and npm publishing now happen in the same tag workflow and are driven by `CHANGELOG.md` plus `config/release.yml`. A commit or merge to `main` runs CI only. Pushing a tag like `v0.2.3` runs checks, publishes the npm package if that version is not already on npm, and then creates or updates the matching GitHub release.

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
2. Push a `v0.2.3` tag and let GitHub Actions publish the package and GitHub release together.
3. After the first successful publish, go to the package settings on npm and set publishing access to require 2FA and disallow tokens.

## Documentation

- Product docs: https://docs.logister.org/
- JavaScript integration: https://docs.logister.org/integrations/javascript/
- Insights beta guide: https://docs.logister.org/product/#insights-beta
- HTTP API reference: https://docs.logister.org/http-api/
- Ruby integration: https://docs.logister.org/integrations/ruby/
- CFML integration: https://docs.logister.org/integrations/cfml/
