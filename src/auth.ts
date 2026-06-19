/**
 * Firebase email/password authentication + token refresh.
 *
 * Both calls are plain REST against Google's public Identity Toolkit /
 * Secure Token endpoints — a direct port of the Python client's
 * `authenticate()` and `refresh_session_token()`. There is no OAuth redirect
 * or callback: the user supplies their Huckleberry email + password once and we
 * receive an ID token (valid ~1h) plus a long-lived refresh token.
 */

import { AUTH_URL, FIREBASE_API_KEY, REFRESH_URL } from "./const.js";
import type { FetchLike } from "./firestore.js";

/** An authenticated session. `expiresAt` is epoch milliseconds. */
export interface Session {
  idToken: string;
  refreshToken: string;
  uid: string;
  expiresAt: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

async function readError(res: Response, operation: string): Promise<never> {
  const body = await res.text();
  throw new AuthError(
    `${operation} failed: HTTP ${res.status} ${res.statusText} ${body}`.trim(),
    res.status,
    body,
  );
}

/** Sign in with Huckleberry email + password, returning a fresh session. */
export async function signIn(
  email: string,
  password: string,
  fetchImpl: FetchLike,
): Promise<Session> {
  const res = await fetchImpl(`${AUTH_URL}?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) await readError(res, "Authentication");

  const data = (await res.json()) as {
    idToken: string;
    refreshToken: string;
    localId: string;
    expiresIn: string;
  };
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    expiresAt: Date.now() + Number(data.expiresIn) * 1000,
  };
}

/** Exchange a refresh token for a new ID token (and rotated refresh token). */
export async function refresh(
  refreshToken: string,
  fetchImpl: FetchLike,
): Promise<Omit<Session, "uid">> {
  const res = await fetchImpl(`${REFRESH_URL}?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) await readError(res, "Token refresh");

  const data = (await res.json()) as {
    id_token: string;
    refresh_token: string;
    expires_in: string;
  };
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
  };
}
