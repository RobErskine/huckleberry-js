# Roadmap: writes, updates, and future features

v1 is **read-only** (a home heads-up display). This is the plan for everything
deferred, so the next iteration is a straightforward extension rather than a
redesign. The Python client (`py-huckleberry-api/src/huckleberry_api/api.py`)
is the reference implementation for every behavior below — keep it around until
write parity is reached.

## 1. Firestore write primitives (prerequisite)

Reads only needed a value **decoder**. Writes need the inverse plus three ops.
Add to `src/firestore.ts`:

- `encodeValue(v)` / `encodeFields(obj)` — JS → Firestore typed JSON. Critical
  rule: integers must be emitted as `{ integerValue: String(n) }`, floats as
  `{ doubleValue: n }`. Match the Python `to_firebase_dict` output (which uses
  `exclude_none`, so **omit null fields**).
- `patchDoc(path, fields, { merge })` — REST `PATCH {base}/{path}` with
  `?updateMask.fieldPaths=...` (merge) or no mask (replace). This is Firestore's
  `set(..., merge=True)` / `set(...)`.
- `updateFields(path, updates)` — `PATCH` with an explicit `updateMask` listing
  only changed paths; supports dotted field paths (`prefs.lastSleep`).
- Field deletes (`firestore.DELETE_FIELD`, used by `complete_sleep`): a `PATCH`
  that names the field in `updateMask` but omits it from the body.
- `createDoc(parentPath, collectionId, docId, fields)` — REST
  `PATCH {base}/{parent}/{collectionId}/{docId}` (Firestore upserts on PATCH).

Interval id format to reuse: `` `${Date.now()}-${random20()}` `` (20 url-safe chars).

## 2. Write methods to port (per tracker)

Mirror the Python method names/signatures. Each "log historical" call writes a
row to the `intervals` (or `data`) subcollection **and** updates the parent
doc's `prefs.last*` summary (and sometimes `timestamp`/`local_timestamp`).

| Domain | Methods (from api.py) |
| --- | --- |
| Sleep | `startSleep`, `pauseSleep`, `resumeSleep`, `cancelSleep`, `completeSleep`, `logSleep` |
| Nursing | `startNursing`, `pauseNursing`, `resumeNursing`, `switchNursingSide`, `cancelNursing`, `completeNursing`, `logNursing` |
| Bottle | `logBottle` |
| Solids | `listSolidsCuratedFoods`, `listSolidsCustomFoods`, `createSolidsCustomFood`, `logSolids` |
| Diaper | `logDiaper`, `logPotty` |
| Pump | `logPump` |
| Growth | `logGrowth` |
| Activities | `logActivity` |

Timer-based flows (start/pause/resume/complete) read-modify-write the parent
`timer` map. **Reproduce the unit rules exactly** (sleep ms vs feed seconds;
`activeSide`/`lastSide` transitions; pump total split). Port the timezone
`offset` computation (`_get_timezone_offset_minutes`) — set it from the client's
configured IANA timezone.

## 3. Read methods still to wrap

- `getActivities(cid)` parent doc + `getLatestGrowth(cid)` (from
  `health.prefs.lastGrowthEntry`).
- `listHealthEntries(cid, start, end)` (the `data` subcollection variant).
- Strict runtime validation (the Python lib uses Pydantic). Optional: add
  [zod](https://zod.dev) schemas in `types.ts` and validate decoded docs.

## 4. Real-time updates — out of scope on Workers

The Python client uses Firestore `onSnapshot` listeners (persistent gRPC /
WebChannel). Cloudflare Workers are request/response and can't hold a streaming
connection, so the dashboard **polls** instead (every ~60s). If true push is
ever wanted: a Durable Object could hold a `Listen` long-poll, or a separate
always-on host could run the listeners and forward via WebSocket.

## 5. Dashboard write UI (separate effort)

Once write methods exist, add gated `POST /api/log/*` routes to
`huckleberry-dashboard` and quick-action buttons ("Log diaper", "Start nap").
Keep mutations behind the same session guard; consider a confirm step so the
home display can't fat-finger entries.

## Suggested order

1. `encodeValue` + `patchDoc`/`updateFields` + tests against fixtures.
2. `logDiaper` (simplest: instant event, single row + `prefs.lastDiaper`).
3. `logBottle`, `logGrowth`, `logPump`, `logActivity` (also single-shot).
4. Sleep + nursing timer state machines (most complex).
5. Solids (custom-food catalog + curated foods from Storage).
6. Dashboard quick-action buttons.
