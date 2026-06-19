# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/RobErskine/huckleberry-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/RobErskine/huckleberry-js/releases/tag/v0.1.0
