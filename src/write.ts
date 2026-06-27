/**
 * Pure helpers shared by the write methods: id generation, timezone offset, and
 * the "newest wins" guard for `prefs.last*` updates. Dependency-free and runnable
 * on Cloudflare Workers, Node 18+, and browsers (global `crypto`, `Intl`, `Date`).
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
