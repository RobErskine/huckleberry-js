# Huckleberry Firestore schema map

Reverse-engineered layout of the Huckleberry Firebase project
(`simpleintervals`). Canonical source: the Python client's
`py-huckleberry-api/src/huckleberry_api/firebase_types.py` and `api.py`.

> Units: `start` / `duration` are in **seconds**; `offset` is the timezone
> offset in **minutes**. `timerStartTime` is **milliseconds** for sleep but
> **seconds** for feed (a known footgun — see notes).

## Top-level documents

| Path | Purpose | Read API (v1) |
| --- | --- | --- |
| `users/{uid}` | account profile + `childList[]` | `getUser()` |
| `childs/{cid}` | child profile (`childsName`, `birthdate`, `gender`, …) | `getChild(cid)` |
| `sleep/{cid}` | active `timer` + `prefs.lastSleep` | `getSleep(cid)` |
| `feed/{cid}` | active nursing `timer` + `prefs.{lastNursing,lastBottle,lastSolid,lastSide}` | `getFeed(cid)` |
| `diaper/{cid}` | `prefs.{lastDiaper,lastPotty}` | `getDiaper(cid)` |
| `pump/{cid}` | `timer` + `prefs.lastPump` | `getPump(cid)` |
| `health/{cid}` | `prefs.{lastGrowthEntry,lastMedication,lastTemperature}` | `getHealth(cid)` |
| `activities/{cid}` | per-mode `timer.*` + `prefs.last*` | (parent read not yet wrapped) |
| `types/{cid}` + `types/{cid}/custom/{foodId}` | custom solids foods | (future) |

## History subcollections

| Path | Row model | Read API (v1) |
| --- | --- | --- |
| `sleep/{cid}/intervals/{id}` | `{ start, duration, offset, ... }` | `listSleepIntervals` |
| `feed/{cid}/intervals/{id}` | breast \| bottle \| solids row | `listFeedIntervals` |
| `diaper/{cid}/intervals/{id}` | `{ mode, start, offset, color, consistency, ... }` | `listDiaperIntervals` |
| `pump/{cid}/intervals/{id}` | `{ start, entryMode, leftAmount, rightAmount, units, ... }` | `listPumpIntervals` |
| `activities/{cid}/intervals/{id}` | `{ mode, start, offset, duration, ... }` | `listActivityIntervals` |
| `health/{cid}/data/{id}` | growth \| medication \| temperature row | `listHealthEntries` (future) |

Interval ids are `"{timestamp_ms}-{random_20_chars}"`.

### `multi: true` batched containers

Older rows are batched into wrapper documents shaped like
`{ multi: true, hasMoreRoom, lastUpdated, data: { <key>: <row>, ... } }`.
Because the nested `start` is not indexable, listing a range requires **two
queries** (already handled by `listIntervals`):

1. range-filter regular docs on top-level `start` (skip `multi` docs);
2. fetch all `multi == true` docs and filter their `data` entries in memory.

## Key field-name gotchas

- **Sleep timer** `timerStartTime` is **ms**; **feed timer** `timerStartTime`
  / `feedStartTime` are **seconds**.
- `prefs.lastBottle` uses `bottleAmount` / `bottleUnits`, but bottle interval
  rows use `amount` / `units`.
- Pump `total` entries are stored split evenly across `leftAmount` /
  `rightAmount` (sum == entered total).
- Growth/health history uses the `data` subcollection, not `intervals`.
- `_id` appears aliased on some interval rows.

## Not yet modeled

`insights`, `notifications/{uid}/messages`, `recommendations`,
`feedback/{uid}`, `health/{cid}/types`, `insights/{cid}/{dailyTips,miniPlans}`,
reminders (`reminderV2`).
