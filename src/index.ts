/**
 * huckleberry-js — read-only TypeScript client for the Huckleberry baby
 * tracking app's Firebase backend. Runs on Cloudflare Workers, Node 18+, and
 * browsers (uses global `fetch`, no Node-only dependencies).
 */

export { HuckleberryClient } from "./client.js";
export type {
  HuckleberryClientOptions,
  DiaperAmount,
  LogDiaperInput,
  LogPottyInput,
  LogBottleInput,
  LogGrowthInput,
  LogPumpInput,
  LogActivityInput,
} from "./client.js";

export {
  HuckleberryError,
  ChildNotFoundError,
  InvalidDateRangeError,
  InvalidInputError,
  ApiError,
} from "./errors.js";
export type {
  ErrorCategory,
  StructuredErrorJSON,
  HuckleberryErrorOptions,
} from "./errors.js";

export {
  UserNamespace,
  SleepNamespace,
  FeedNamespace,
  DiapersNamespace,
  PumpNamespace,
  HealthNamespace,
  ActivitiesNamespace,
  DashboardNamespace,
} from "./namespaces.js";

export { signIn, refresh, AuthError } from "./auth.js";
export type { Session } from "./auth.js";

export {
  FirestoreRest,
  FirestoreError,
  decodeValue,
  decodeFields,
  decodeDocument,
  encodeValue,
  encodeFields,
  int,
  IntValue,
  DELETE_FIELD,
  buildStartRangeQuery,
  buildMultiQuery,
  listIntervals,
} from "./firestore.js";
export type {
  FetchLike,
  FirestoreValue,
  FirestoreDocument,
  TokenProvider,
  FieldUpdates,
} from "./firestore.js";

export {
  hexId,
  intervalId,
  sessionUuid,
  tzOffsetMinutes,
  shouldUpdateLast,
} from "./write.js";
export type {
  PlannedWrite,
  WritePlan,
  WriteResult,
  WriteOptions,
} from "./write.js";

export {
  FIREBASE_API_KEY,
  FIREBASE_PROJECT_ID,
  FIREBASE_APP_ID,
} from "./const.js";

export * from "./types.js";
