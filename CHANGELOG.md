# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-06-27

### Added

- **Write support.** The client is no longer read-only. New single-shot log
  methods on `HuckleberryClient` and the namespaced API:
  - `logDiaper` / `logPotty` (`diapers.log` / `diapers.logPotty`)
  - `logBottle` / `logNursing` / `logSolids` (`feed.logBottle` / `feed.logNursing` / `feed.logSolids`)
  - `logSleep` (`sleep.log`)
  - `logPump` (`pump.log`)
  - `logGrowth` (`health.logGrowth`)
  - `logActivity` (`activities.log`)
- **Live timer state machines** for sleep and nursing:
  - Sleep — `startSleep`, `pauseSleep`, `resumeSleep`, `cancelSleep`, `completeSleep`
    (`sleep.start/pause/resume/cancel/complete`).
  - Nursing — `startNursing`, `pauseNursing`, `resumeNursing`, `switchNursingSide`,
    `cancelNursing`, `completeNursing` (`feed.startNursing` … `feed.completeNursing`).
- **Solids food catalog**: `listSolidsCuratedFoods`, `listSolidsCustomFoods`,
  `createSolidsCustomFood`, `setCustomFoodArchived` (namespaced under `feed.foods`).
- **plan/commit split**: every write accepts `{ dryRun?: boolean }` and returns a
  `WriteResult` (`{ dryRun, id?, plan }`). With `dryRun: true` it previews the
  planned Firestore writes without committing.
- **Firestore write primitives** exported from the package root: `encodeValue`,
  `encodeFields`, `int`, `DELETE_FIELD`, plus `FirestoreRest.patchDoc`,
  `updateFields`, and `createDoc`. (No document deletes — by design.)
- **MCP write tools** (20 new) gated behind the `HUCKLEBERRY_ENABLE_WRITES`
  environment variable on both transports. Hidden from `tools/list` and rejected
  with `WritesDisabledError` unless the flag is set. Write tools carry
  `readOnlyHint: false`; `cancel_*`/`complete_*` also carry `destructiveHint: true`.
  Each write tool accepts `dryRun: true` to preview. New read tools `get_sleep`,
  `get_feed`, `list_curated_foods`, and `list_custom_foods` support the write flows.
- New error type `WritesDisabledError` and exported `InvalidInputError`.

### Changed

- Dropped the "read-only" framing from the package description and docs.

## [0.2.0] - 2026-06-24

### Added

- Namespaced, ergonomic API (`client.sleep`, `client.feed`, `client.diapers`,
  `client.pump`, `client.health`, `client.activities`, `client.user`,
  `client.dashboard`) alongside the existing flat methods.
- Structured, LLM-friendly error hierarchy (`HuckleberryError` with `category`,
  `retryable`, `recovery`, and `toJSON()`).
- MCP server in two transports — local stdio (`huckleberry-mcp`) and a
  zero-dependency Cloudflare Workers handler — sharing one tool registry.

## [0.1.0] - 2026-06-19

### Added

- Initial release of `huckleberry-js`: a zero-dependency, read-only TypeScript
  client for the Huckleberry baby-tracking app, built on Firestore's REST API
  so it runs on Cloudflare Workers, Node 18+, and browsers.
- `HuckleberryClient` with email/password authentication, automatic ID-token
  refresh, and an `onSession` persistence callback for serverless reuse.
- Read methods: `getUser`, `getChild`, `getSleep/getFeed/getDiaper/getPump/getHealth`,
  `listSleepIntervals/listFeedIntervals/listDiaperIntervals/listPumpIntervals/listActivityIntervals`,
  and `getDashboardSummary`.
- Lower-level Firestore REST helpers and full Firebase type definitions exported
  from the package root.
- Smoke test script and Vitest unit tests.

[Unreleased]: https://github.com/RobErskine/huckleberry-js/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/RobErskine/huckleberry-js/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RobErskine/huckleberry-js/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/RobErskine/huckleberry-js/releases/tag/v0.1.0
