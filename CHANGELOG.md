# Changelog

All notable changes to `logister-js` will be documented in this file.

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
