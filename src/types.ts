/**
 * TypeScript types for Huckleberry Firebase payloads.
 *
 * Ported (read-relevant subset) from the Python client's `firebase_types.py`,
 * which remains the canonical schema reference. Field names match Firestore
 * exactly. All `start`/`duration` values are in **seconds**; `offset` is the
 * timezone offset in minutes; `timerStartTime` units differ per tracker (see
 * notes below).
 *
 * Write-only models (timers used for mutations, medication/temperature, etc.)
 * are intentionally omitted in v1 — see `docs/write-roadmap.md`.
 */

/**
 * A time range for interval queries. `start`/`end` may be `Date` objects or
 * epoch values (seconds). Used by the namespaced API (`client.sleep.list`, …).
 */
export interface DateRange {
  start: Date | number;
  end: Date | number;
}

export type DiaperMode = "pee" | "poo" | "both" | "dry";
export type PooColor = "yellow" | "brown" | "black" | "green" | "red" | "gray";
export type PooConsistency =
  | "solid"
  | "loose"
  | "runny"
  | "mucousy"
  | "hard"
  | "pebbles"
  | "diarrhea";
export type FeedMode = "breast" | "bottle" | "solids";
export type FeedSide = "left" | "right" | "none";
export type SolidsReaction = "LOVED" | "MEH" | "HATED" | "ALLERGIC";
export type SolidsFoodSource = "custom" | "curated";
export type BottleType =
  | "Breast Milk"
  | "Formula"
  | "Tube Feeding"
  | "Cow Milk"
  | "Goat Milk"
  | "Soy Milk"
  | "Other";
export type VolumeUnits = "ml" | "oz";
export type WeightUnits = "kg" | "lbs.oz";
export type HeightUnits = "cm" | "ft.in";
export type HeadUnits = "hcm" | "hin";
export type PumpEntryMode = "leftright" | "total";
export type PottyResult = "satButDry" | "wentPotty" | "accident";
export type GenderType = "M" | "F" | "";
export type ActivityMode =
  | "bath"
  | "tummyTime"
  | "storyTime"
  | "screenTime"
  | "skinToSkin"
  | "outdoorPlay"
  | "indoorPlay"
  | "brushTeeth";

// ---------------------------------------------------------------------------
// users/{uid} and childs/{cid}
// ---------------------------------------------------------------------------

export interface FirebaseUserChildRef {
  cid: string;
  nickname?: string | null;
  picture?: string | null;
  color?: string | null;
}

export interface FirebaseUserDocument {
  email?: string | null;
  firstname?: string | null;
  lastname?: string | null;
  childList: FirebaseUserChildRef[];
  lastChild?: string | null;
  latestTimezone?: string | null;
}

export interface FirebaseChildDocument {
  /** Display name (fallback is users/{uid}.childList[].nickname). */
  childsName?: string | null;
  birthdate?: string | number | null;
  createdAt?: number | null;
  gender?: GenderType | null;
  picture?: string | null;
  color?: string | null;
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

export interface FirebaseTimestamp {
  seconds: number;
  nanos?: number | null;
}

// ---------------------------------------------------------------------------
// sleep/{cid}
// ---------------------------------------------------------------------------

export interface FirebaseLastSleepData {
  start?: number | null;
  duration?: number | null;
  offset?: number | null;
}

/** `timerStartTime` is **milliseconds** for sleep timers (unlike feed/seconds). */
export interface FirebaseSleepTimerData {
  active: boolean;
  paused: boolean;
  timerStartTime?: number | null;
  timerEndTime?: number | null;
  uuid: string;
}

export interface FirebaseSleepPrefs {
  lastSleep?: FirebaseLastSleepData | null;
}

export interface FirebaseSleepDocumentData {
  timer?: FirebaseSleepTimerData | null;
  prefs?: FirebaseSleepPrefs | null;
}

export interface FirebaseSleepIntervalData {
  _id?: string | null;
  start: number;
  duration: number;
  offset: number;
  end_offset?: number | null;
  lastUpdated?: number | null;
}

// ---------------------------------------------------------------------------
// feed/{cid}
// ---------------------------------------------------------------------------

export interface FirebaseLastNursingData {
  mode?: "breast";
  start?: number | null;
  duration?: number | null;
  leftDuration?: number | null;
  rightDuration?: number | null;
  offset?: number | null;
}

export interface FirebaseLastBottleData {
  mode?: "bottle";
  start?: number | null;
  bottleType?: BottleType | null;
  bottleAmount?: number | null;
  bottleUnits?: VolumeUnits | null;
  offset?: number | null;
}

export interface SolidsFoodEntry {
  id: string;
  created_name: string;
  source: SolidsFoodSource;
  amount?: string | number | null;
}

export interface FirebaseLastSolidData {
  mode?: "solids";
  start?: number | null;
  foods?: Record<string, SolidsFoodEntry> | null;
  reactions?: Partial<Record<SolidsReaction, boolean>> | null;
  notes?: string | null;
  offset?: number | null;
}

/** `feedStartTime`/`timerStartTime` are **seconds** for feed timers. */
export interface FirebaseFeedTimerData {
  active: boolean;
  paused: boolean;
  feedStartTime?: number | null;
  timerStartTime?: number | null;
  uuid: string;
  leftDuration?: number | null;
  rightDuration?: number | null;
  lastSide?: FeedSide | null;
  activeSide?: FeedSide | null;
}

export interface FirebaseFeedPrefs {
  lastBottle?: FirebaseLastBottleData | null;
  lastNursing?: FirebaseLastNursingData | null;
  lastSolid?: FirebaseLastSolidData | null;
}

export interface FirebaseFeedDocumentData {
  timer?: FirebaseFeedTimerData | null;
  prefs?: FirebaseFeedPrefs | null;
}

export interface FirebaseBreastFeedIntervalData {
  mode: "breast";
  start: number;
  lastSide: FeedSide;
  leftDuration?: number | null;
  rightDuration?: number | null;
  offset: number;
  notes?: string | null;
}

export interface FirebaseBottleFeedIntervalData {
  mode: "bottle";
  start: number;
  bottleType: BottleType;
  amount: number;
  units: VolumeUnits;
  offset: number;
  notes?: string | null;
}

export interface FirebaseSolidsFeedIntervalData {
  mode: "solids";
  start: number;
  offset: number;
  foods?: Record<string, SolidsFoodEntry> | null;
  reactions?: Partial<Record<SolidsReaction, boolean>> | null;
  notes?: string | null;
}

export type FirebaseFeedIntervalData =
  | FirebaseBreastFeedIntervalData
  | FirebaseBottleFeedIntervalData
  | FirebaseSolidsFeedIntervalData;

// ---------------------------------------------------------------------------
// diaper/{cid}
// ---------------------------------------------------------------------------

export interface FirebaseDiaperQuantity {
  pee?: number | null;
  poo?: number | null;
}

export interface FirebaseDiaperData {
  mode: DiaperMode;
  start: number;
  offset: number;
  lastUpdated?: number | null;
  quantity?: FirebaseDiaperQuantity | null;
  color?: PooColor | null;
  consistency?: PooConsistency | null;
  diaperRash?: boolean | null;
  notes?: string | null;
  isPotty?: boolean | null;
  howItHappened?: PottyResult | null;
}

export interface FirebaseLastDiaperData {
  start?: number | null;
  mode?: DiaperMode | null;
  offset?: number | null;
}

export interface FirebaseDiaperPrefs {
  lastDiaper?: FirebaseLastDiaperData | null;
  lastPotty?: FirebaseLastDiaperData | null;
}

export interface FirebaseDiaperDocumentData {
  prefs?: FirebaseDiaperPrefs | null;
}

// ---------------------------------------------------------------------------
// health/{cid} (growth)
// ---------------------------------------------------------------------------

export interface FirebaseGrowthData {
  _id?: string | null;
  mode: "growth";
  start: number;
  offset: number;
  weight?: number | null;
  weightUnits?: WeightUnits | null;
  height?: number | null;
  heightUnits?: HeightUnits | null;
  head?: number | null;
  headUnits?: HeadUnits | null;
}

export interface FirebaseHealthPrefs {
  lastGrowthEntry?: FirebaseGrowthData | null;
}

export interface FirebaseHealthDocumentData {
  prefs?: FirebaseHealthPrefs | null;
}

// ---------------------------------------------------------------------------
// pump/{cid}
// ---------------------------------------------------------------------------

export interface FirebaseLastPumpData {
  start?: number | null;
  duration?: number | null;
  entryMode?: PumpEntryMode | null;
  leftAmount?: number | null;
  rightAmount?: number | null;
  units?: VolumeUnits | null;
  offset?: number | null;
}

export interface FirebasePumpPrefs {
  lastPump?: FirebaseLastPumpData | null;
}

export interface FirebasePumpDocumentData {
  prefs?: FirebasePumpPrefs | null;
}

export interface FirebasePumpIntervalData {
  start: number;
  entryMode: PumpEntryMode;
  leftAmount?: number | null;
  rightAmount?: number | null;
  units: VolumeUnits;
  offset: number;
  duration?: number | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// activities/{cid}
// ---------------------------------------------------------------------------

export interface FirebaseLastActivityData {
  start?: number | null;
  offset?: number | null;
  duration?: number | null;
  end_offset?: number | null;
}

export interface FirebaseActivityIntervalData {
  mode: ActivityMode;
  start: number;
  offset: number;
  duration?: number | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// types/{cid} — solids food catalog
// ---------------------------------------------------------------------------

export interface FirebaseTypesAvailableTypes {
  solids?: boolean | null;
}

export interface FirebaseTypesDocument {
  available_types?: FirebaseTypesAvailableTypes | null;
}

/** types/{cid}/custom/{food_id} — a user-created solids food. */
export interface FirebaseCustomFoodTypeDocument {
  created_at: string;
  updated_at: string;
  name: string;
  archived: boolean;
  id: string;
  type: "solids";
  image: string;
  source: "custom";
}

/** Curated food entry from Firebase Storage `foods/fooddb.json`. */
export interface FirebaseCuratedFoodDocument {
  id: string;
  name: string;
  source: "curated";
  aka?: string[] | null;
  is_common_allergen?: boolean | null;
  is_high_choking_hazard?: boolean | null;
  recommended_age_to_start?: number | null;
  category?: Record<string, boolean> | null;
  link_key?: string | null;
  rank?: number | null;
  image?: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard rollup (library-computed, not a Firestore document)
// ---------------------------------------------------------------------------

export interface LastEvent {
  /** Epoch seconds when the event started. */
  start: number;
  /** Optional duration in seconds (sleep, nursing, pump, activity). */
  duration?: number | null;
}

export interface DashboardSummary {
  child: { cid: string; name: string | null };
  /** True if a sleep timer is currently running and not paused. */
  sleepInProgress: boolean;
  /** True if a nursing timer is currently running and not paused. */
  feedInProgress: boolean;
  lastSleep: (LastEvent & { offset?: number | null }) | null;
  lastFeed:
    | (LastEvent & {
        kind: "nursing" | "bottle" | "solids";
        detail?: string | null;
      })
    | null;
  lastDiaper: (LastEvent & { mode: DiaperMode | null }) | null;
  lastPump: LastEvent | null;
  lastGrowth: FirebaseGrowthData | null;
  /** Epoch milliseconds when this summary was assembled. */
  generatedAt: number;
}
