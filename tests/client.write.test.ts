import { describe, expect, it } from "vitest";
import { HuckleberryClient } from "../src/client.js";
import { encodeFields } from "../src/firestore.js";

/**
 * Build a client whose fetch is mocked: GET returns `parent` (the diaper doc
 * read for the newest-wins guard; null → 404), and any PATCH is captured.
 */
function makeClient(
  opts: { parent?: Record<string, unknown> | null } = {},
) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const fetchMock = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === "GET") {
      const parent = opts.parent ?? null;
      if (!parent) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ fields: encodeFields(parent) }), {
        status: 200,
      });
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

const writesOf = (calls: Array<{ method: string }>) =>
  calls.filter((c) => c.method === "PATCH") as Array<{ url: string; body: any }>;

describe("logDiaper", () => {
  it("writes an interval row and updates prefs.lastDiaper", async () => {
    const { client, calls } = makeClient({ parent: null });
    const res = await client.logDiaper("c1", {
      mode: "pee",
      start: 1000,
      peeAmount: "medium",
    });

    expect(res.dryRun).toBe(false);
    expect(res.id).toMatch(/^\d+-[0-9a-f]{20}$/);

    const writes = writesOf(calls);
    expect(writes).toHaveLength(2);

    // 1) interval row: full set, no updateMask
    const interval = writes[0];
    expect(interval.url).toBe(`https://fs.test/diaper/c1/intervals/${res.id}`);
    expect(interval.url).not.toContain("updateMask");
    const row = interval.body.fields;
    expect(row.mode).toEqual({ stringValue: "pee" });
    expect(row.start).toEqual({ doubleValue: 1000 });
    expect(row.offset).toEqual({ doubleValue: 0 });
    expect(row.quantity.mapValue.fields.pee).toEqual({ doubleValue: 50 });
    expect(row.lastUpdated).toBeDefined();
    expect(row.isPotty).toBeUndefined();

    // 2) prefs update: masked merge of the three dotted paths
    const pref = writes[1];
    const url = new URL(pref.url);
    expect(url.pathname).toBe("/diaper/c1");
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toEqual([
      "prefs.lastDiaper",
      "prefs.timestamp",
      "prefs.local_timestamp",
    ]);
    expect(pref.body.fields.prefs.mapValue.fields.lastDiaper.mapValue.fields).toEqual(
      {
        start: { doubleValue: 1000 },
        mode: { stringValue: "pee" },
        offset: { doubleValue: 0 },
      },
    );
  });

  it("skips the prefs update when an existing summary is newer", async () => {
    const { client, calls } = makeClient({
      parent: { prefs: { lastDiaper: { start: 9999 } } },
    });
    await client.logDiaper("c1", { mode: "poo", start: 1000 });

    const writes = writesOf(calls);
    expect(writes).toHaveLength(1); // interval only
    expect(writes[0].url).toContain("/intervals/");
  });

  it("dryRun returns the plan and performs no writes", async () => {
    const { client, calls } = makeClient({ parent: null });
    const res = await client.logDiaper("c1", { mode: "dry" }, { dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.plan.writes.map((w) => w.op)).toEqual(["set", "update"]);
    expect(writesOf(calls)).toHaveLength(0); // a GET is fine; no PATCH
  });

  it("throws InvalidInputError when mode is missing", async () => {
    const { client } = makeClient({ parent: null });
    await expect(
      client.logDiaper("c1", {} as never),
    ).rejects.toThrow(/mode is required/);
  });
});

describe("logPotty", () => {
  it("sets isPotty + howItHappened, omits diaperRash, updates prefs.lastPotty", async () => {
    const { client, calls } = makeClient({ parent: null });
    await client.logPotty("c1", {
      mode: "pee",
      howItHappened: "wentPotty",
      // diaperRash is not part of LogPottyInput, but prove it's never written:
      diaperRash: true,
    } as never);

    const writes = writesOf(calls);
    const row = writes[0].body.fields;
    expect(row.isPotty).toEqual({ booleanValue: true });
    expect(row.howItHappened).toEqual({ stringValue: "wentPotty" });
    expect(row.diaperRash).toBeUndefined();

    const url = new URL(writes[1].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")[0]).toBe(
      "prefs.lastPotty",
    );
  });
});

describe("diapers namespace delegates", () => {
  it("diapers.log forwards to logDiaper", async () => {
    const { client, calls } = makeClient({ parent: null });
    const res = await client.diapers.log("c1", { mode: "both" });
    expect(res.id).toBeDefined();
    expect(writesOf(calls).length).toBeGreaterThan(0);
  });
});

const fields = (w: { body: any }) => w.body.fields;

describe("logBottle", () => {
  it("writes feed row with amount/units and prefs.lastBottle with bottleAmount/bottleUnits", async () => {
    const { client, calls } = makeClient({ parent: null });
    const res = await client.logBottle("c1", {
      amount: 120,
      start: 1000,
      bottleType: "Breast Milk",
      units: "oz",
    });

    const writes = writesOf(calls);
    expect(writes).toHaveLength(2);

    const row = fields(writes[0]);
    expect(writes[0].url).toBe(`https://fs.test/feed/c1/intervals/${res.id}`);
    expect(row.mode).toEqual({ stringValue: "bottle" });
    expect(row.amount).toEqual({ doubleValue: 120 });
    expect(row.units).toEqual({ stringValue: "oz" });
    expect(row.end_offset).toEqual({ doubleValue: 0 });

    const prefs = fields(writes[1]).prefs.mapValue.fields;
    expect(prefs.lastBottle.mapValue.fields.bottleAmount).toEqual({ doubleValue: 120 });
    expect(prefs.lastBottle.mapValue.fields.bottleUnits).toEqual({ stringValue: "oz" });
    expect(prefs.bottleAmount).toEqual({ doubleValue: 120 });
    expect(prefs.bottleType).toEqual({ stringValue: "Breast Milk" });
  });
});

describe("logGrowth", () => {
  it("writes to the data subcollection with paired unit fields and mirrors into prefs", async () => {
    const { client, calls } = makeClient({ parent: null });
    const res = await client.logGrowth("c1", { weight: 4.2, head: 38, start: 1000 });

    const writes = writesOf(calls);
    expect(writes[0].url).toBe(`https://fs.test/health/c1/data/${res.id}`);
    const row = fields(writes[0]);
    expect(row.type).toEqual({ stringValue: "health" });
    expect(row.mode).toEqual({ stringValue: "growth" });
    expect(row._id).toEqual({ stringValue: res.id });
    expect(row.weight).toEqual({ doubleValue: 4.2 });
    expect(row.weightUnits).toEqual({ stringValue: "kg" });
    expect(row.head).toEqual({ doubleValue: 38 });
    expect(row.headUnits).toEqual({ stringValue: "hcm" });
    expect(row.height).toBeUndefined();
    expect(row.isNight).toEqual({ booleanValue: false });

    const url = new URL(writes[1].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")[0]).toBe(
      "prefs.lastGrowthEntry",
    );
  });

  it("uses imperial unit labels when requested", async () => {
    const { client, calls } = makeClient({ parent: null });
    await client.logGrowth("c1", { height: 20, units: "imperial" });
    const row = fields(writesOf(calls)[0]);
    expect(row.heightUnits).toEqual({ stringValue: "ft.in" });
  });

  it("throws when no measurement is provided", async () => {
    const { client } = makeClient({ parent: null });
    await expect(client.logGrowth("c1", {})).rejects.toThrow(/measurement/);
  });
});

describe("logPump", () => {
  it("splits totalAmount evenly across both sides with entryMode total", async () => {
    const { client, calls } = makeClient({ parent: null });
    await client.logPump("c1", { totalAmount: 100, start: 1000, duration: 600 });

    const row = fields(writesOf(calls)[0]);
    expect(row.entryMode).toEqual({ stringValue: "total" });
    expect(row.leftAmount).toEqual({ doubleValue: 50 });
    expect(row.rightAmount).toEqual({ doubleValue: 50 });
    expect(row.duration).toEqual({ doubleValue: 600 });
    expect(row.end_offset).toEqual({ doubleValue: 0 });
  });

  it("uses leftright when both sides are given", async () => {
    const { client, calls } = makeClient({ parent: null });
    await client.logPump("c1", { leftAmount: 30, rightAmount: 40 });
    const row = fields(writesOf(calls)[0]);
    expect(row.entryMode).toEqual({ stringValue: "leftright" });
    expect(row.leftAmount).toEqual({ doubleValue: 30 });
    expect(row.duration).toBeUndefined();
  });

  it("rejects mixing totalAmount with a side amount", async () => {
    const { client } = makeClient({ parent: null });
    await expect(
      client.logPump("c1", { totalAmount: 100, leftAmount: 50 }),
    ).rejects.toThrow(/either totalAmount/);
  });

  it("rejects leftright with only one side", async () => {
    const { client } = makeClient({ parent: null });
    await expect(client.logPump("c1", { leftAmount: 50 })).rejects.toThrow(
      /both leftAmount and rightAmount/,
    );
  });
});

describe("logActivity", () => {
  it("writes a row and updates the per-mode prefs field", async () => {
    const { client, calls } = makeClient({ parent: null });
    await client.logActivity("c1", { mode: "tummyTime", start: 1000, duration: 120 });

    const writes = writesOf(calls);
    expect(writes[0].url).toContain("/activities/c1/intervals/");
    const row = fields(writes[0]);
    expect(row.mode).toEqual({ stringValue: "tummyTime" });
    expect(row.duration).toEqual({ doubleValue: 120 });

    const url = new URL(writes[1].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")[0]).toBe(
      "prefs.lastTummyTime",
    );
  });
});

describe("logSleep", () => {
  it("writes start/duration as integers with a 16-hex interval id", async () => {
    const { client, calls } = makeClient({ parent: null });
    const res = await client.logSleep("c1", { start: 1000, end: 4600 });

    expect(res.id).toMatch(/^[0-9a-f]{16}$/);
    const writes = writesOf(calls);
    expect(writes[0].url).toBe(`https://fs.test/sleep/c1/intervals/${res.id}`);
    const row = fields(writes[0]);
    expect(row.start).toEqual({ integerValue: "1000" });
    expect(row.duration).toEqual({ integerValue: "3600" });
    expect(row.offset).toEqual({ doubleValue: 0 });

    const last = fields(writes[1]).prefs.mapValue.fields.lastSleep.mapValue.fields;
    expect(last.start).toEqual({ integerValue: "1000" });
    expect(last.duration).toEqual({ integerValue: "3600" });
  });

  it("rejects end before start", async () => {
    const { client } = makeClient({ parent: null });
    await expect(
      client.logSleep("c1", { start: 5000, end: 1000 }),
    ).rejects.toThrow(/end must be at or after start/);
  });
});

describe("logNursing", () => {
  it("attributes the whole span to the given side when no per-side durations", async () => {
    const { client, calls } = makeClient({ parent: null });
    await client.logNursing("c1", { start: 1000, end: 1300, side: "right" });

    const row = fields(writesOf(calls)[0]);
    expect(row.mode).toEqual({ stringValue: "breast" });
    expect(row.lastSide).toEqual({ stringValue: "right" });
    expect(row.leftDuration).toEqual({ doubleValue: 0 });
    expect(row.rightDuration).toEqual({ doubleValue: 300 });

    const prefs = fields(writesOf(calls)[1]).prefs.mapValue.fields;
    expect(prefs.lastNursing.mapValue.fields.duration).toEqual({ doubleValue: 300 });
    expect(prefs.lastSide.mapValue.fields.lastSide).toEqual({ stringValue: "right" });
  });

  it("uses explicit per-side durations and sums them", async () => {
    const { client, calls } = makeClient({ parent: null });
    await client.logNursing("c1", {
      start: 1000,
      end: 1500,
      leftDuration: 120,
      rightDuration: 180,
    });
    const prefs = fields(writesOf(calls)[1]).prefs.mapValue.fields;
    expect(prefs.lastNursing.mapValue.fields.duration).toEqual({ doubleValue: 300 });
  });

  it("rejects providing only one side duration", async () => {
    const { client } = makeClient({ parent: null });
    await expect(
      client.logNursing("c1", { start: 1, end: 2, leftDuration: 100 }),
    ).rejects.toThrow(/both leftDuration and rightDuration/);
  });
});

describe("logSolids", () => {
  it("keys foods by id with created_name and updates prefs.lastSolid", async () => {
    const { client, calls } = makeClient({ parent: null });
    await client.logSolids("c1", {
      start: 1000,
      foods: [
        { id: "f1", source: "curated", name: "Banana", amount: "2 tbsp" },
        { id: "f2", source: "custom", name: "Oats" },
      ],
      reaction: "LOVED",
      notes: "messy",
    });

    const writes = writesOf(calls);
    const row = fields(writes[0]);
    expect(row.mode).toEqual({ stringValue: "solids" });
    const foods = row.foods.mapValue.fields;
    expect(foods.f1.mapValue.fields.created_name).toEqual({ stringValue: "Banana" });
    expect(foods.f1.mapValue.fields.amount).toEqual({ stringValue: "2 tbsp" });
    expect(foods.f2.mapValue.fields.amount).toBeUndefined();
    expect(row.reactions.mapValue.fields.LOVED).toEqual({ booleanValue: true });
    expect(row.notes).toEqual({ stringValue: "messy" });

    const url = new URL(writes[1].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")[0]).toBe(
      "prefs.lastSolid",
    );
  });

  it("rejects an empty foods list", async () => {
    const { client } = makeClient({ parent: null });
    await expect(client.logSolids("c1", { foods: [] })).rejects.toThrow(
      /At least one food/,
    );
  });
});
