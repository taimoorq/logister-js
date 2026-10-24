# Changelog

## v0.6.0 - 2026-10-23

### Security

- Telemetry failures can no longer crash the host process. Express, console, traced-fetch and browser page-load capture used fire-and-forget promises with no rejection handler, so a `401`, `404`, `413`, `422` or a timeout produced an unhandled rejection that ends a Node process.
  - These captures now use a background queue that never rejects.
  - Failures go to the new `onError` client option. Without one, the SDK writes a single `console.warn`.
- `instrumentConsole` no longer throws at the call site. Circular, deeply nested, oversized and hostile arguments (throwing getters, proxies) are serialized with a cycle guard and depth, key, array and string caps. Capture runs only after the original console method, inside a guard.
- Console capture is reentrancy-safe. Output written while capturing, including the SDK's own diagnostics, is not captured, so `process.on("unhandledRejection", (e) => console.error(e))` cannot loop.
- Non-`Error` throwables and nested `AggregateError.errors` values are serialized with the same guards.
- Added the shared Logister redaction spec, applied to every event's `message` and `context`, and to check-in context:
  - Sensitive key names are redacted.
  - Bearer and Basic credentials, JWT-shaped values and `lgst_` keys are scrubbed from strings.
  - Sensitive query parameters are redacted in URLs, query strings and referers.
  - The new `redactKeys` option adds keys to the list.
- Express no longer captures `req.ip` by default (opt in with `captureRemoteIp: true`). `x-forwarded-for` was removed from the default header allowlist. `originalUrl`, `req.query` and allowlisted headers are redacted.
- Telemetry requests use `redirect: "error"`, so the API key is never replayed to a redirect target.
- The client warns once when `baseUrl` uses plain `http://` on a non-loopback host.

### Added

- Background delivery for integrations:
  - The queue is bounded (`maxQueueSize`, default 1000). New events are dropped and counted in `droppedEventCount` when it is full.
  - Queued events go to the batch endpoint every `flushIntervalMs` (default 1000 ms), immediately once `batchSize` events are waiting, on `flush()` or `close()`, and on Node's `beforeExit`.
  - New methods: `enqueueEvent`, `enqueueException`, `enqueueMessage`, `enqueueMetric`, `enqueueTransaction` and `enqueueSpan`.
- `maxEventBytes` (default 256 KiB) trims an oversized event's context instead of letting the server reject its batch. Messages are capped at 16,384 characters.
- Express `transactionSampleRate` (0 to 1, default 1) samples request transactions and server spans. Errors are always captured.
- `client.redact(value)` applies the client's redaction and serialization bounds to any value.
- `LogisterRequestError`, `LogisterTimeoutError` and `REDACTED` are exported.

### Changed

- Express, console and traced-fetch events are now batched in the background instead of being posted one request at a time. Call `await client.flush()` (or `close()`) before a short-lived process exits if it cannot rely on `beforeExit`.
- `capturePageLoad()` resolves even when delivery fails, and reports failures to `onError`.
- Background flush, retry and per-attempt timeout timers are `unref()`'d, so they never keep a Node process alive.
- When the retry delay is at `maxRetryDelayMs`, jitter now lowers the delay instead of being dropped, so capped retries still spread out. A server's `Retry-After` value is never shortened.
- Express error capture tolerates frozen and non-extensible errors.
- Directly awaited `capture*`, `sendEvent` and `sendEvents` calls keep their behavior. They post immediately and reject on failure.
- Refreshed the development lockfile to patched `vite`, `vitest`, `body-parser` and `source-map-js` releases so the audit gate passes.

## v0.5.0 - 2026-09-24

- Add request-scoped Express tracing with AsyncLocalStorage and consistent manual capture IDs.
- Add an opt-in traced fetch wrapper with exact-origin allowlists, explicit failure handles, telemetry exclusions, and manual redirects.

## v0.4.2 - 2026-09-11

- Preserved Node 22 compatibility by restoring Node 22 declarations and validating the supported type/runtime floor.
- Updated Vitest to 5.0.0 and the reviewed esbuild override to 0.28.2; refreshed the lockfile and verified declarations, ESM and CommonJS builds.
- Restored explicit publication dispatch and immutable-tag recovery after successful current-main CI. Weekly dependency checks cannot publish releases.
- Includes the previously tagged, unpublished 0.4.1 check-in timestamp fix.

All notable changes to `logister-js` will be documented in this file.

## v0.4.1 - 2026-08-09

### Fixed

- Send the canonical `occurred_at` field for monitor check-ins so Logister preserves caller-supplied timestamps.

## v0.4.0 - 2026-08-08

### Added

- Added `prepareEvents()` and `sendEvents()` for explicit stable identifiers and chunked high-volume delivery.
- Added configurable gzip/NDJSON batching with deterministic batch IDs, recursive `413` splitting, and automatic stable single-event fallback for older Logister servers.
- Added per-attempt and total request deadlines plus configurable transient retry count, exponential delay, maximum delay, and jitter.

### Changed

- `sendEvent()` now assigns and reuses a stable UUID when the caller does not supply a nonblank `uuid` or `event_id`.
- Retryable network, `408`, `425`, `429`, and `5xx` failures now preserve event identities and honor numeric or HTTP-date `Retry-After` values within configured caps.
- Batch splitting and legacy fallback attempt every event even when an earlier subset fails, then surface the first failure after all attempts finish.

## v0.3.0 - 2026-07-25

### Changed

- Raised the supported Node.js runtime from Node 18 to Node 22 and updated the package build target accordingly.
- Updated the supported test and type tooling while keeping TypeScript on the latest compatible 5.9 release.

### Security

- Updated the development dependency graph to patched `brace-expansion` and `esbuild` releases.
- Added an explicit npm audit gate to local checks, CI, and releases.

## v0.2.5 - 2026-06-18

### Added

- Added first-class source context fields (`repository`, `commitSha`, and `branch`) plus `defaultContext` to the client options.
- Added `recordDeployment()` for posting release-to-commit deployment records to Logister.

## v0.2.4 - 2026-05-22

### Added

- Added `captureSpan`, opt-in Express request spans, and browser page-load/resource span capture for request load waterfall charts.

## v0.2.3 - 2026-05-22

### Added

- Added README guidance for using JavaScript and TypeScript reports with the Logister project Insights beta, including practical metric, transaction, log, check-in, and custom attribute examples.
- Consolidated tag releases so the npm package publishes first and the matching GitHub release is created or updated in the same workflow run.

## v0.2.2 - 2026-05-21

### Added

- Added per-event environment, release, trace ID, request ID, session ID, and user ID options to capture calls.
- Added release, expected interval, trace ID, and request ID fields to check-in payloads.
- Added structured metric context alongside the existing value/unit fields for metric captures.

## v0.2.1 - 2026-04-22

### Fixed

- Updated the npm trusted publishing workflow to match npm's current GitHub Actions guidance so tagged releases can publish successfully from GitHub-hosted runners.

## v0.2.0 - 2026-04-22

### Added

- Native console capture via `instrumentConsole()` and the `logister-js/console` entrypoint.
- Richer JavaScript exception normalization including chained causes and structured nested error context.
- Expanded README and integration guidance for Express, console capture, and richer JavaScript error payloads.

### Changed

- Updated the default SDK user agent and package version for the new release.
- Broadened the JavaScript SDK positioning from base client only to a fuller Node/TypeScript operational path.

### Fixed

- Allowed `captureException()` callers to override the event message so wrapped operational errors can keep the intended headline.

## v0.1.0 - 2026-04-21

### Added

- Initial standalone `logister-js` repository for the JavaScript and TypeScript Logister SDK.
- Base `LogisterClient` for sending errors, logs, metrics, transactions, and check-ins to a Logister backend.
- Node runtime helper export via `logister-js/node`.
- Strict TypeScript package setup with dual ESM/CJS builds and generated type declarations.
- Vitest-based test setup and CI workflow for typecheck, test, and build verification.
- GitHub Actions publish workflow configured for npm Trusted Publishing over OIDC.

### Changed

- Adopted npm as the canonical registry target so npm, Yarn, pnpm, and Bun can all consume the same published package.
- Documented trusted publishing and package release flow in the repo README.

### Fixed

- Tightened strict TypeScript handling for optional event payload fields so the initial SDK scaffold builds cleanly under `exactOptionalPropertyTypes`.
