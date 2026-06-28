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
  DELETE_FIELD,
  FirestoreRest,
  int,
  listIntervals,
  type FetchLike,
} from "./firestore.js";
import {
  hexId,
  intervalId,
  shouldUpdateLast,
  tzOffsetMinutes,
  type PlannedWrite,
  type WriteOptions,
  type WritePlan,
  type WriteResult,
} from "./write.js";
import { InvalidInputError } from "./errors.js";
import { CURATED_FOODS_BUCKET, CURATED_FOODS_OBJECT, FIRESTORE_BASE_URL } from "./const.js";
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
  ActivityMode,
  BottleType,
  DiaperMode,
  FeedSide,
  PooColor,
  PooConsistency,
  PottyResult,
  PumpEntryMode,
  SolidsFoodSource,
  SolidsReaction,
  VolumeUnits,
  FirebaseActivityIntervalData,
  FirebaseChildDocument,
  FirebaseCuratedFoodDocument,
  FirebaseCustomFoodTypeDocument,
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

/** Relative amount for a diaper's pee/poo (maps to 0 / 50 / 100). */
export type DiaperAmount = "little" | "medium" | "big";

/** Input for {@link HuckleberryClient.logDiaper}. */
export interface LogDiaperInput {
  mode: DiaperMode;
  /** When it happened — `Date` or epoch seconds. Defaults to now. */
  start?: Date | number;
  peeAmount?: DiaperAmount;
  pooAmount?: DiaperAmount;
  color?: PooColor;
  consistency?: PooConsistency;
  diaperRash?: boolean;
  notes?: string;
}

/** Input for {@link HuckleberryClient.logPotty} (a diaper event with no `diaperRash`). */
export interface LogPottyInput extends Omit<LogDiaperInput, "diaperRash"> {
  howItHappened: PottyResult;
}

const DIAPER_AMOUNTS: Record<DiaperAmount, number> = {
  little: 0,
  medium: 50,
  big: 100,
};

/** Input for {@link HuckleberryClient.logBottle}. */
export interface LogBottleInput {
  amount: number;
  /** When it happened — `Date` or epoch seconds. Defaults to now. */
  start?: Date | number;
  /** Defaults to `"Formula"`. */
  bottleType?: BottleType;
  /** Defaults to `"ml"`. */
  units?: VolumeUnits;
}

/** Input for {@link HuckleberryClient.logGrowth} (at least one measurement required). */
export interface LogGrowthInput {
  start?: Date | number;
  weight?: number;
  height?: number;
  head?: number;
  /** Unit system; defaults to `"metric"`. */
  units?: "metric" | "imperial";
}

/**
 * Input for {@link HuckleberryClient.logPump}. Provide either `totalAmount`
 * (split evenly across both sides) or both `leftAmount` and `rightAmount`.
 */
export interface LogPumpInput {
  start?: Date | number;
  duration?: number;
  leftAmount?: number;
  rightAmount?: number;
  totalAmount?: number;
  /** Defaults to `"ml"`. */
  units?: VolumeUnits;
  notes?: string;
}

/** Input for {@link HuckleberryClient.logActivity}. */
export interface LogActivityInput {
  mode: ActivityMode;
  start?: Date | number;
  duration?: number;
  notes?: string;
}

/** Input for {@link HuckleberryClient.logSleep} (a completed past sleep, no live timer). */
export interface LogSleepInput {
  start: Date | number;
  end: Date | number;
  /** Optional sleep details, written verbatim onto the interval row. */
  details?: Record<string, unknown>;
}

/** Input for {@link HuckleberryClient.logNursing} (a completed past nursing session). */
export interface LogNursingInput {
  start: Date | number;
  end: Date | number;
  /** Side nursed; defaults to `"left"`. Used to split the duration when no per-side durations are given. */
  side?: FeedSide;
  /** Explicit per-side durations (seconds). Provide both or neither. */
  leftDuration?: number;
  rightDuration?: number;
}

/** A reference to an existing curated/custom food, for {@link HuckleberryClient.logSolids}. */
export interface SolidsFoodRef {
  id: string;
  source: SolidsFoodSource;
  name: string;
  amount?: string | number;
}

/** Input for {@link HuckleberryClient.logSolids}. */
export interface LogSolidsInput {
  foods: SolidsFoodRef[];
  start?: Date | number;
  notes?: string;
  reaction?: SolidsReaction;
  /** Firebase Storage image filename for the meal note. */
  foodNoteImage?: string;
}

/** Input for {@link HuckleberryClient.startSleep}. Optional sleep-condition details, written verbatim. */
export interface StartSleepInput {
  details?: Record<string, unknown>;
}

/** Input for {@link HuckleberryClient.startNursing}. Defaults to `"left"` side. */
export interface StartNursingInput {
  side?: FeedSide;
}

/** Input for {@link HuckleberryClient.resumeNursing}. Overrides the stored `lastSide`. */
export interface ResumeNursingInput {
  side?: FeedSide;
}

/** Maps an activity mode to its `prefs.last*` summary field. */
const ACTIVITY_LAST_FIELD: Record<ActivityMode, string> = {
  bath: "lastBath",
  tummyTime: "lastTummyTime",
  storyTime: "lastStoryTime",
  screenTime: "lastScreenTime",
  skinToSkin: "lastSkinToSkin",
  outdoorPlay: "lastOutdoorPlay",
  indoorPlay: "lastIndoorPlay",
  brushTeeth: "lastBrushTeeth",
};

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

  /** Execute a plan's writes in order (interval row first, then prefs). */
  private async commit(plan: WritePlan): Promise<void> {
    for (const w of plan.writes) {
      if (w.op === "set") await this.fs.setDoc(w.path, w.data);
      else await this.fs.updateFields(w.path, w.data);
    }
  }

  /** Commit a plan (unless `dryRun`) and return the uniform write result. */
  private async runPlan(
    plan: WritePlan,
    id: string | undefined,
    opts: WriteOptions | undefined,
  ): Promise<WriteResult> {
    const dryRun = opts?.dryRun ?? false;
    if (!dryRun) await this.commit(plan);
    return { dryRun, id, plan };
  }

  /**
   * Build the `prefs.last*` merge-update common to every log method: the given
   * prefs subfields (keyed without the `prefs.` prefix) plus the standard
   * `prefs.timestamp` / `prefs.local_timestamp` stamps.
   */
  private prefUpdate(
    parentPath: string,
    prefs: Record<string, unknown>,
    nowSec: number,
  ): PlannedWrite {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(prefs)) data[`prefs.${k}`] = v;
    data["prefs.timestamp"] = { seconds: nowSec };
    data["prefs.local_timestamp"] = nowSec;
    return { op: "update", path: parentPath, data };
  }

  // -------------------------------------------------------------------------
  // Diaper writes
  // -------------------------------------------------------------------------

  /**
   * Log a diaper change: writes a row to `diaper/{cid}/intervals` and updates
   * `prefs.lastDiaper` (unless an existing summary is newer). Pass
   * `{ dryRun: true }` to preview the writes without performing them.
   */
  async logDiaper(
    cid: string,
    input: LogDiaperInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.logDiaperOrPotty(cid, "lastDiaper", input, opts);
  }

  /** Log a potty event: like {@link logDiaper} but updates `prefs.lastPotty`. */
  async logPotty(
    cid: string,
    input: LogPottyInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.logDiaperOrPotty(cid, "lastPotty", input, opts);
  }

  private async logDiaperOrPotty(
    cid: string,
    prefField: "lastDiaper" | "lastPotty",
    input: LogDiaperInput & { howItHappened?: PottyResult },
    opts: WriteOptions | undefined,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    if (!input?.mode) {
      throw new InvalidInputError("mode is required (pee | poo | both | dry).");
    }
    const isPotty = prefField === "lastPotty";
    const start = toSeconds(input.start ?? new Date());
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();

    // Interval row — minimal fields by default, matching the app.
    const row: Record<string, unknown> = {
      mode: input.mode,
      start,
      lastUpdated: nowSec,
      offset,
    };
    const quantity: Record<string, number> = {};
    if (input.peeAmount) quantity.pee = DIAPER_AMOUNTS[input.peeAmount];
    if (input.pooAmount) quantity.poo = DIAPER_AMOUNTS[input.pooAmount];
    if (Object.keys(quantity).length) row.quantity = quantity;
    if (input.color) row.color = input.color;
    if (input.consistency) row.consistency = input.consistency;
    if (input.diaperRash && !isPotty) row.diaperRash = true;
    if (input.notes) row.notes = input.notes;
    if (isPotty) {
      row.isPotty = true;
      if (input.howItHappened) row.howItHappened = input.howItHappened;
    }

    // Only refresh prefs.last* when this event is at least as recent.
    const parent = await this.getDiaper(cid);
    const existingStart = parent?.prefs?.[prefField]?.start ?? null;

    const id = intervalId(nowMs);
    const writes: WritePlan["writes"] = [
      { op: "set", path: `diaper/${cid}/intervals/${id}`, data: row },
    ];
    if (shouldUpdateLast(existingStart, start)) {
      writes.push(
        this.prefUpdate(
          `diaper/${cid}`,
          { [prefField]: { start, mode: input.mode, offset } },
          nowSec,
        ),
      );
    }

    const plan: WritePlan = {
      description: `${isPotty ? "Log potty" : "Log diaper"} (${input.mode}) for child ${cid}`,
      writes,
    };
    return this.runPlan(plan, id, opts);
  }

  // -------------------------------------------------------------------------
  // Bottle / growth / pump / activity writes (single-shot history events)
  // -------------------------------------------------------------------------

  /**
   * Log a bottle feed: writes a row to `feed/{cid}/intervals` and updates
   * `prefs.lastBottle` (+ the document-level bottle prefs) unless an existing
   * summary is newer. The interval row uses `amount`/`units`; the summary uses
   * `bottleAmount`/`bottleUnits`.
   */
  async logBottle(
    cid: string,
    input: LogBottleInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    if (typeof input?.amount !== "number" || !Number.isFinite(input.amount)) {
      throw new InvalidInputError("amount is required (a finite number).");
    }
    const bottleType = input.bottleType ?? "Formula";
    const units = input.units ?? "ml";
    const start = toSeconds(input.start ?? new Date());
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();

    const row = {
      mode: "bottle",
      start,
      lastUpdated: nowSec,
      bottleType,
      amount: input.amount,
      units,
      offset,
      end_offset: offset,
    };
    const existingStart = (await this.getFeed(cid))?.prefs?.lastBottle?.start ?? null;

    const id = intervalId(nowMs);
    const writes: PlannedWrite[] = [
      { op: "set", path: `feed/${cid}/intervals/${id}`, data: row },
    ];
    if (shouldUpdateLast(existingStart, start)) {
      writes.push(
        this.prefUpdate(
          `feed/${cid}`,
          {
            lastBottle: {
              mode: "bottle",
              start,
              bottleType,
              bottleAmount: input.amount,
              bottleUnits: units,
              offset,
            },
            bottleType,
            bottleAmount: input.amount,
            bottleUnits: units,
          },
          nowSec,
        ),
      );
    }
    return this.runPlan(
      {
        description: `Log bottle (${input.amount}${units} ${bottleType}) for child ${cid}`,
        writes,
      },
      id,
      opts,
    );
  }

  /**
   * Log a growth measurement: writes a row to `health/{cid}/data` (note: the
   * `data` subcollection, not `intervals`) and updates `prefs.lastGrowthEntry`
   * with the same snapshot. At least one of weight/height/head is required.
   */
  async logGrowth(
    cid: string,
    input: LogGrowthInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    if (!input?.weight && !input?.height && !input?.head) {
      throw new InvalidInputError(
        "At least one measurement (weight, height, or head) is required.",
      );
    }
    const metric = (input.units ?? "metric") === "metric";
    const start = toSeconds(input.start ?? new Date());
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();
    const id = intervalId(nowMs);

    const row: Record<string, unknown> = {
      _id: id,
      type: "health",
      mode: "growth",
      start,
      lastUpdated: nowSec,
      offset,
      isNight: false,
    };
    if (input.weight != null) {
      row.weight = input.weight;
      row.weightUnits = metric ? "kg" : "lbs.oz";
    }
    if (input.height != null) {
      row.height = input.height;
      row.heightUnits = metric ? "cm" : "ft.in";
    }
    if (input.head != null) {
      row.head = input.head;
      row.headUnits = metric ? "hcm" : "hin";
    }

    const existingStart =
      (await this.getHealth(cid))?.prefs?.lastGrowthEntry?.start ?? null;

    const writes: PlannedWrite[] = [
      { op: "set", path: `health/${cid}/data/${id}`, data: row },
    ];
    if (shouldUpdateLast(existingStart, start)) {
      writes.push(this.prefUpdate(`health/${cid}`, { lastGrowthEntry: row }, nowSec));
    }
    return this.runPlan(
      { description: `Log growth for child ${cid}`, writes },
      id,
      opts,
    );
  }

  /**
   * Log a pump session: writes a row to `pump/{cid}/intervals` and updates
   * `prefs.lastPump` unless newer. A `totalAmount` is split evenly across
   * `leftAmount`/`rightAmount`; otherwise both side amounts are required.
   */
  async logPump(
    cid: string,
    input: LogPumpInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    if (input.duration != null && input.duration < 0) {
      throw new InvalidInputError("duration must be non-negative.");
    }
    const usingTotal = input.totalAmount != null;
    if (usingTotal && (input.leftAmount != null || input.rightAmount != null)) {
      throw new InvalidInputError(
        "Provide either totalAmount or left/right amounts, not both.",
      );
    }
    let entryMode: PumpEntryMode;
    let left: number;
    let right: number;
    if (usingTotal) {
      entryMode = "total";
      left = right = (input.totalAmount as number) / 2;
    } else {
      entryMode = "leftright";
      if (input.leftAmount == null || input.rightAmount == null) {
        throw new InvalidInputError(
          "leftright pump entries require both leftAmount and rightAmount.",
        );
      }
      left = input.leftAmount;
      right = input.rightAmount;
    }
    const units = input.units ?? "ml";
    const start = toSeconds(input.start ?? new Date());
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();
    const hasDuration = input.duration != null;
    const id = intervalId(nowMs);

    const row: Record<string, unknown> = {
      start,
      entryMode,
      leftAmount: left,
      rightAmount: right,
      units,
      offset,
      lastUpdated: nowSec,
    };
    if (hasDuration) {
      row.duration = input.duration;
      row.end_offset = offset;
    }
    if (input.notes) row.notes = input.notes;

    const existingStart = (await this.getPump(cid))?.prefs?.lastPump?.start ?? null;

    const writes: PlannedWrite[] = [
      { op: "set", path: `pump/${cid}/intervals/${id}`, data: row },
    ];
    if (shouldUpdateLast(existingStart, start)) {
      const lastPump: Record<string, unknown> = {
        start,
        entryMode,
        leftAmount: left,
        rightAmount: right,
        units,
        offset,
      };
      if (hasDuration) lastPump.duration = input.duration;
      writes.push(this.prefUpdate(`pump/${cid}`, { lastPump }, nowSec));
    }
    return this.runPlan(
      { description: `Log pump (${entryMode}) for child ${cid}`, writes },
      id,
      opts,
    );
  }

  /**
   * Log an activity: writes a row to `activities/{cid}/intervals` and updates
   * the per-mode `prefs.last*` summary (e.g. `lastTummyTime`) unless newer.
   */
  async logActivity(
    cid: string,
    input: LogActivityInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    if (!input?.mode) throw new InvalidInputError("mode is required.");
    if (input.duration != null && input.duration < 0) {
      throw new InvalidInputError("duration must be non-negative.");
    }
    const start = toSeconds(input.start ?? new Date());
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();
    const hasDuration = input.duration != null;
    const id = intervalId(nowMs);

    const row: Record<string, unknown> = {
      mode: input.mode,
      start,
      offset,
      lastUpdated: nowSec,
    };
    if (hasDuration) {
      row.duration = input.duration;
      row.end_offset = offset;
    }
    if (input.notes) row.notes = input.notes;

    const lastField = ACTIVITY_LAST_FIELD[input.mode];
    const parent = (await this.fs.getDoc(`activities/${cid}`)) as {
      prefs?: Record<string, { start?: number | null } | null | undefined>;
    } | null;
    const existingStart = parent?.prefs?.[lastField]?.start ?? null;

    const writes: PlannedWrite[] = [
      { op: "set", path: `activities/${cid}/intervals/${id}`, data: row },
    ];
    if (shouldUpdateLast(existingStart, start)) {
      const lastActivity: Record<string, unknown> = { start, offset };
      if (hasDuration) {
        lastActivity.duration = input.duration;
        lastActivity.end_offset = offset;
      }
      writes.push(
        this.prefUpdate(`activities/${cid}`, { [lastField]: lastActivity }, nowSec),
      );
    }
    return this.runPlan(
      { description: `Log activity (${input.mode}) for child ${cid}`, writes },
      id,
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Completed-event logs for the timer-based trackers (sleep / nursing) and
  // solids. These write a finished interval directly, without the live timer.
  // -------------------------------------------------------------------------

  /**
   * Log a completed sleep interval (no live timer): writes a row to
   * `sleep/{cid}/intervals` and updates `prefs.lastSleep` unless newer. `start`
   * and `duration` are stored as integers, matching the app.
   */
  async logSleep(
    cid: string,
    input: LogSleepInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const startSec = Math.trunc(toSeconds(input.start));
    const endSec = Math.trunc(toSeconds(input.end));
    if (endSec < startSec) {
      throw new InvalidInputError("end must be at or after start.");
    }
    const durationSec = endSec - startSec;
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();
    const id = hexId(16); // sleep intervals use a 16-hex id (no timestamp prefix)

    const row: Record<string, unknown> = {
      start: int(startSec),
      duration: int(durationSec),
      offset,
      end_offset: offset,
      lastUpdated: nowSec,
    };
    if (input.details) row.details = input.details;

    const existingStart = (await this.getSleep(cid))?.prefs?.lastSleep?.start ?? null;
    const writes: PlannedWrite[] = [
      { op: "set", path: `sleep/${cid}/intervals/${id}`, data: row },
    ];
    if (shouldUpdateLast(existingStart, startSec)) {
      writes.push(
        this.prefUpdate(
          `sleep/${cid}`,
          { lastSleep: { start: int(startSec), duration: int(durationSec), offset } },
          nowSec,
        ),
      );
    }
    return this.runPlan(
      { description: `Log sleep for child ${cid}`, writes },
      id,
      opts,
    );
  }

  /**
   * Log a completed nursing session (no live timer): writes a row to
   * `feed/{cid}/intervals` and updates `prefs.lastNursing` + `prefs.lastSide`
   * unless newer. With no per-side durations, the whole span is attributed to
   * `side`; otherwise provide both `leftDuration` and `rightDuration`.
   */
  async logNursing(
    cid: string,
    input: LogNursingInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const start = toSeconds(input.start);
    const end = toSeconds(input.end);
    if (end < start) {
      throw new InvalidInputError("end must be at or after start.");
    }
    const side = input.side ?? "left";
    const leftGiven = input.leftDuration != null;
    const rightGiven = input.rightDuration != null;
    if (leftGiven !== rightGiven) {
      throw new InvalidInputError(
        "Provide both leftDuration and rightDuration together.",
      );
    }
    let left: number;
    let right: number;
    let total: number;
    if (!leftGiven && !rightGiven) {
      total = end - start;
      left = side === "left" ? total : 0;
      right = side === "right" ? total : 0;
    } else {
      left = input.leftDuration as number;
      right = input.rightDuration as number;
      if (left < 0 || right < 0) {
        throw new InvalidInputError(
          "leftDuration and rightDuration must be non-negative.",
        );
      }
      total = left + right;
    }
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();
    const id = intervalId(nowMs);

    const row = {
      mode: "breast",
      start,
      lastSide: side,
      lastUpdated: nowSec,
      leftDuration: left,
      rightDuration: right,
      offset,
      end_offset: offset,
    };
    const existingStart =
      (await this.getFeed(cid))?.prefs?.lastNursing?.start ?? null;

    const writes: PlannedWrite[] = [
      { op: "set", path: `feed/${cid}/intervals/${id}`, data: row },
    ];
    if (shouldUpdateLast(existingStart, start)) {
      writes.push(
        this.prefUpdate(
          `feed/${cid}`,
          {
            lastNursing: {
              mode: "breast",
              start,
              duration: total,
              leftDuration: left,
              rightDuration: right,
              offset,
            },
            lastSide: { start, lastSide: side },
          },
          nowSec,
        ),
      );
    }
    return this.runPlan(
      { description: `Log nursing for child ${cid}`, writes },
      id,
      opts,
    );
  }

  /**
   * Log a solid-food meal: writes a row to `feed/{cid}/intervals` (keyed by
   * each food's id) and updates `prefs.lastSolid` unless newer.
   */
  async logSolids(
    cid: string,
    input: LogSolidsInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    if (!input?.foods?.length) {
      throw new InvalidInputError("At least one food is required.");
    }
    const start = toSeconds(input.start ?? new Date());
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();
    const id = intervalId(nowMs);

    const foods: Record<string, unknown> = {};
    for (const f of input.foods) {
      const name = (f.name ?? "").trim();
      if (!name) throw new InvalidInputError("Food name must be non-empty.");
      foods[f.id] = {
        id: f.id,
        source: f.source,
        created_name: name,
        amount: f.amount,
      };
    }

    const row: Record<string, unknown> = {
      mode: "solids",
      start,
      lastUpdated: nowSec,
      offset,
      foods,
    };
    if (input.notes) row.notes = input.notes;
    if (input.reaction) row.reactions = { [input.reaction]: true };
    if (input.foodNoteImage) row.foodNoteImage = input.foodNoteImage;

    const existingStart = (await this.getFeed(cid))?.prefs?.lastSolid?.start ?? null;
    const writes: PlannedWrite[] = [
      { op: "set", path: `feed/${cid}/intervals/${id}`, data: row },
    ];
    if (shouldUpdateLast(existingStart, start)) {
      const lastSolid: Record<string, unknown> = {
        mode: "solids",
        start,
        foods,
        offset,
      };
      if (input.reaction) lastSolid.reactions = { [input.reaction]: true };
      if (input.notes) lastSolid.notes = input.notes;
      writes.push(this.prefUpdate(`feed/${cid}`, { lastSolid }, nowSec));
    }
    const n = input.foods.length;
    return this.runPlan(
      { description: `Log solids (${n} food${n === 1 ? "" : "s"}) for child ${cid}`, writes },
      id,
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Solids food catalog
  // -------------------------------------------------------------------------

  /**
   * Fetch the curated solids food database from Firebase Storage.
   * Returns all curated foods sorted by rank (ascending, nulls last) then name.
   */
  async listSolidsCuratedFoods(): Promise<FirebaseCuratedFoodDocument[]> {
    const payload = (await this.fs.storageGet(
      CURATED_FOODS_BUCKET,
      CURATED_FOODS_OBJECT,
    )) as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new InvalidInputError("Unexpected curated foods payload shape from Storage.");
    }
    const foods: FirebaseCuratedFoodDocument[] = [];
    for (const entry of Object.values(payload)) {
      if (!entry || typeof entry !== "object") continue;
      foods.push(entry as FirebaseCuratedFoodDocument);
    }
    return foods.sort((a, b) => {
      const ra = a.rank ?? Infinity;
      const rb = b.rank ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }

  /**
   * List custom solids foods from `types/{cid}/custom`. Archived entries are
   * excluded by default; pass `{ includeArchived: true }` to include them.
   * Returns results sorted by `updated_at` descending (newest first).
   */
  async listSolidsCustomFoods(
    cid: string,
    opts?: { includeArchived?: boolean },
  ): Promise<FirebaseCustomFoodTypeDocument[]> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const q = {
      from: [{ collectionId: "custom" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "type" },
          op: "EQUAL",
          value: { stringValue: "solids" },
        },
      },
    };
    const raw = await this.fs.runQuery(`types/${cid}`, q);
    let items = raw as unknown as FirebaseCustomFoodTypeDocument[];
    if (!opts?.includeArchived) {
      items = items.filter((item) => !item.archived);
    }
    return items.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
  }

  /**
   * Create a custom solids food in `types/{cid}/custom/{foodId}`. Also ensures
   * `types/{cid}.available_types.solids = true`. Returns the created document.
   */
  async createSolidsCustomFood(
    cid: string,
    name: string,
    image?: string,
  ): Promise<FirebaseCustomFoodTypeDocument> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const foodName = (name ?? "").trim();
    if (!foodName) throw new InvalidInputError("Custom food name must be non-empty.");
    const foodId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const doc: FirebaseCustomFoodTypeDocument = {
      created_at: nowIso,
      updated_at: nowIso,
      name: foodName,
      archived: false,
      id: foodId,
      type: "solids",
      image: image ?? "",
      source: "custom",
    };
    await this.fs.updateFields(`types/${cid}`, { "available_types.solids": true });
    await this.fs.setDoc(`types/${cid}/custom/${foodId}`, doc as unknown as Record<string, unknown>);
    return doc;
  }

  /**
   * Toggle the `archived` flag on a custom solids food (the only reversible
   * soft-delete in the model). Also stamps `updated_at` with the current time.
   */
  async setCustomFoodArchived(
    cid: string,
    foodId: string,
    archived: boolean,
  ): Promise<void> {
    if (!cid) throw new InvalidInputError("cid is required.");
    if (!foodId) throw new InvalidInputError("foodId is required.");
    const nowIso = new Date().toISOString();
    await this.fs.updateFields(`types/${cid}/custom/${foodId}`, {
      archived,
      updated_at: nowIso,
    });
  }

  // -------------------------------------------------------------------------
  // Sleep timer state machine
  // -------------------------------------------------------------------------

  /**
   * Start a live sleep timer. Merge-sets the `timer` field on `sleep/{cid}`.
   * No pre-read: always activates a fresh session. Pass `dryRun: true` to
   * preview the write without committing.
   */
  async startSleep(
    cid: string,
    input?: StartSleepInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const uuid = hexId(16);
    const timer: Record<string, unknown> = {
      active: true,
      paused: false,
      timestamp: { seconds: nowSec },
      local_timestamp: nowSec,
      timerStartTime: nowMs, // MILLISECONDS for sleep
      uuid,
    };
    if (input?.details) timer.details = input.details;
    const plan: WritePlan = {
      description: `Start sleep timer for child ${cid}`,
      writes: [{ op: "update", path: `sleep/${cid}`, data: { timer } }],
    };
    return this.runPlan(plan, undefined, opts);
  }

  /**
   * Pause the live sleep timer. Reads current state first; throws
   * `InvalidInputError` if the timer is inactive or already paused.
   */
  async pauseSleep(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const current = await this.getSleep(cid);
    const timer = current?.timer;
    if (!timer?.active) throw new InvalidInputError("Sleep timer is not active.");
    if (timer.paused) throw new InvalidInputError("Sleep timer is already paused.");
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const plan: WritePlan = {
      description: `Pause sleep timer for child ${cid}`,
      writes: [
        {
          op: "update",
          path: `sleep/${cid}`,
          data: {
            "timer.paused": true,
            "timer.active": true,
            "timer.timerEndTime": nowMs, // MILLISECONDS
            "timer.timestamp": { seconds: nowSec },
            "timer.local_timestamp": nowSec,
          },
        },
      ],
    };
    return this.runPlan(plan, undefined, opts);
  }

  /**
   * Resume a paused sleep timer. Throws if inactive or not paused.
   * Does **not** reset `timerStartTime` — the original start is preserved.
   */
  async resumeSleep(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const current = await this.getSleep(cid);
    const timer = current?.timer;
    if (!timer?.active) throw new InvalidInputError("Sleep timer is not active.");
    if (!timer.paused) throw new InvalidInputError("Sleep timer is not paused.");
    const nowSec = Date.now() / 1000;
    const plan: WritePlan = {
      description: `Resume sleep timer for child ${cid}`,
      writes: [
        {
          op: "update",
          path: `sleep/${cid}`,
          data: {
            "timer.paused": false,
            "timer.active": true,
            "timer.timestamp": { seconds: nowSec },
            "timer.local_timestamp": nowSec,
          },
        },
      ],
    };
    return this.runPlan(plan, undefined, opts);
  }

  /**
   * Cancel the sleep timer without logging an interval. Replaces the whole
   * `timer` map with an inactive state (preserving the session uuid).
   */
  async cancelSleep(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const current = await this.getSleep(cid);
    const timerUuid = current?.timer?.uuid ?? hexId(16);
    const nowSec = Date.now() / 1000;
    // Replace the whole `timer` map — omitting timerStartTime/timerEndTime/details
    // removes them from the document (Firestore replaces the map entirely).
    const plan: WritePlan = {
      description: `Cancel sleep timer for child ${cid}`,
      writes: [
        {
          op: "update",
          path: `sleep/${cid}`,
          data: {
            timer: {
              active: false,
              paused: false,
              timestamp: { seconds: nowSec },
              uuid: timerUuid,
              local_timestamp: nowSec,
            },
          },
        },
      ],
    };
    return this.runPlan(plan, undefined, opts);
  }

  /**
   * Complete the live sleep timer: computes the duration, writes a 16-hex
   * interval row, then resets the timer and updates `prefs.lastSleep`.
   * If `timerStartTime` is missing, clears the timer field and returns without
   * writing an interval.
   */
  async completeSleep(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const current = await this.getSleep(cid);
    const timer = current?.timer;
    if (!timer?.active) throw new InvalidInputError("Sleep timer is not active.");

    const timerStartMs = timer.timerStartTime;
    if (!timerStartMs) {
      // No start time; clear the timer field entirely (matches Python fallback).
      const plan: WritePlan = {
        description: `Complete sleep (missing timerStartTime) — clear timer for child ${cid}`,
        writes: [
          { op: "update", path: `sleep/${cid}`, data: { timer: DELETE_FIELD } },
        ],
      };
      return this.runPlan(plan, undefined, opts);
    }

    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();
    const timerUuid = timer.uuid;
    const id = hexId(16); // sleep intervals use a 16-hex id (no timestamp prefix)

    // If paused use timerEndTime as end; otherwise use now.
    const endMs =
      timer.paused && timer.timerEndTime != null ? timer.timerEndTime : nowMs;
    const startSec = Math.trunc(timerStartMs / 1000);
    const durationSec = Math.trunc((endMs - timerStartMs) / 1000);

    const row: Record<string, unknown> = {
      start: int(startSec),
      duration: int(durationSec),
      offset,
      end_offset: offset,
      lastUpdated: nowSec,
    };
    if (timer.details) row.details = timer.details;

    const existingStart = current?.prefs?.lastSleep?.start ?? null;

    const timerUpdate: Record<string, unknown> = {
      timer: {
        active: false,
        paused: false,
        timestamp: { seconds: nowSec },
        uuid: timerUuid,
        local_timestamp: nowSec,
        // timerStartTime/timerEndTime/details omitted → removed from Firestore
      },
    };
    if (shouldUpdateLast(existingStart, startSec)) {
      Object.assign(timerUpdate, {
        "prefs.lastSleep": { start: int(startSec), duration: int(durationSec), offset },
        "prefs.timestamp": { seconds: nowSec },
        "prefs.local_timestamp": nowSec,
      });
    }

    const plan: WritePlan = {
      description: `Complete sleep timer for child ${cid}`,
      writes: [
        { op: "set", path: `sleep/${cid}/intervals/${id}`, data: row },
        { op: "update", path: `sleep/${cid}`, data: timerUpdate },
      ],
    };
    return this.runPlan(plan, id, opts);
  }

  // -------------------------------------------------------------------------
  // Nursing timer state machine
  // -------------------------------------------------------------------------

  /**
   * Start a live nursing timer. Merge-sets the `timer` field on `feed/{cid}`.
   * Both `feedStartTime` and `timerStartTime` are set to now in **seconds**.
   */
  async startNursing(
    cid: string,
    input?: StartNursingInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const side = input?.side ?? "left";
    const nowSec = Date.now() / 1000;
    const uuid = hexId(16);
    const plan: WritePlan = {
      description: `Start nursing timer (${side}) for child ${cid}`,
      writes: [
        {
          op: "update",
          path: `feed/${cid}`,
          data: {
            timer: {
              active: true,
              paused: false,
              timestamp: { seconds: nowSec },
              local_timestamp: nowSec,
              feedStartTime: nowSec, // SECONDS for nursing
              timerStartTime: nowSec, // SECONDS for nursing
              uuid,
              leftDuration: 0,
              rightDuration: 0,
              lastSide: "left",
              activeSide: side,
            },
          },
        },
      ],
    };
    return this.runPlan(plan, undefined, opts);
  }

  /**
   * Pause the nursing timer: banks elapsed seconds into the active side's
   * duration, sets `activeSide` to DELETE_FIELD. Throws if inactive or paused.
   */
  async pauseNursing(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const current = await this.getFeed(cid);
    const timer = current?.timer;
    if (!timer?.active) throw new InvalidInputError("Nursing timer is not active.");
    if (timer.paused) throw new InvalidInputError("Nursing timer is already paused.");

    const nowSec = Date.now() / 1000;
    const timerStart = timer.timerStartTime ?? nowSec;
    const elapsed = nowSec - timerStart;
    const currentSide = timer.activeSide ?? timer.lastSide ?? "left";
    let left = timer.leftDuration ?? 0;
    let right = timer.rightDuration ?? 0;
    if (currentSide === "left") left += elapsed;
    else right += elapsed;

    const plan: WritePlan = {
      description: `Pause nursing timer for child ${cid}`,
      writes: [
        {
          op: "update",
          path: `feed/${cid}`,
          data: {
            "timer.paused": true,
            "timer.active": true,
            "timer.timestamp": { seconds: nowSec },
            "timer.local_timestamp": nowSec,
            "timer.leftDuration": left,
            "timer.rightDuration": right,
            "timer.lastSide": currentSide,
            "timer.activeSide": DELETE_FIELD,
          },
        },
      ],
    };
    return this.runPlan(plan, undefined, opts);
  }

  /**
   * Resume the nursing timer: resets `timerStartTime` to now, sets `activeSide`
   * to the provided side (or falls back to stored `lastSide`). Throws if
   * inactive or not paused.
   */
  async resumeNursing(
    cid: string,
    input?: ResumeNursingInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const current = await this.getFeed(cid);
    const timer = current?.timer;
    if (!timer?.active) throw new InvalidInputError("Nursing timer is not active.");
    if (!timer.paused) throw new InvalidInputError("Nursing timer is not paused.");
    const side = input?.side ?? timer.lastSide ?? "left";
    const nowSec = Date.now() / 1000;
    const plan: WritePlan = {
      description: `Resume nursing timer (${side}) for child ${cid}`,
      writes: [
        {
          op: "update",
          path: `feed/${cid}`,
          data: {
            "timer.paused": false,
            "timer.active": true,
            "timer.timestamp": { seconds: nowSec },
            "timer.local_timestamp": nowSec,
            "timer.timerStartTime": nowSec, // SECONDS, reset on resume
            "timer.activeSide": side,
            "timer.lastSide": "none",
          },
        },
      ],
    };
    return this.runPlan(plan, undefined, opts);
  }

  /**
   * Switch the active nursing side: banks elapsed time on the current side (if
   * not paused), flips to the opposite side, and resets `timerStartTime`.
   */
  async switchNursingSide(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const current = await this.getFeed(cid);
    const timer = current?.timer;
    if (!timer?.active) throw new InvalidInputError("Nursing timer is not active.");

    const nowSec = Date.now() / 1000;
    const currentSide = timer.activeSide ?? timer.lastSide ?? "left";
    const newSide: FeedSide = currentSide === "left" ? "right" : "left";
    let left = timer.leftDuration ?? 0;
    let right = timer.rightDuration ?? 0;

    if (!timer.paused) {
      const timerStart = timer.timerStartTime ?? nowSec;
      const elapsed = nowSec - timerStart;
      if (currentSide === "left") left += elapsed;
      else right += elapsed;
    }

    const plan: WritePlan = {
      description: `Switch nursing side (→ ${newSide}) for child ${cid}`,
      writes: [
        {
          op: "update",
          path: `feed/${cid}`,
          data: {
            "timer.paused": false,
            "timer.lastSide": "none",
            "timer.timestamp": { seconds: nowSec },
            "timer.local_timestamp": nowSec,
            "timer.timerStartTime": nowSec, // SECONDS
            "timer.activeSide": newSide,
            "timer.leftDuration": left,
            "timer.rightDuration": right,
          },
        },
      ],
    };
    return this.runPlan(plan, undefined, opts);
  }

  /**
   * Cancel the nursing timer without logging an interval. Replaces the whole
   * `timer` map with an inactive state (preserving uuid, resetting durations).
   */
  async cancelNursing(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const current = await this.getFeed(cid);
    const timerUuid = current?.timer?.uuid ?? hexId(16);
    const nowSec = Date.now() / 1000;
    const plan: WritePlan = {
      description: `Cancel nursing timer for child ${cid}`,
      writes: [
        {
          op: "update",
          path: `feed/${cid}`,
          data: {
            timer: {
              active: false,
              paused: false,
              timestamp: { seconds: nowSec },
              uuid: timerUuid,
              local_timestamp: nowSec,
              leftDuration: 0,
              rightDuration: 0,
              lastSide: "left",
              // feedStartTime/timerStartTime/activeSide omitted → removed from Firestore
            },
          },
        },
      ],
    };
    return this.runPlan(plan, undefined, opts);
  }

  /**
   * Complete the nursing timer: banks remaining elapsed time, writes an interval
   * row (`intervalId()` format), then clears `leftDuration`/`rightDuration`/
   * `activeSide` via `DELETE_FIELD` and updates `prefs.lastNursing`/`lastSide`.
   * Throws if inactive or if no `timerStartTime` is set.
   */
  async completeNursing(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    if (!cid) throw new InvalidInputError("cid is required.");
    const current = await this.getFeed(cid);
    const timer = current?.timer;
    if (!timer?.active) throw new InvalidInputError("Nursing timer is not active.");
    const timerStart = timer.timerStartTime;
    if (!timerStart) throw new InvalidInputError("Nursing timer has no start time.");

    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const offset = await this.offsetMinutes();

    let left = timer.leftDuration ?? 0;
    let right = timer.rightDuration ?? 0;

    if (!timer.paused) {
      const elapsed = nowSec - timerStart;
      const currentSide = timer.activeSide ?? timer.lastSide ?? "left";
      if (currentSide === "left") left += elapsed;
      else right += elapsed;
    }

    const total = left + right;
    const feedStart = timer.feedStartTime ?? timerStart;

    let lastSide = (timer.activeSide ?? timer.lastSide ?? "right") as FeedSide;
    if (lastSide === "none") lastSide = right >= left ? "right" : "left";

    const id = intervalId(nowMs);

    const row: Record<string, unknown> = {
      mode: "breast",
      start: feedStart,
      lastSide,
      lastUpdated: nowSec,
      leftDuration: left,
      rightDuration: right,
      offset,
      end_offset: offset,
    };

    const existingStart = current?.prefs?.lastNursing?.start ?? null;

    const timerUpdate: Record<string, unknown> = {
      "timer.active": false,
      "timer.paused": true, // stays paused=true after completion
      "timer.timestamp": { seconds: nowSec },
      "timer.local_timestamp": nowSec,
      "timer.lastSide": lastSide,
      "timer.leftDuration": DELETE_FIELD,
      "timer.rightDuration": DELETE_FIELD,
      "timer.activeSide": DELETE_FIELD,
    };

    if (shouldUpdateLast(existingStart, feedStart)) {
      timerUpdate["prefs.lastNursing"] = {
        mode: "breast",
        start: feedStart,
        duration: total,
        leftDuration: left,
        rightDuration: right,
        offset,
      };
      timerUpdate["prefs.lastSide"] = { start: feedStart, lastSide };
      timerUpdate["prefs.timestamp"] = { seconds: nowSec };
      timerUpdate["prefs.local_timestamp"] = nowSec;
    }

    const plan: WritePlan = {
      description: `Complete nursing timer for child ${cid}`,
      writes: [
        { op: "set", path: `feed/${cid}/intervals/${id}`, data: row },
        { op: "update", path: `feed/${cid}`, data: timerUpdate },
      ],
    };
    return this.runPlan(plan, id, opts);
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
