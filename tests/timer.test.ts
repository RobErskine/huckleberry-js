import { describe, expect, it } from "vitest";
import { HuckleberryClient } from "../src/client.js";
import { encodeFields } from "../src/firestore.js";

type Call = { method: string; url: string; body?: unknown };

/**
 * Build a client whose fetch returns preconfigured state documents for GET
 * requests and a success response for all PATCHes. GET URL matching:
 *   - /sleep/{cid}  → sleepDoc
 *   - /feed/{cid}   → feedDoc
 * (Only the parent doc path matches; child subcollections never GET.)
 */
function makeTimerClient(docs: {
  sleep?: Record<string, unknown> | null;
  feed?: Record<string, unknown> | null;
} = {}) {
  const calls: Call[] = [];

  const fetchMock = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });

    if (method === "GET") {
      const u = String(url);
      let doc: Record<string, unknown> | null | undefined = null;
      // Match parent doc paths only (no subcollections = no extra path segment).
      if (/\/sleep\/[^/]+$/.test(u)) doc = docs.sleep ?? null;
      if (/\/feed\/[^/]+$/.test(u)) doc = docs.feed ?? null;
      if (!doc) return new Response(JSON.stringify({ fields: {} }), { status: 200 });
      return new Response(
        JSON.stringify({ fields: encodeFields(doc) }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ fields: {} }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new HuckleberryClient({
    fetch: fetchMock,
    firestoreBaseUrl: "https://fs.test",
    timezone: "UTC",
    session: {
      idToken: "t",
      refreshToken: "r",
      uid: "u1",
      expiresAt: Date.now() + 3_600_000,
    },
  });

  return { client, calls };
}

const patchCalls = (calls: Call[]) => calls.filter((c) => c.method === "PATCH");

// Convenience: pull the fields map from a PATCH body.
function fields(call: Call): Record<string, unknown> {
  return (call.body as { fields: Record<string, unknown> }).fields;
}

// Decode a single field's Firestore value to a plain JS value for assertions.
function boolOf(f: unknown): boolean {
  return (f as { booleanValue: boolean }).booleanValue;
}
function strOf(f: unknown): string {
  return (f as { stringValue: string }).stringValue;
}
function numOf(f: unknown): number {
  const v = f as Record<string, unknown>;
  if ("doubleValue" in v) return v.doubleValue as number;
  return Number(v.integerValue);
}
function intOf(f: unknown): string {
  return (f as { integerValue: string }).integerValue;
}
function mapOf(f: unknown): Record<string, unknown> {
  return ((f as { mapValue: { fields: Record<string, unknown> } }).mapValue.fields);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sleep timer — startSleep
// ─────────────────────────────────────────────────────────────────────────────

describe("startSleep", () => {
  it("sends one PATCH to sleep/{cid} with active timer fields", async () => {
    const { client, calls } = makeTimerClient();
    await client.startSleep("c1");

    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    const url = new URL(patches[0].url);
    expect(url.pathname).toBe("/sleep/c1");
    // mask must include "timer" (whole-map set)
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toContain("timer");

    const timer = mapOf(fields(patches[0]).timer);
    expect(boolOf(timer.active)).toBe(true);
    expect(boolOf(timer.paused)).toBe(false);
    // timerStartTime is in MILLISECONDS (a large doubleValue > 1e12)
    expect(numOf(timer.timerStartTime)).toBeGreaterThan(1e12);
    // uuid is 16 hex chars
    expect(strOf(timer.uuid)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("includes details when provided", async () => {
    const { client, calls } = makeTimerClient();
    await client.startSleep("c1", { details: { startSleepCondition: { happy: true } } });
    const timer = mapOf(fields(patchCalls(calls)[0]).timer);
    expect(timer.details).toBeDefined();
  });

  it("omits details when not provided", async () => {
    const { client, calls } = makeTimerClient();
    await client.startSleep("c1");
    const timer = mapOf(fields(patchCalls(calls)[0]).timer);
    expect(timer.details).toBeUndefined();
  });

  it("returns dryRun plan without fetching", async () => {
    const { client, calls } = makeTimerClient();
    const result = await client.startSleep("c1", undefined, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(patchCalls(calls)).toHaveLength(0);
    expect(result.plan.writes).toHaveLength(1);
  });

  it("delegates via sleep namespace", async () => {
    const { client, calls } = makeTimerClient();
    await client.sleep.start("c1");
    expect(patchCalls(calls)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sleep timer — pauseSleep
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_SLEEP = {
  timer: {
    active: true,
    paused: false,
    timerStartTime: 1_000_000, // ms
    uuid: "feedbeef12345678",
    timestamp: { seconds: 1000 },
    local_timestamp: 1000,
  },
};

const PAUSED_SLEEP = {
  timer: {
    active: true,
    paused: true,
    timerStartTime: 1_000_000,
    timerEndTime: 1_060_000,
    uuid: "feedbeef12345678",
    timestamp: { seconds: 1060 },
    local_timestamp: 1060,
  },
};

describe("pauseSleep", () => {
  it("PATCHes timer.paused=true and sets timerEndTime (ms)", async () => {
    const { client, calls } = makeTimerClient({ sleep: ACTIVE_SLEEP });
    await client.pauseSleep("c1");
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    // Dotted keys become nested in the body under the top-level "timer" mapValue.
    const timer = mapOf(fields(patches[0]).timer);
    expect(boolOf(timer.paused)).toBe(true);
    expect(boolOf(timer.active)).toBe(true);
    // timerEndTime must be in milliseconds
    expect(numOf(timer.timerEndTime)).toBeGreaterThan(1e12);
  });

  it("throws if timer is not active", async () => {
    const { client } = makeTimerClient({ sleep: null });
    await expect(client.pauseSleep("c1")).rejects.toThrow(/not active/);
  });

  it("throws if timer is already paused", async () => {
    const { client } = makeTimerClient({ sleep: PAUSED_SLEEP });
    await expect(client.pauseSleep("c1")).rejects.toThrow(/already paused/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sleep timer — resumeSleep
// ─────────────────────────────────────────────────────────────────────────────

describe("resumeSleep", () => {
  it("PATCHes timer.paused=false, does NOT reset timerStartTime", async () => {
    const { client, calls } = makeTimerClient({ sleep: PAUSED_SLEEP });
    await client.resumeSleep("c1");
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    const timer = mapOf(fields(patches[0]).timer);
    expect(boolOf(timer.paused)).toBe(false);
    expect(boolOf(timer.active)).toBe(true);
    // timerStartTime must NOT be in the update (only paused, active, timestamp fields)
    expect(timer.timerStartTime).toBeUndefined();
  });

  it("throws if timer is not active", async () => {
    const { client } = makeTimerClient({ sleep: null });
    await expect(client.resumeSleep("c1")).rejects.toThrow(/not active/);
  });

  it("throws if timer is not paused", async () => {
    const { client } = makeTimerClient({ sleep: ACTIVE_SLEEP });
    await expect(client.resumeSleep("c1")).rejects.toThrow(/not paused/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sleep timer — cancelSleep
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelSleep", () => {
  it("replaces entire timer map with active=false, preserves uuid", async () => {
    const { client, calls } = makeTimerClient({ sleep: ACTIVE_SLEEP });
    await client.cancelSleep("c1");
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    const url = new URL(patches[0].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toContain("timer");
    const timer = mapOf(fields(patches[0]).timer);
    expect(boolOf(timer.active)).toBe(false);
    expect(boolOf(timer.paused)).toBe(false);
    expect(strOf(timer.uuid)).toBe("feedbeef12345678");
    // timerStartTime must NOT be in the new timer map
    expect(timer.timerStartTime).toBeUndefined();
  });

  it("still cancels when no timer exists (generates a fresh uuid)", async () => {
    const { client, calls } = makeTimerClient({ sleep: null });
    await client.cancelSleep("c1");
    expect(patchCalls(calls)).toHaveLength(1);
    const timer = mapOf(fields(patchCalls(calls)[0]).timer);
    expect(timer.uuid).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sleep timer — completeSleep
// ─────────────────────────────────────────────────────────────────────────────

describe("completeSleep", () => {
  it("writes 2 PATCHes (interval set, then timer+prefs update) for paused timer", async () => {
    const { client, calls } = makeTimerClient({ sleep: PAUSED_SLEEP });
    const result = await client.completeSleep("c1");

    const patches = patchCalls(calls);
    expect(patches).toHaveLength(2);

    // First PATCH: interval row (no updateMask → full set)
    const intervalCall = patches[0];
    expect(intervalCall.url).toMatch(
      new RegExp(`^https://fs\\.test/sleep/c1/intervals/${result.id}$`),
    );
    expect(new URL(intervalCall.url).searchParams.size).toBe(0);
    const row = fields(intervalCall);
    // start/duration stored as integerValues
    expect(intOf(row.start)).toBe("1000"); // timerStartMs / 1000 = 1000
    expect(intOf(row.duration)).toBe("60"); // (1060000 - 1000000) / 1000 = 60
    expect(numOf(row.offset)).toBe(0); // UTC timezone

    // Second PATCH: timer+prefs update
    const updateCall = patches[1];
    const urlParams = new URL(updateCall.url).searchParams.getAll("updateMask.fieldPaths");
    expect(urlParams).toContain("timer");
    expect(urlParams).toContain("prefs.lastSleep");

    const f = fields(updateCall);
    const timer = mapOf(f.timer);
    expect(boolOf(timer.active)).toBe(false);
    expect(boolOf(timer.paused)).toBe(false);
    expect(timer.timerStartTime).toBeUndefined(); // cleared from new map
  });

  it("uses timerEndTime (not now) when timer is paused", async () => {
    const { client, calls } = makeTimerClient({ sleep: PAUSED_SLEEP });
    await client.completeSleep("c1");
    const row = fields(patchCalls(calls)[0]);
    expect(intOf(row.duration)).toBe("60");
  });

  it("id is a 16-hex string (no timestamp prefix)", async () => {
    const { client } = makeTimerClient({ sleep: PAUSED_SLEEP });
    const result = await client.completeSleep("c1");
    expect(result.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("clears timer field when timerStartTime is missing", async () => {
    const noStart = {
      timer: { active: true, paused: false, uuid: "abc", timestamp: { seconds: 1000 } },
    };
    const { client, calls } = makeTimerClient({ sleep: noStart });
    const result = await client.completeSleep("c1");
    expect(result.id).toBeUndefined();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    // mask contains "timer" with DELETE_FIELD → body has no timer field
    const url = new URL(patches[0].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toContain("timer");
    expect(fields(patches[0]).timer).toBeUndefined();
  });

  it("throws if timer is not active", async () => {
    const { client } = makeTimerClient({ sleep: null });
    await expect(client.completeSleep("c1")).rejects.toThrow(/not active/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nursing timer — startNursing
// ─────────────────────────────────────────────────────────────────────────────

describe("startNursing", () => {
  it("sends one PATCH to feed/{cid} with active timer, feedStartTime in SECONDS", async () => {
    const { client, calls } = makeTimerClient();
    await client.startNursing("c1");
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    const url = new URL(patches[0].url);
    expect(url.pathname).toBe("/feed/c1");
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toContain("timer");

    const timer = mapOf(fields(patches[0]).timer);
    expect(boolOf(timer.active)).toBe(true);
    expect(boolOf(timer.paused)).toBe(false);
    // feedStartTime and timerStartTime in SECONDS (< 1e11 for reasonable dates)
    expect(numOf(timer.feedStartTime)).toBeGreaterThan(1e9);
    expect(numOf(timer.feedStartTime)).toBeLessThan(1e11);
    expect(numOf(timer.timerStartTime)).toBeGreaterThan(1e9);
    expect(numOf(timer.timerStartTime)).toBeLessThan(1e11);
    expect(strOf(timer.activeSide)).toBe("left");
    expect(numOf(timer.leftDuration)).toBe(0);
    expect(numOf(timer.rightDuration)).toBe(0);
  });

  it("sets activeSide to provided side", async () => {
    const { client, calls } = makeTimerClient();
    await client.startNursing("c1", { side: "right" });
    const timer = mapOf(fields(patchCalls(calls)[0]).timer);
    expect(strOf(timer.activeSide)).toBe("right");
  });

  it("delegates via feed namespace", async () => {
    const { client, calls } = makeTimerClient();
    await client.feed.startNursing("c1");
    expect(patchCalls(calls)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nursing timer — pauseNursing
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_NURSING = {
  timer: {
    active: true,
    paused: false,
    feedStartTime: 1000,
    timerStartTime: 1000, // seconds
    leftDuration: 30,
    rightDuration: 0,
    lastSide: "none",
    activeSide: "left",
    uuid: "abcd1234abcd1234",
    timestamp: { seconds: 1000 },
    local_timestamp: 1000,
  },
};

const PAUSED_NURSING = {
  timer: {
    active: true,
    paused: true,
    feedStartTime: 1000,
    timerStartTime: 1060,
    leftDuration: 60,
    rightDuration: 0,
    lastSide: "left",
    uuid: "abcd1234abcd1234",
    timestamp: { seconds: 1090 },
    local_timestamp: 1090,
  },
};

describe("pauseNursing", () => {
  it("sets paused=true, deletes activeSide, banks elapsed into left side", async () => {
    const { client, calls } = makeTimerClient({ feed: ACTIVE_NURSING });
    await client.pauseNursing("c1");
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    // Dotted-path writes are nested under "timer" mapValue in the body.
    const timer = mapOf(fields(patches[0]).timer);
    expect(boolOf(timer.paused)).toBe(true);
    // activeSide must be in mask but absent from body (DELETE_FIELD)
    const url = new URL(patches[0].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toContain("timer.activeSide");
    expect(timer.activeSide).toBeUndefined();
    // leftDuration banked from timerStartTime=1000 to ~now (> 30 original)
    expect(numOf(timer.leftDuration)).toBeGreaterThanOrEqual(30);
  });

  it("throws if timer is not active", async () => {
    const { client } = makeTimerClient({ feed: null });
    await expect(client.pauseNursing("c1")).rejects.toThrow(/not active/);
  });

  it("throws if timer is already paused", async () => {
    const { client } = makeTimerClient({ feed: PAUSED_NURSING });
    await expect(client.pauseNursing("c1")).rejects.toThrow(/already paused/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nursing timer — resumeNursing
// ─────────────────────────────────────────────────────────────────────────────

describe("resumeNursing", () => {
  it("resets timerStartTime, sets activeSide from lastSide, lastSide='none'", async () => {
    const { client, calls } = makeTimerClient({ feed: PAUSED_NURSING });
    await client.resumeNursing("c1");
    const timer = mapOf(fields(patchCalls(calls)[0]).timer);
    expect(boolOf(timer.paused)).toBe(false);
    expect(strOf(timer.activeSide)).toBe("left"); // from lastSide="left"
    expect(strOf(timer.lastSide)).toBe("none");
    // timerStartTime is reset to now (SECONDS)
    expect(numOf(timer.timerStartTime)).toBeGreaterThan(1e9);
  });

  it("accepts an explicit side override", async () => {
    const { client, calls } = makeTimerClient({ feed: PAUSED_NURSING });
    await client.resumeNursing("c1", { side: "right" });
    const timer = mapOf(fields(patchCalls(calls)[0]).timer);
    expect(strOf(timer.activeSide)).toBe("right");
  });

  it("throws if timer is not active", async () => {
    const { client } = makeTimerClient({ feed: null });
    await expect(client.resumeNursing("c1")).rejects.toThrow(/not active/);
  });

  it("throws if timer is not paused", async () => {
    const { client } = makeTimerClient({ feed: ACTIVE_NURSING });
    await expect(client.resumeNursing("c1")).rejects.toThrow(/not paused/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nursing timer — switchNursingSide
// ─────────────────────────────────────────────────────────────────────────────

describe("switchNursingSide", () => {
  it("flips activeSide and resets timerStartTime when running", async () => {
    const { client, calls } = makeTimerClient({ feed: ACTIVE_NURSING });
    await client.switchNursingSide("c1");
    const timer = mapOf(fields(patchCalls(calls)[0]).timer);
    expect(strOf(timer.activeSide)).toBe("right"); // left → right
    expect(numOf(timer.timerStartTime)).toBeGreaterThan(1e9);
    expect(strOf(timer.lastSide)).toBe("none");
    // left got the elapsed time banked (was 30, now > 30)
    expect(numOf(timer.leftDuration)).toBeGreaterThan(30);
    expect(boolOf(timer.paused)).toBe(false);
  });

  it("does NOT bank elapsed when paused", async () => {
    const { client, calls } = makeTimerClient({ feed: PAUSED_NURSING });
    await client.switchNursingSide("c1");
    const timer = mapOf(fields(patchCalls(calls)[0]).timer);
    // leftDuration stays at 60 (no banking because paused)
    expect(numOf(timer.leftDuration)).toBe(60);
    expect(numOf(timer.rightDuration)).toBe(0);
  });

  it("throws if timer is not active", async () => {
    const { client } = makeTimerClient({ feed: null });
    await expect(client.switchNursingSide("c1")).rejects.toThrow(/not active/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nursing timer — cancelNursing
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelNursing", () => {
  it("replaces timer map: active=false, leftDuration=rightDuration=0", async () => {
    const { client, calls } = makeTimerClient({ feed: ACTIVE_NURSING });
    await client.cancelNursing("c1");
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    const url = new URL(patches[0].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toContain("timer");
    const timer = mapOf(fields(patches[0]).timer);
    expect(boolOf(timer.active)).toBe(false);
    expect(numOf(timer.leftDuration)).toBe(0);
    expect(numOf(timer.rightDuration)).toBe(0);
    expect(strOf(timer.uuid)).toBe("abcd1234abcd1234");
    expect(timer.feedStartTime).toBeUndefined(); // cleared from map
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nursing timer — completeNursing
// ─────────────────────────────────────────────────────────────────────────────

describe("completeNursing", () => {
  it("writes 2 PATCHes: interval row then timer+prefs update", async () => {
    const { client, calls } = makeTimerClient({ feed: PAUSED_NURSING });
    const result = await client.completeNursing("c1");

    const patches = patchCalls(calls);
    expect(patches).toHaveLength(2);

    // Interval row (full set, no mask)
    const rowCall = patches[0];
    expect(rowCall.url).toMatch(
      new RegExp(`^https://fs\\.test/feed/c1/intervals/${result.id}$`),
    );
    expect(new URL(rowCall.url).searchParams.size).toBe(0);
    const row = fields(rowCall);
    expect(strOf(row.mode)).toBe("breast");
    expect(numOf(row.start)).toBe(1000); // feedStartTime
    expect(strOf(row.lastSide)).toBe("left");

    // Timer update with DELETE_FIELDs
    const timerCall = patches[1];
    const mask = new URL(timerCall.url).searchParams.getAll("updateMask.fieldPaths");
    expect(mask).toContain("timer.leftDuration");
    expect(mask).toContain("timer.rightDuration");
    expect(mask).toContain("timer.activeSide");
    expect(mask).toContain("prefs.lastNursing");
    // Dotted-path fields are nested in the body under "timer" mapValue.
    const timerFields = mapOf(fields(timerCall).timer);
    expect(boolOf(timerFields.active)).toBe(false);
    expect(boolOf(timerFields.paused)).toBe(true); // paused=true after complete
    // DELETE_FIELD keys appear in mask but not in body
    expect(timerFields.leftDuration).toBeUndefined();
    expect(timerFields.rightDuration).toBeUndefined();
    expect(timerFields.activeSide).toBeUndefined();
  });

  it("id uses {timestamp_ms}-{hex20} format", async () => {
    const { client } = makeTimerClient({ feed: PAUSED_NURSING });
    const result = await client.completeNursing("c1");
    expect(result.id).toMatch(/^\d+-[0-9a-f]{20}$/);
  });

  it("infers lastSide='right' when lastSide='none' and rightDuration >= leftDuration", async () => {
    const noneDoc = {
      timer: {
        active: true,
        paused: true,
        feedStartTime: 1000,
        timerStartTime: 1060,
        leftDuration: 10,
        rightDuration: 50,
        lastSide: "none",
        uuid: "abcd1234abcd1234",
        timestamp: { seconds: 1090 },
        local_timestamp: 1090,
      },
    };
    const { client, calls } = makeTimerClient({ feed: noneDoc });
    await client.completeNursing("c1");
    const row = fields(patchCalls(calls)[0]);
    expect(strOf(row.lastSide)).toBe("right");
  });

  it("banks elapsed into activeSide when not paused", async () => {
    const { client, calls } = makeTimerClient({ feed: ACTIVE_NURSING });
    await client.completeNursing("c1");
    const row = fields(patchCalls(calls)[0]);
    // leftDuration started at 30; with activeSide="left", elapsed is added → > 30
    expect(numOf(row.leftDuration)).toBeGreaterThan(30);
  });

  it("throws if timer is not active", async () => {
    const { client } = makeTimerClient({ feed: null });
    await expect(client.completeNursing("c1")).rejects.toThrow(/not active/);
  });

  it("throws if timerStartTime is missing", async () => {
    const noStart = {
      timer: {
        active: true,
        paused: false,
        feedStartTime: 1000,
        uuid: "abcd",
        leftDuration: 0,
        rightDuration: 0,
        lastSide: "left",
      },
    };
    const { client } = makeTimerClient({ feed: noStart });
    await expect(client.completeNursing("c1")).rejects.toThrow(/no start time/);
  });
});
