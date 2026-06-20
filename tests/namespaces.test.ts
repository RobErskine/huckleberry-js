import { describe, expect, it, vi } from "vitest";
import { HuckleberryClient } from "../src/client.js";
import {
  AuthError,
  FirestoreError,
  HuckleberryError,
  InvalidDateRangeError,
} from "../src/index.js";

function clientWithSession(): HuckleberryClient {
  return new HuckleberryClient({
    session: {
      idToken: "id",
      refreshToken: "r",
      uid: "uid-1",
      expiresAt: Date.now() + 3_600_000,
    },
  });
}

describe("namespaced API delegates to flat methods", () => {
  it("sleep.list forwards the range endpoints unchanged", async () => {
    const client = clientWithSession();
    const spy = vi
      .spyOn(client, "listSleepIntervals")
      .mockResolvedValue([{ start: 1 }] as never);

    const range = { start: new Date(1000), end: new Date(2000) };
    const res = await client.sleep.list("c1", range);

    expect(spy).toHaveBeenCalledWith("c1", range.start, range.end);
    expect(res).toEqual([{ start: 1 }]);
  });

  it("user.listChildren reads childList", async () => {
    const client = clientWithSession();
    vi.spyOn(client, "getUser").mockResolvedValue({
      childList: [{ cid: "c1" }, { cid: "c2" }],
    } as never);

    expect(await client.user.listChildren()).toEqual([{ cid: "c1" }, { cid: "c2" }]);
  });

  it("health.getLatestGrowth reads prefs.lastGrowthEntry", async () => {
    const client = clientWithSession();
    vi.spyOn(client, "getHealth").mockResolvedValue({
      prefs: { lastGrowthEntry: { mode: "growth", start: 5, offset: 0, weight: 5.2 } },
    } as never);

    expect((await client.health.getLatestGrowth("c1"))?.weight).toBe(5.2);
  });

  it("the namespace getter is stable (same instance)", () => {
    const client = clientWithSession();
    expect(client.sleep).toBe(client.sleep);
  });

  it("rejects an empty range with InvalidDateRangeError", () => {
    const client = clientWithSession();
    expect(() => client.sleep.list("c1", { start: 10, end: 10 })).toThrow(
      InvalidDateRangeError,
    );
  });

  it("rejects a non-date range point", () => {
    const client = clientWithSession();
    expect(() =>
      client.feed.list("c1", { start: "nope" as never, end: 20 }),
    ).toThrow(InvalidDateRangeError);
  });
});

describe("structured errors", () => {
  it("AuthError keeps its legacy shape and gains structured fields", () => {
    const e = new AuthError("bad creds", 401, "body-text");
    expect(e).toBeInstanceOf(AuthError);
    expect(e).toBeInstanceOf(HuckleberryError);
    expect(e.status).toBe(401);
    expect(e.body).toBe("body-text");
    expect(e.category).toBe("auth");
    expect(e.retryable).toBe(false);
    expect(e.toJSON()).toMatchObject({ error: "AuthError", category: "auth" });
  });

  it("FirestoreError is retryable on 5xx but not 4xx", () => {
    expect(new FirestoreError("x", 503, "").retryable).toBe(true);
    expect(new FirestoreError("x", 400, "").retryable).toBe(false);
    expect(new FirestoreError("x", 401, "").recovery).toMatch(/re-authenticate/i);
  });

  it("InvalidDateRangeError carries invalid_input category", () => {
    expect(new InvalidDateRangeError("nope").category).toBe("invalid_input");
  });
});
