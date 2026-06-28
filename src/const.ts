/**
 * Public Huckleberry / Firebase constants.
 *
 * These are not secrets — the same values ship inside the public Huckleberry
 * mobile app. They identify the Firebase project the app talks to. Ported from
 * the Python client's `const.py`.
 */

export const FIREBASE_API_KEY = "AIzaSyApGVHktXeekGyAt-G6dIeWHUkq2oXqcjg";
export const FIREBASE_PROJECT_ID = "simpleintervals";
export const FIREBASE_APP_ID = "1:219218185774:android:a3e215cc246b92b0";

/** Firebase Identity Toolkit — email/password sign-in. */
export const AUTH_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

/** Firebase Secure Token endpoint — exchange a refresh token for a fresh ID token. */
export const REFRESH_URL = "https://securetoken.googleapis.com/v1/token";

/**
 * Firestore REST base for the Huckleberry project.
 * Documents live under `{FIRESTORE_BASE_URL}/{collection}/{docId}`.
 */
export const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

/** Firebase Storage bucket that hosts the curated solids food database. */
export const CURATED_FOODS_BUCKET = "simpleintervals.appspot.com";

/** Storage object path for the curated solids food JSON. */
export const CURATED_FOODS_OBJECT = "foods/fooddb.json";
