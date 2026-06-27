/**
 * HuckleberryClient — read-only (v1) client for the Huckleberry baby tracker.
 *
 * Framework-agnostic: uses the global `fetch`, so it runs on Cloudflare
 * Workers, Node 18+, and modern browsers. Authentication mints a Firebase ID
 * token; all reads go through Firestore's REST API (see `firestore.ts`).
 *
 * Writes (start/log sleep, nursing, bottle, diaper, pump, growth, …) are not
 * implemented yet — see `docs/write-roadmap.md`.
 */

import { refresh, signIn, type Session } from "./auth.js";
import {
  FirestoreRest,
  listIntervals,
  type FetchLike,
} from "./firestore.js";
import { tzOffsetMinutes } from "./write.js";
import { FIRESTORE_BASE_URL } from "./const.js";
import {
  ActivitiesNamespace,
  DashboardNamespace,
  DiapersNamespace,
  FeedNamespace,
  HealthNamespace,
  PumpNamespace,
  SleepNamespace,
  UserNamespace,
} from "./namespaces.js";
import type {
  DashboardSummary,
  FirebaseActivityIntervalData,
  FirebaseChildDocument,
  FirebaseDiaperData,
  FirebaseDiaperDocumentData,
  FirebaseFeedDocumentData,
  FirebaseFeedIntervalData,
  FirebaseGrowthData,
  FirebaseHealthDocumentData,
  FirebasePumpDocumentData,
  FirebasePumpIntervalData,
  FirebaseSleepDocumentData,
  FirebaseSleepIntervalData,
  FirebaseUserDocument,
} from "./types.js";

/** Refresh the token when it expires within this many ms (matches Python: 5 min). */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface HuckleberryClientOptions {
  /** Override the global fetch (e.g. for tests or a custom agent). */
  fetch?: FetchLike;
  /** Override the Firestore REST base (rarely needed). */
  firestoreBaseUrl?: string;
  /** Reuse a stored session (e.g. a refresh token persisted in KV). */
  session?: Session;
  /**
   * Called whenever the session is refreshed/rotated. Use this to persist the
   * new refresh token (Firebase rotates it on refresh).
   */
  onSession?: (session: Session) => void | Promise<void>;
  /**
   * IANA timezone (e.g. `"America/New_York"`) used to compute the `offset`
   * field on written rows. When omitted, the client uses the account's
   * `latestTimezone`, then the host environment, then UTC.
   */
  timezone?: string;
}

function toSeconds(d: Date | number): number {
  return d instanceof Date ? d.getTime() / 1000 : d;
}

export class HuckleberryClient {
  private session: Session | null;
  private readonly fetchImpl: FetchLike;
  private readonly fs: FirestoreRest;
  private readonly onSession?: (session: Session) => void | Promise<void>;
  private refreshing: Promise<void> | null = null;
  private readonly configuredTimezone?: string;
  private cachedTimezone?: string;

  constructor(opts: HuckleberryClientOptions = {}) {
    // Bind to globalThis: on Cloudflare Workers the built-in `fetch` throws
    // "Illegal invocation" if called as a method (`this.fetchImpl(...)`) because
    // that rebinds `this`. A bound function ignores the call-site `this`.
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
    this.session = opts.session ?? null;
    this.onSession = opts.onSession;
    this.configuredTimezone = opts.timezone;
    this.fs = new FirestoreRest(
      () => this.getToken(),
      this.fetchImpl,
      opts.firestoreBaseUrl ?? FIRESTORE_BASE_URL,
    );
  }

  // -------------------------------------------------------------------------
  // Namespaced API — ergonomic, resource-grouped accessors that delegate to the
  // flat methods below. Additive: the flat methods remain fully supported.
  //   client.sleep.list(cid, { start, end })  ≡  client.listSleepIntervals(...)
  // -------------------------------------------------------------------------

  private _user?: UserNamespace;
  private _sleep?: SleepNamespace;
  private _feed?: FeedNamespace;
  private _diapers?: DiapersNamespace;
  private _pump?: PumpNamespace;
  private _health?: HealthNamespace;
  private _activities?: ActivitiesNamespace;
  private _dashboard?: DashboardNamespace;

  /** User + child accessors (`get`, `getChild`, `listChildren`). */
  get user(): UserNamespace {
    return (this._user ??= new UserNamespace(this));
  }
  /** Sleep accessors (`get`, `list`). */
  get sleep(): SleepNamespace {
    return (this._sleep ??= new SleepNamespace(this));
  }
  /** Feed accessors (`get`, `list`). */
  get feed(): FeedNamespace {
    return (this._feed ??= new FeedNamespace(this));
  }
  /** Diaper accessors (`get`, `list`). */
  get diapers(): DiapersNamespace {
    return (this._diapers ??= new DiapersNamespace(this));
  }
  /** Pump accessors (`get`, `list`). */
  get pump(): PumpNamespace {
    return (this._pump ??= new PumpNamespace(this));
  }
  /** Health accessors (`get`, `list`, `getLatestGrowth`). */
  get health(): HealthNamespace {
    return (this._health ??= new HealthNamespace(this));
  }
  /** Activity accessors (`list`). */
  get activities(): ActivitiesNamespace {
    return (this._activities ??= new ActivitiesNamespace(this));
  }
  /** Dashboard rollup accessor (`summary`). */
  get dashboard(): DashboardNamespace {
    return (this._dashboard ??= new DashboardNamespace(this));
  }

  /** Sign in with Huckleberry email + password. Stores and returns the session. */
  async authenticate(email: string, password: string): Promise<Session> {
    this.session = await signIn(email, password, this.fetchImpl);
    await this.onSession?.(this.session);
    return this.session;
  }

  /** The current session, if authenticated. */
  getSession(): Session | null {
    return this.session;
  }

  /** The Firebase user id (uid) of the signed-in account. */
  get uid(): string {
    if (!this.session) throw new Error("Not authenticated");
    return this.session.uid;
  }

  /** Ensure a valid (non-expired) ID token, refreshing if needed. */
  async ensureSession(): Promise<void> {
    if (!this.session) throw new Error("Not authenticated — call authenticate() first");
    if (Date.now() < this.session.expiresAt - REFRESH_SKEW_MS) return;

    // Collapse concurrent refreshes into one in-flight request.
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const prev = this.session!;
        const next = await refresh(prev.refreshToken, this.fetchImpl);
        this.session = { ...next, uid: prev.uid };
        await this.onSession?.(this.session);
      })().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
  }

  private async getToken(): Promise<string> {
    await this.ensureSession();
    return this.session!.idToken;
  }

  // -------------------------------------------------------------------------
  // User & child
  // -------------------------------------------------------------------------

  async getUser(): Promise<FirebaseUserDocument | null> {
    return (await this.fs.getDoc(`users/${this.uid}`)) as FirebaseUserDocument | null;
  }

  // -------------------------------------------------------------------------
  // Write support — timezone resolution (used to stamp `offset` on rows)
  // -------------------------------------------------------------------------

  /**
   * The IANA timezone used to compute `offset` on written rows: the configured
   * option, else the account's `latestTimezone`, else the host environment,
   * else UTC. Resolved once and cached.
   */
  async resolveTimezone(): Promise<string> {
    if (this.configuredTimezone) return this.configuredTimezone;
    if (this.cachedTimezone) return this.cachedTimezone;
    const fromAccount = (await this.getUser())?.latestTimezone;
    this.cachedTimezone =
      fromAccount ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC";
    return this.cachedTimezone;
  }

  /** The timezone `offset` (minutes, negative for UTC+) to stamp on a row at `date`. */
  async offsetMinutes(date: Date = new Date()): Promise<number> {
    return tzOffsetMinutes(await this.resolveTimezone(), date);
  }

  async getChild(cid: string): Promise<FirebaseChildDocument | null> {
    return (await this.fs.getDoc(`childs/${cid}`)) as FirebaseChildDocument | null;
  }

  // -------------------------------------------------------------------------
  // Tracker parent documents (active timer + prefs.last* summaries)
  // -------------------------------------------------------------------------

  async getSleep(cid: string): Promise<FirebaseSleepDocumentData | null> {
    return (await this.fs.getDoc(`sleep/${cid}`)) as FirebaseSleepDocumentData | null;
  }

  async getFeed(cid: string): Promise<FirebaseFeedDocumentData | null> {
    return (await this.fs.getDoc(`feed/${cid}`)) as FirebaseFeedDocumentData | null;
  }

  async getDiaper(cid: string): Promise<FirebaseDiaperDocumentData | null> {
    return (await this.fs.getDoc(`diaper/${cid}`)) as FirebaseDiaperDocumentData | null;
  }

  async getPump(cid: string): Promise<FirebasePumpDocumentData | null> {
    return (await this.fs.getDoc(`pump/${cid}`)) as FirebasePumpDocumentData | null;
  }

  async getHealth(cid: string): Promise<FirebaseHealthDocumentData | null> {
    return (await this.fs.getDoc(`health/${cid}`)) as FirebaseHealthDocumentData | null;
  }

  // -------------------------------------------------------------------------
  // Interval history (time-ranged, with multi-container expansion)
  // -------------------------------------------------------------------------

  async listSleepIntervals(
    cid: string,
    start: Date | number,
    end: Date | number,
  ): Promise<FirebaseSleepIntervalData[]> {
    return listIntervals<FirebaseSleepIntervalData>(
      this.fs,
      `sleep/${cid}`,
      "intervals",
      toSeconds(start),
      toSeconds(end),
    );
  }

  async listFeedIntervals(
    cid: string,
    start: Date | number,
    end: Date | number,
  ): Promise<FirebaseFeedIntervalData[]> {
    return listIntervals<FirebaseFeedIntervalData & { start: number }>(
      this.fs,
      `feed/${cid}`,
      "intervals",
      toSeconds(start),
      toSeconds(end),
    );
  }

  async listDiaperIntervals(
    cid: string,
    start: Date | number,
    end: Date | number,
  ): Promise<FirebaseDiaperData[]> {
    return listIntervals<FirebaseDiaperData>(
      this.fs,
      `diaper/${cid}`,
      "intervals",
      toSeconds(start),
      toSeconds(end),
    );
  }

  async listPumpIntervals(
    cid: string,
    start: Date | number,
    end: Date | number,
  ): Promise<FirebasePumpIntervalData[]> {
    return listIntervals<FirebasePumpIntervalData>(
      this.fs,
      `pump/${cid}`,
      "intervals",
      toSeconds(start),
      toSeconds(end),
    );
  }

  async listActivityIntervals(
    cid: string,
    start: Date | number,
    end: Date | number,
  ): Promise<FirebaseActivityIntervalData[]> {
    return listIntervals<FirebaseActivityIntervalData>(
      this.fs,
      `activities/${cid}`,
      "intervals",
      toSeconds(start),
      toSeconds(end),
    );
  }

  async listHealthIntervals(
    cid: string,
    start: Date | number,
    end: Date | number,
  ): Promise<FirebaseGrowthData[]> {
    return listIntervals<FirebaseGrowthData>(
      this.fs,
      `health/${cid}`,
      "intervals",
      toSeconds(start),
      toSeconds(end),
    );
  }

  // -------------------------------------------------------------------------
  // Dashboard rollup
  // -------------------------------------------------------------------------

  /**
   * Assemble a "heads-up" summary for one child from the tracker parent docs
   * (last fed / last nap / last diaper / last pump / latest growth + any
   * in-progress timers). One GET per tracker, no subcollection queries.
   */
  async getDashboardSummary(
    cid: string,
    childName: string | null = null,
  ): Promise<DashboardSummary> {
    const [sleep, feed, diaper, pump, health] = await Promise.all([
      this.getSleep(cid),
      this.getFeed(cid),
      this.getDiaper(cid),
      this.getPump(cid),
      this.getHealth(cid),
    ]);

    const sleepInProgress = !!(sleep?.timer?.active && !sleep.timer.paused);
    const feedInProgress = !!(feed?.timer?.active && !feed.timer.paused);

    const lastSleep = sleep?.prefs?.lastSleep?.start
      ? {
          start: sleep.prefs.lastSleep.start,
          duration: sleep.prefs.lastSleep.duration ?? null,
          offset: sleep.prefs.lastSleep.offset ?? null,
        }
      : null;

    const lastFeed = pickLastFeed(feed);

    const lastDiaper = pickLastDiaper(diaper);

    const lastPump = pump?.prefs?.lastPump?.start
      ? {
          start: pump.prefs.lastPump.start,
          duration: pump.prefs.lastPump.duration ?? null,
        }
      : null;

    const lastGrowth = health?.prefs?.lastGrowthEntry ?? null;

    return {
      child: { cid, name: childName },
      sleepInProgress,
      feedInProgress,
      lastSleep,
      lastFeed,
      lastDiaper,
      lastPump,
      lastGrowth,
      generatedAt: Date.now(),
    };
  }
}

function pickLastFeed(
  feed: FirebaseFeedDocumentData | null,
): DashboardSummary["lastFeed"] {
  const prefs = feed?.prefs;
  if (!prefs) return null;

  const candidates: DashboardSummary["lastFeed"][] = [];

  const n = prefs.lastNursing;
  if (n?.start) {
    const sides: string[] = [];
    if (n.leftDuration) sides.push("L");
    if (n.rightDuration) sides.push("R");
    candidates.push({
      kind: "nursing",
      start: n.start,
      duration: n.duration ?? null,
      detail: sides.length ? sides.join("+") : null,
    });
  }

  const b = prefs.lastBottle;
  if (b?.start) {
    const detail =
      b.bottleAmount != null
        ? `${b.bottleAmount}${b.bottleUnits ?? ""} ${b.bottleType ?? ""}`.trim()
        : (b.bottleType ?? null);
    candidates.push({ kind: "bottle", start: b.start, detail });
  }

  const s = prefs.lastSolid;
  if (s?.start) {
    const names = s.foods
      ? Object.values(s.foods)
          .map((f) => f.created_name)
          .filter(Boolean)
      : [];
    candidates.push({
      kind: "solids",
      start: s.start,
      detail: names.length ? names.join(", ") : null,
    });
  }

  if (!candidates.length) return null;
  return candidates.reduce((a, c) => (c!.start > a!.start ? c : a))!;
}

function pickLastDiaper(
  diaper: FirebaseDiaperDocumentData | null,
): DashboardSummary["lastDiaper"] {
  const prefs = diaper?.prefs;
  if (!prefs) return null;

  const all = [prefs.lastDiaper, prefs.lastPotty].filter(
    (d): d is NonNullable<typeof d> => !!d?.start,
  );
  if (!all.length) return null;
  const latest = all.reduce((a, c) => (c.start! > a.start! ? c : a));
  return { start: latest.start!, mode: latest.mode ?? null };
}
