# Changelog

All notable changes to `logister-js` will be documented in this file.

## v0.2.3 - 2026-05-22

### Added

- Added `captureSpan`, opt-in Express request spans, and browser page-load/resource span capture for request load waterfall charts.
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
