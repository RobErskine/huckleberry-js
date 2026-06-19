# Contributing

Thanks for your interest in improving `huckleberry-js`! This is an unofficial,
community project — see the disclaimer in the [README](./README.md).

## Prerequisites

- Node.js 18 or newer
- A Huckleberry account (only needed to run the smoke test against live data)

## Setup

```bash
git clone git@github.com:RobErskine/huckleberry-js.git
cd huckleberry-js
npm install
```

## Workflow

```bash
npm run build       # compile TypeScript to dist/
npm run typecheck   # type-check without emitting
npm test            # run the Vitest suite
npm run test:watch  # watch mode while developing
```

All checks must pass before a PR is merged. CI runs `typecheck`, `test`, and
`build` on Node 18/20/22 for every push and pull request.

### Smoke test (optional, hits live Firebase)

```bash
npm run build
HUCKLEBERRY_EMAIL=you@example.com HUCKLEBERRY_PASSWORD=secret npm run smoke
```

Use only credentials you own. Never commit secrets.

## Coding guidelines

- Keep the package **zero runtime dependencies**.
- Maintain ESM + first-class types; everything public is exported from `src/index.ts`.
- Add or update Vitest tests for any behavior change.
- Update `docs/` and the README when public behavior changes.

## Releasing (maintainers)

1. Update `CHANGELOG.md` and bump the version: `npm version <patch|minor|major>`.
2. Push the commit and tag: `git push --follow-tags`.
3. Create a GitHub Release for the new `vX.Y.Z` tag. This triggers
   `.github/workflows/release.yml`, which builds and publishes to npm.
   - Requires an `NPM_TOKEN` repository secret with publish access.
4. Alternatively publish manually: `npm publish` (runs `prepack` build +
   `prepublishOnly` checks; uses `publishConfig.access: "public"`).
