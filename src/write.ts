/**
 * Pure helpers shared by the write methods: id generation, timezone offset, and
 * the "newest wins" guard for `prefs.last*` updates. Dependency-free and runnable
 * on Cloudflare Workers, Node 20+, and browsers (global `crypto`, `Intl`, `Date`).
 */

const HEX = "0123456789abcdef";

/** `length` random lowercase hex chars via global `crypto` (Worker-safe, uniform). */
export function hexId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < length; i++) s += HEX[bytes[i] & 0x0f];
  return s;
}

/**
 * History row / document id: `` `${epochMs}-${20 hex}` `` — mirrors the Python
 * client's `f"{int(time*1000)}-{uuid4().hex[:20]}"`.
 */
export function intervalId(nowMs: number = Date.now()): string {
  return `${nowMs}-${hexId(20)}`;
}

/** Timer-session id: 16 hex chars (Python `uuid4().hex[:16]`). */
export function sessionUuid(): string {
  return hexId(16);
}

/**
 * Timezone offset in minutes for an IANA zone at `date`, **negative for UTC+**
 * zones (e.g. `-120` for UTC+2). Matches the Python client
 * (`-utcoffset/60`) and JS `Date.prototype.getTimezoneOffset` sign convention.
 */
export function tzOffsetMinutes(timeZone: string, date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value);
  // The same instant's wall-clock reading in the target zone, reinterpreted as
  // UTC. Its distance from the real instant is the zone's offset east of UTC.
  const asUtcMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetEastMinutes = Math.round((asUtcMs - date.getTime()) / 60000);
  // `|| 0` collapses `-0` (from a zero offset) to a clean `+0`.
  return -offsetEastMinutes || 0;
}

/**
 * Whether a new event at `newStart` (epoch seconds) should overwrite the
 * existing `prefs.last*` whose start is `existingStart`. True when there is no
 * existing entry or the new event is at least as recent — matches the Python
 * client's `>=` comparison so backfilling old rows never clobbers a newer summary.
 */
export function shouldUpdateLast(
  existingStart: number | null | undefined,
  newStart: number,
): boolean {
  return existingStart == null || newStart >= existingStart;
}

// --- plan / commit: every write builds a WritePlan, then commits it (unless
// it's a dry run). This makes dry-run/preview free and keeps the writes for a
// single logical action explicit and testable. ---

/** A single document write: a full `set`, or a masked field `update`. */
export interface PlannedWrite {
  /** `set` creates/replaces the document; `update` merges only the listed (dotted) paths. */
  op: "set" | "update";
  path: string;
  /** For `set`: the document fields. For `update`: dotted field updates (values may be `DELETE_FIELD`). */
  data: Record<string, unknown>;
}

/** The ordered writes one logical write action performs (or previews, in a dry run). */
export interface WritePlan {
  /** Human-readable summary of the action (shown in dry-run previews). */
  description: string;
  writes: PlannedWrite[];
}

/** What every write method returns: the committed-or-previewed plan plus any created id. */
export interface WriteResult {
  /** True when this was a preview — no writes were performed. */
  dryRun: boolean;
  /** The id of the created history row, when the action creates one. */
  id?: string;
  /** The exact writes performed, or that a real run would perform. */
  plan: WritePlan;
}

/** Options accepted by every write method. */
export interface WriteOptions {
  /** Preview only: compute and return the plan without writing anything. */
  dryRun?: boolean;
}
