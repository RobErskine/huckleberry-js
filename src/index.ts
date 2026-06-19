/**
 * huckleberry-js — read-only TypeScript client for the Huckleberry baby
 * tracking app's Firebase backend. Runs on Cloudflare Workers, Node 18+, and
 * browsers (uses global `fetch`, no Node-only dependencies).
 */

export { HuckleberryClient } from "./client.js";
export type { HuckleberryClientOptions } from "./client.js";

export { signIn, refresh, AuthError } from "./auth.js";
export type { Session } from "./auth.js";

export {
  FirestoreRest,
  FirestoreError,
  decodeValue,
  decodeFields,
  decodeDocument,
  buildStartRangeQuery,
  buildMultiQuery,
  listIntervals,
} from "./firestore.js";
export type {
  FetchLike,
  FirestoreValue,
  FirestoreDocument,
  TokenProvider,
} from "./firestore.js";

export {
  FIREBASE_API_KEY,
  FIREBASE_PROJECT_ID,
  FIREBASE_APP_ID,
} from "./const.js";

export * from "./types.js";
