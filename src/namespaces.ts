/**
 * Namespaced API facades.
 *
 * These group the client's flat methods into resource objects so reads read
 * naturally — `client.sleep.list(cid, range)` instead of
 * `client.listSleepIntervals(cid, start, end)`. Each facade is a thin delegate
 * over the existing methods on {@link HuckleberryClient}; the flat methods stay
 * first-class, so this layer is purely additive.
 *
 * List methods take a {@link DateRange} (`{ start, end }`, `Date` or epoch
 * seconds) and validate it, throwing {@link InvalidDateRangeError} on bad input
 * so callers (and the MCP layer) get a structured, actionable error.
 */

import type {
  HuckleberryClient,
  LogActivityInput,
  LogBottleInput,
  LogDiaperInput,
  LogGrowthInput,
  LogNursingInput,
  LogPottyInput,
  LogPumpInput,
  LogSleepInput,
  LogSolidsInput,
  ResumeNursingInput,
  StartNursingInput,
  StartSleepInput,
} from "./client.js";
import { InvalidDateRangeError } from "./errors.js";
import type { WriteOptions, WriteResult } from "./write.js";
import type {
  DateRange,
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
  FirebaseUserChildRef,
  FirebaseUserDocument,
  DashboardSummary,
} from "./types.js";

function toSeconds(v: Date | number): number {
  return v instanceof Date ? v.getTime() / 1000 : v;
}

function isValidPoint(v: unknown): v is Date | number {
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate a {@link DateRange} and return its endpoints unchanged (still
 * `Date | number`, to defer the seconds conversion to the flat methods).
 */
export function validateRange(range: DateRange): {
  start: Date | number;
  end: Date | number;
} {
  if (!range || typeof range !== "object") {
    throw new InvalidDateRangeError("range must be an object { start, end }.");
  }
  const { start, end } = range;
  if (!isValidPoint(start) || !isValidPoint(end)) {
    throw new InvalidDateRangeError(
      "range.start and range.end must each be a Date or a finite epoch number.",
    );
  }
  if (toSeconds(start) >= toSeconds(end)) {
    throw new InvalidDateRangeError("range.start must be before range.end.");
  }
  return { start, end };
}

export class UserNamespace {
  constructor(private readonly c: HuckleberryClient) {}

  get(): Promise<FirebaseUserDocument | null> {
    return this.c.getUser();
  }

  getChild(cid: string): Promise<FirebaseChildDocument | null> {
    return this.c.getChild(cid);
  }

  /** The account's children (from `users/{uid}.childList`). */
  async listChildren(): Promise<FirebaseUserChildRef[]> {
    const user = await this.c.getUser();
    return user?.childList ?? [];
  }
}

export class SleepNamespace {
  constructor(private readonly c: HuckleberryClient) {}

  get(cid: string): Promise<FirebaseSleepDocumentData | null> {
    return this.c.getSleep(cid);
  }

  list(cid: string, range: DateRange): Promise<FirebaseSleepIntervalData[]> {
    const { start, end } = validateRange(range);
    return this.c.listSleepIntervals(cid, start, end);
  }

  /** Log a completed sleep interval (writes a row + updates `prefs.lastSleep`). */
  log(
    cid: string,
    input: LogSleepInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.c.logSleep(cid, input, opts);
  }

  /** Start the live sleep timer. */
  start(cid: string, input?: StartSleepInput, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.startSleep(cid, input, opts);
  }

  /** Pause the live sleep timer. */
  pause(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.pauseSleep(cid, opts);
  }

  /** Resume a paused sleep timer. */
  resume(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.resumeSleep(cid, opts);
  }

  /** Cancel the sleep timer without writing an interval. */
  cancel(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.cancelSleep(cid, opts);
  }

  /** Complete the sleep timer: write an interval row + reset timer. */
  complete(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.completeSleep(cid, opts);
  }
}

/** Solids food catalog accessors (`listCurated`, `listCustom`, `createCustom`, `setArchived`). */
export class SolidsFoodsNamespace {
  constructor(private readonly c: HuckleberryClient) {}

  /** Curated foods from Firebase Storage, sorted by rank then name. */
  listCurated(): Promise<FirebaseCuratedFoodDocument[]> {
    return this.c.listSolidsCuratedFoods();
  }

  /** Custom foods for a child. Archived excluded by default. Sorted by `updated_at` desc. */
  listCustom(
    cid: string,
    opts?: { includeArchived?: boolean },
  ): Promise<FirebaseCustomFoodTypeDocument[]> {
    return this.c.listSolidsCustomFoods(cid, opts);
  }

  /** Create a custom food and enable `available_types.solids` on the types doc. */
  createCustom(
    cid: string,
    name: string,
    image?: string,
  ): Promise<FirebaseCustomFoodTypeDocument> {
    return this.c.createSolidsCustomFood(cid, name, image);
  }

  /** Toggle the `archived` flag on a custom food (the only soft-delete in the model). */
  setArchived(cid: string, foodId: string, archived: boolean): Promise<void> {
    return this.c.setCustomFoodArchived(cid, foodId, archived);
  }
}

export class FeedNamespace {
  constructor(private readonly c: HuckleberryClient) {}

  private _foods?: SolidsFoodsNamespace;

  get(cid: string): Promise<FirebaseFeedDocumentData | null> {
    return this.c.getFeed(cid);
  }

  list(cid: string, range: DateRange): Promise<FirebaseFeedIntervalData[]> {
    const { start, end } = validateRange(range);
    return this.c.listFeedIntervals(cid, start, end);
  }

  /** Solids food catalog (`listCurated`, `listCustom`, `createCustom`, `setArchived`). */
  get foods(): SolidsFoodsNamespace {
    return (this._foods ??= new SolidsFoodsNamespace(this.c));
  }

  /** Log a bottle feed (writes a row + updates `prefs.lastBottle`). */
  logBottle(
    cid: string,
    input: LogBottleInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.c.logBottle(cid, input, opts);
  }

  /** Log a completed nursing session (writes a row + updates `prefs.lastNursing`/`lastSide`). */
  logNursing(
    cid: string,
    input: LogNursingInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.c.logNursing(cid, input, opts);
  }

  /** Log a solid-food meal (writes a row + updates `prefs.lastSolid`). */
  logSolids(
    cid: string,
    input: LogSolidsInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.c.logSolids(cid, input, opts);
  }

  /** Start the live nursing timer. */
  startNursing(cid: string, input?: StartNursingInput, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.startNursing(cid, input, opts);
  }

  /** Pause the nursing timer, banking elapsed time into the active side. */
  pauseNursing(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.pauseNursing(cid, opts);
  }

  /** Resume the nursing timer, resetting `timerStartTime` to now. */
  resumeNursing(cid: string, input?: ResumeNursingInput, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.resumeNursing(cid, input, opts);
  }

  /** Switch to the opposite nursing side, banking elapsed time first. */
  switchNursingSide(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.switchNursingSide(cid, opts);
  }

  /** Cancel the nursing timer without writing an interval. */
  cancelNursing(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.cancelNursing(cid, opts);
  }

  /** Complete the nursing timer: write an interval row + update prefs. */
  completeNursing(cid: string, opts?: WriteOptions): Promise<WriteResult> {
    return this.c.completeNursing(cid, opts);
  }
}

export class DiapersNamespace {
  constructor(private readonly c: HuckleberryClient) {}

  get(cid: string): Promise<FirebaseDiaperDocumentData | null> {
    return this.c.getDiaper(cid);
  }

  list(cid: string, range: DateRange): Promise<FirebaseDiaperData[]> {
    const { start, end } = validateRange(range);
    return this.c.listDiaperIntervals(cid, start, end);
  }

  /** Log a diaper change (writes a row + updates `prefs.lastDiaper`). */
  log(
    cid: string,
    input: LogDiaperInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.c.logDiaper(cid, input, opts);
  }

  /** Log a potty event (writes a row + updates `prefs.lastPotty`). */
  logPotty(
    cid: string,
    input: LogPottyInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.c.logPotty(cid, input, opts);
  }
}

export class PumpNamespace {
  constructor(private readonly c: HuckleberryClient) {}

  get(cid: string): Promise<FirebasePumpDocumentData | null> {
    return this.c.getPump(cid);
  }

  list(cid: string, range: DateRange): Promise<FirebasePumpIntervalData[]> {
    const { start, end } = validateRange(range);
    return this.c.listPumpIntervals(cid, start, end);
  }

  /** Log a pump session (writes a row + updates `prefs.lastPump`). */
  log(
    cid: string,
    input: LogPumpInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.c.logPump(cid, input, opts);
  }
}

export class HealthNamespace {
  constructor(private readonly c: HuckleberryClient) {}

  get(cid: string): Promise<FirebaseHealthDocumentData | null> {
    return this.c.getHealth(cid);
  }

  list(cid: string, range: DateRange): Promise<FirebaseGrowthData[]> {
    const { start, end } = validateRange(range);
    return this.c.listHealthIntervals(cid, start, end);
  }

  /** The most recent growth entry (weight/height/head), or null. */
  async getLatestGrowth(cid: string): Promise<FirebaseGrowthData | null> {
    const health = await this.c.getHealth(cid);
    return health?.prefs?.lastGrowthEntry ?? null;
  }

  /** Log a growth measurement (writes to `health/{cid}/data` + updates `prefs.lastGrowthEntry`). */
  logGrowth(
    cid: string,
    input: LogGrowthInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.c.logGrowth(cid, input, opts);
  }
}

export class ActivitiesNamespace {
  constructor(private readonly c: HuckleberryClient) {}

  list(cid: string, range: DateRange): Promise<FirebaseActivityIntervalData[]> {
    const { start, end } = validateRange(range);
    return this.c.listActivityIntervals(cid, start, end);
  }

  /** Log an activity (writes a row + updates the per-mode `prefs.last*`). */
  log(
    cid: string,
    input: LogActivityInput,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    return this.c.logActivity(cid, input, opts);
  }
}

export class DashboardNamespace {
  constructor(private readonly c: HuckleberryClient) {}

  summary(cid: string, childName: string | null = null): Promise<DashboardSummary> {
    return this.c.getDashboardSummary(cid, childName);
  }
}
