# huckleberry-js

Unofficial, read-only TypeScript client for the [Huckleberry](https://huckleberrycare.com/)
baby-tracking app's Firebase backend. A `fetch`-based client that runs anywhere
modern JS does — **Cloudflare Workers**, **Node 18+**, and **browsers** — with
**zero runtime dependencies** and first-class types.

[![npm](https://img.shields.io/npm/v/huckleberry-js.svg)](https://www.npmjs.com/package/huckleberry-js)
[![CI](https://github.com/RobErskine/huckleberry-js/actions/workflows/ci.yml/badge.svg)](https://github.com/RobErskine/huckleberry-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/huckleberry-js.svg)](./LICENSE)

> ### ⚠️ Disclaimer
>
> This is an **unofficial, independent project**. It is **not affiliated with,
> endorsed by, sponsored by, or in any way officially connected to Huckleberry
> Labs, Inc.** or any of its subsidiaries or affiliates. "Huckleberry" and
> related names, marks, and logos are trademarks of their respective owners and
> are used here for identification purposes only.
>
> This library interacts with **undocumented, private endpoints** that may
> change or break at any time. It is provided **"as is", without warranty of any
> kind**, and you use it **entirely at your own risk**. The authors accept no
> liability for account issues, data loss, or any damages arising from its use.
> Only use it with credentials **you own**, and in accordance with Huckleberry's
> Terms of Service.

## Why this exists

The Huckleberry mobile app stores data in Firebase. Official Firebase SDKs talk
to Firestore over **gRPC**, which can't run on Cloudflare Workers. Firestore's
**REST API** accepts the same Firebase ID token and enforces the same security
rules, so this library reads your data over plain HTTPS `fetch` — making it
portable to Workers, edge runtimes, Node, and the browser.

## Install

```bash
npm install huckleberry-js
```

```ts
import { HuckleberryClient } from "huckleberry-js";
```

> Until the first npm release is published you can consume it directly from
> GitHub — `npm install RobErskine/huckleberry-js` — or as a local
> `file:` dependency.

## Getting started

### 1. Credentials

Authenticate with the **same email + password** you use to sign in to the
Huckleberry app. Store them as secrets (env vars / a secrets manager / Workers
secrets) — never commit them.

```bash
export HUCKLEBERRY_EMAIL="you@example.com"
export HUCKLEBERRY_PASSWORD="your-password"
```

### 2. Authenticate and read a summary

```ts
import { HuckleberryClient } from "huckleberry-js";

const client = new HuckleberryClient();
await client.authenticate(process.env.HUCKLEBERRY_EMAIL!, process.env.HUCKLEBERRY_PASSWORD!);

const user = await client.getUser();
const cid = user!.childList[0].cid; // first child's id

// One-call heads-up rollup: last fed / nap / diaper / pump + any active timers
const summary = await client.getDashboardSummary(cid);
console.log(summary);
```

### 3. Pull history for a range

```ts
const since = new Date(Date.now() - 24 * 3600 * 1000);
const sleeps = await client.listSleepIntervals(cid, since, new Date());
```

`start` / `end` accept a `Date` or epoch **seconds**.

## Reusing a session (serverless / edge)

Authenticate once, persist the returned `Session` (the `refreshToken` + `uid`
is enough), and rehydrate later. The client auto-refreshes the ID token and
invokes `onSession` whenever it rotates, so you can re-persist it:

```ts
const client = new HuckleberryClient({
  session: stored, // { idToken, refreshToken, uid, expiresAt }
  onSession: async (s) => kv.put("session", JSON.stringify(s)),
});

const summary = await client.getDashboardSummary(cid); // refreshes if needed
```

Set `expiresAt: 0` on a rehydrated session to force an immediate refresh (useful
when you only persisted the refresh token).

### Cloudflare Workers

```ts
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const stored = await env.KV.get("session", "json");
    const client = new HuckleberryClient({
      session: stored ?? undefined,
      onSession: (s) => env.KV.put("session", JSON.stringify(s)),
    });
    if (!stored) await client.authenticate(env.HUCKLEBERRY_EMAIL, env.HUCKLEBERRY_PASSWORD);

    const summary = await client.getDashboardSummary(env.CHILD_ID);
    return Response.json(summary);
  },
};
```

## API (v1, read-only)

| Method | Returns |
| --- | --- |
| `authenticate(email, password)` | `Session` |
| `ensureSession()` | refreshes the token if near expiry |
| `getSession()` | current `Session` or `null` |
| `getUser()` / `getChild(cid)` | account / child profile |
| `getSleep/getFeed/getDiaper/getPump/getHealth(cid)` | tracker parent doc (active timer + `prefs.last*`) |
| `listSleepIntervals/listFeedIntervals/listDiaperIntervals/listPumpIntervals/listActivityIntervals(cid, start, end)` | history rows (handles `multi` batches) |
| `getDashboardSummary(cid, name?)` | `DashboardSummary` rollup |

Lower-level Firestore REST helpers (`FirestoreRest`, `decodeValue`,
`buildStartRangeQuery`, …) and all Firebase types are also exported from the
package root if you need to go beyond the high-level client.

## Smoke test

The single most important check — proves auth and a real Firestore REST read
work against your account:

```bash
npm run build
HUCKLEBERRY_EMAIL=you@example.com HUCKLEBERRY_PASSWORD=secret npm run smoke
```

It prints your child list and a dashboard summary.

## Develop

```bash
npm install
npm run build       # emits dist/
npm run typecheck
npm test            # vitest: value decoder, query builder, multi-container expansion, auth/refresh, rollup
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow and release steps.

## Docs

- [`docs/firestore-schema.md`](docs/firestore-schema.md) — reverse-engineered collection/field map.
- [`docs/write-roadmap.md`](docs/write-roadmap.md) — plan for write support & future work.

## License

[MIT](./LICENSE) © RobErskine. Not affiliated with Huckleberry Labs, Inc.
