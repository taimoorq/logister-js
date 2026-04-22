# logister-js

JavaScript and TypeScript SDK for sending errors, logs, metrics, transactions, and check-ins to Logister.

Use this package when you want a Node or TypeScript app to send telemetry into the Logister backend.

- Main Logister app: https://github.com/taimoorq/logister
- JavaScript integration docs: https://docs.logister.org/integrations/javascript/

This package is designed for Node.js runtimes first, with Express and other framework integrations layered on top.

## Status

`logister-js` is an initial SDK scaffold focused on a clean publishable package shape and a base HTTP client.
Framework-specific integrations like Express, NestJS, and Next.js server-side support can build on top of this package.

Current framework roadmap:

- Express integration plan: ./docs/express-integration-plan.md

## Install

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

## Quick start

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

app.use(createLogisterMiddleware({ client: logister }));

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
- adopted or generated request IDs
- request context you can reuse in custom logs and metrics

## Console logging

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
- `checkIn(slug, status, options)`
- `sendEvent(payload)`

## Node helpers

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

GitHub releases are managed separately in this repo and are driven by `CHANGELOG.md` plus `config/release.yml`. Pushing a tag like `v0.1.0` will publish the npm package and create or update the matching GitHub release.

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
- Workflow file: `.github/workflows/publish.yml`
- Environment: leave blank unless you later gate publishes through a GitHub environment

Trusted publishing requires GitHub-hosted runners and npm CLI 11.5.1 or newer. The workflow upgrades npm before publishing.

Recommended rollout:

1. Configure the trusted publisher on npm.
2. Push a `v0.1.0` tag and let GitHub Actions publish the package.
3. After the first successful publish, go to the package settings on npm and set publishing access to require 2FA and disallow tokens.

## Documentation

- Product docs: https://docs.logister.org/
- JavaScript integration: https://docs.logister.org/integrations/javascript/
- HTTP API reference: https://docs.logister.org/http-api/
- Ruby integration: https://docs.logister.org/integrations/ruby/
- CFML integration: https://docs.logister.org/integrations/cfml/
