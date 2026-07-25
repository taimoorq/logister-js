# Logister JavaScript SDK Agent Notes

This is a public package repository. Treat every committed file, fixture, log,
and release artifact as publishable. Never commit registry tokens, telemetry,
customer data, or local credentials.

## Dependency maintenance

- `package.json` is the source of truth for the package version and Node floor.
- Keep the supported Node matrix aligned with `engines.node`; the current floor
  is Node 22 and CI covers Node 22, 24, and 26.
- Keep `@types/node` on the oldest supported Node major so typechecking cannot
  accidentally admit APIs unavailable on the minimum runtime.
- Do not adopt a new TypeScript major until `tsup` and its declaration bundler
  pass. TypeScript 7 currently fails in `rollup-plugin-dts` with `tsup` 8.5.
- Update `package-lock.json` with dependency changes. Use `overrides` only for a
  reviewed transitive fix and remove the override when the direct toolchain no
  longer needs it.
- Keep npm and GitHub Actions Dependabot updates enabled. Pin Actions to full
  commit SHAs and retain a readable version comment.

## Verification

Run before handoff or release:

```bash
npm ci
npm run check
npm pack --dry-run
```

`npm run check` includes the low-severity npm audit, typecheck, tests, and build.

## Release contract

- Update `package.json`, `package-lock.json`, and `CHANGELOG.md` together.
- Merging a new version to `main` runs CI, creates `vX.Y.Z`, and explicitly
  dispatches `release.yml`. Keep the explicit dispatch: tags pushed with the
  workflow `GITHUB_TOKEN` do not start tag-push workflows.
- The release must verify tag/version parity, rerun checks, publish to npm with
  trusted publishing, and only then create or update the GitHub Release.
- npm versions are immutable. If npm accepted a version, never move its tag or
  reuse that version; prepare a new patch version instead.
- Verify both surfaces before calling a release complete:

```bash
npm view logister-js@X.Y.Z version engines --json
gh release view vX.Y.Z
```
