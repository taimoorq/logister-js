# logister-js

JavaScript and TypeScript SDK for sending errors, logs, metrics, transactions, and check-ins to Logister.

This package is designed for Node.js runtimes first, with Express and other framework integrations layered on top.

## Status

`logister-js` is an initial SDK scaffold focused on a clean publishable package shape and a base HTTP client.
Framework-specific integrations like Express, NestJS, and Next.js server-side support can build on top of this package.

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
- HTTP API reference: https://docs.logister.org/http-api/
- Ruby integration: https://docs.logister.org/integrations/ruby/
- CFML integration: https://docs.logister.org/integrations/cfml/
