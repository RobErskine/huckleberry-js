# huckleberry-js

Unofficial TypeScript client (**read + write**) for the [Huckleberry](https://huckleberrycare.com/)
baby-tracking app's Firebase backend. A `fetch`-based client that runs anywhere
modern JS does — **Cloudflare Workers**, **Node 20+**, and **browsers** — with
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
rules, so this library reads **and writes** your data over plain HTTPS `fetch` —
making it portable to Workers, edge runtimes, Node, and the browser.

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

### Namespaced API (optional, ergonomic)

The same reads grouped by resource — handy when you'd rather not memorize the
flat method names. These delegate to the methods above (both styles are fully
supported), and list methods take a `{ start, end }` range:

```ts
const kids = await client.user.listChildren();
const cid = kids[0].cid;

const range = { start: new Date("2026-06-01"), end: new Date() };
await client.sleep.list(cid, range);
await client.feed.list(cid, range);     // breast, bottle, or solids
await client.diapers.list(cid, range);
await client.activities.list(cid, range);
await client.pump.list(cid, range);
await client.health.list(cid, range);
await client.health.getLatestGrowth(cid);

const summary = await client.dashboard.summary(cid);
```

## Logging events (writes)

As of **0.3.0** the client can write, not just read. Each `log*` method records
a history row and updates the matching `prefs.last*` summary. Timestamps accept a
`Date` or epoch **seconds**; omit `start` to use "now".

```ts
// Single-shot logs (flat or namespaced — both work)
await client.logDiaper(cid, { mode: "pee" });
await client.feed.logBottle(cid, { amount: 120, units: "ml" });
await client.feed.logNursing(cid, { start, end, side: "left" });
await client.sleep.log(cid, { start, end });
await client.pump.log(cid, { totalAmount: 80, units: "ml" });
await client.health.logGrowth(cid, { weight: 7.4, units: "metric" });
await client.activities.log(cid, { mode: "bath" });

// Solids: look up food IDs first, then log
const foods = await client.feed.foods.listCurated();
await client.feed.logSolids(cid, {
  foods: [{ id: foods[0].id, source: "curated", name: foods[0].name }],
  reaction: "LOVED",
});
```

### Live timers

Sleep and nursing have full timer state machines that read-modify-write the
parent doc's `timer` map. `complete*` writes the finished interval and clears the
timer; `cancel*` clears it without saving.

```ts
await client.sleep.start(cid);     // start a nap timer
await client.sleep.pause(cid);
await client.sleep.resume(cid);
await client.sleep.complete(cid);  // saves the interval + clears the timer

await client.feed.startNursing(cid, { side: "left" });
await client.feed.switchNursingSide(cid);
await client.feed.completeNursing(cid);
```

### Preview before committing (`dryRun`)

Every write accepts `{ dryRun: true }` and returns a `WriteResult`
(`{ dryRun, id?, plan }`). With `dryRun` it performs any necessary reads, builds
the planned Firestore writes, and returns them **without committing** — handy for
tests and confirmation flows.

```ts
const preview = await client.logDiaper(cid, { mode: "poo" }, { dryRun: true });
console.log(preview.plan); // the PATCH operations that *would* run
```

> **Heads-up:** writes hit your real Huckleberry account. There's no document
> delete in this library by design (Huckleberry has no hard/soft delete for
> tracker events); the only reversible removal is the `archived` toggle on custom
> solids foods via `client.feed.foods.setArchived(...)`.

### Errors

Every error extends `HuckleberryError` and carries machine-readable fields —
`category` (`auth` \| `not_found` \| `invalid_input` \| `api` \| `network`),
`retryable`, and a human/LLM-actionable `recovery` hint (`err.toJSON()` returns
that envelope). `AuthError` and `FirestoreError` keep their existing
`status`/`body` shape, so prior `instanceof` checks still work.

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

## API

### Read

| Method | Returns |
| --- | --- |
| `authenticate(email, password)` | `Session` |
| `ensureSession()` | refreshes the token if near expiry |
| `getSession()` | current `Session` or `null` |
| `getUser()` / `getChild(cid)` | account / child profile |
| `getSleep/getFeed/getDiaper/getPump/getHealth(cid)` | tracker parent doc (active timer + `prefs.last*`) |
| `listSleepIntervals/listFeedIntervals/listDiaperIntervals/listPumpIntervals/listActivityIntervals(cid, start, end)` | history rows (handles `multi` batches) |
| `getDashboardSummary(cid, name?)` | `DashboardSummary` rollup |
| `listSolidsCuratedFoods()` / `listSolidsCustomFoods(cid, opts?)` | solids food catalog |

### Write (0.3.0+)

All accept an optional final `{ dryRun?: boolean }` and return a `WriteResult`.

| Method | Writes |
| --- | --- |
| `logDiaper / logPotty(cid, input, opts?)` | a diaper/potty row + `prefs.lastDiaper`/`lastPotty` |
| `logBottle / logNursing / logSolids(cid, input, opts?)` | a feed row + the matching `prefs.last*` |
| `logSleep(cid, input, opts?)` | a sleep interval + `prefs.lastSleep` |
| `logPump(cid, input, opts?)` | a pump row + `prefs.lastPump` |
| `logGrowth(cid, input, opts?)` | a growth measurement + `prefs.lastGrowthEntry` |
| `logActivity(cid, input, opts?)` | an activity row + the per-mode `prefs.last*` |
| `startSleep/pauseSleep/resumeSleep/cancelSleep/completeSleep(cid, …)` | sleep timer transitions |
| `startNursing/pauseNursing/resumeNursing/switchNursingSide/cancelNursing/completeNursing(cid, …)` | nursing timer transitions |
| `createSolidsCustomFood / setCustomFoodArchived(cid, …)` | custom solids food CRUD + archive toggle |

Lower-level Firestore REST helpers (`FirestoreRest`, `decodeValue`,
`buildStartRangeQuery`, …) and all Firebase types are also exported from the
package root if you need to go beyond the high-level client.

## MCP server

Expose your Huckleberry data to Claude (and any MCP client) as typed tools — so
you can log a diaper, start a nap timer, or pull a summary in plain English.
Two transports ship with the package:

- **Local (stdio)** — `npx -p huckleberry-js huckleberry-mcp`, runs on **Node**
  (no Bun required). Best for Claude Desktop on your own machine.
- **Remote (Cloudflare Workers)** — deploy `huckleberry-js/mcp/worker` to the
  edge for an always-on, shareable endpoint. (A form Bun-only clients can't run.)

**Reads are on by default; writes are gated.** Write tools (`log_*`, the timer
tools) are **hidden and rejected** unless you set `HUCKLEBERRY_ENABLE_WRITES=1`
in the server environment. Every write tool also accepts `dryRun: true` to
preview before committing, and `cancel_*`/`complete_*` are flagged
`destructiveHint` so MCP clients can prompt for confirmation.

```bash
# read-only (default)
HUCKLEBERRY_EMAIL=… HUCKLEBERRY_PASSWORD=… npx -p huckleberry-js huckleberry-mcp

# read + write
HUCKLEBERRY_ENABLE_WRITES=1 \
  HUCKLEBERRY_EMAIL=… HUCKLEBERRY_PASSWORD=… npx -p huckleberry-js huckleberry-mcp
```

The MCP SDK is an **optional peer dependency** — the core library stays
zero-dependency; install `@modelcontextprotocol/sdk` only to run the stdio
server. See **[`docs/mcp.md`](docs/mcp.md)** for setup, config, the full tool
list, and the trade-offs between the two forms.

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
npm test            # vitest: value codec, query builder, multi-container expansion, auth/refresh, rollup, write methods + timers, MCP tools
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow and release steps.

## Docs

- [`docs/mcp.md`](docs/mcp.md) — MCP server: local (stdio) + remote (Workers) setup and trade-offs.
- [`docs/firestore-schema.md`](docs/firestore-schema.md) — reverse-engineered collection/field map.
- [`docs/write-roadmap.md`](docs/write-roadmap.md) — plan for write support & future work.

## License

[MIT](./LICENSE) © RobErskine. Not affiliated with Huckleberry Labs, Inc.
