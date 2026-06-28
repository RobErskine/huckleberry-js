import { describe, expect, it } from "vitest";
import { HuckleberryClient } from "../src/client.js";
import { encodeFields } from "../src/firestore.js";

type Call = { method: string; url: string; body?: unknown };

/**
 * Build a client whose fetch distinguishes three call types:
 *   - Firebase Storage GET  → returns `storageMock` (plain JSON)
 *   - Firestore :runQuery   → returns encoded Firestore documents built from `queryMock`
 *   - Everything else       → returns `{ fields: {} }` (PATCH / GET success)
 */
function makeClient(opts: {
  storageMock?: unknown;
  queryMock?: Record<string, unknown>[];
} = {}) {
  const calls: Call[] = [];

  const fetchMock = (async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });

    if (String(url).startsWith("https://firebasestorage.googleapis.com")) {
      return new Response(JSON.stringify(opts.storageMock ?? {}), { status: 200 });
    }

    if (method === "POST" && String(url).includes(":runQuery")) {
      const docs = (opts.queryMock ?? []).map((doc) => ({
        document: { fields: encodeFields(doc) },
      }));
      return new Response(JSON.stringify(docs), { status: 200 });
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

// ---------------------------------------------------------------------------
// listSolidsCuratedFoods
// ---------------------------------------------------------------------------

describe("listSolidsCuratedFoods", () => {
  const STORAGE_PAYLOAD = {
    cherry: { id: "cherry", name: "Cherry", source: "curated", rank: null },
    apple: { id: "apple", name: "Apple", source: "curated", rank: 1 },
    banana: { id: "banana", name: "Banana", source: "curated", rank: 2 },
    avocado: { id: "avocado", name: "Avocado", source: "curated", rank: 1 },
  };

  it("fetches from Firebase Storage (not Firestore)", async () => {
    const { client, calls } = makeClient({ storageMock: STORAGE_PAYLOAD });
    await client.listSolidsCuratedFoods();
    const storageCall = calls.find((c) =>
      c.url.includes("firebasestorage.googleapis.com"),
    );
    expect(storageCall).toBeDefined();
    expect(storageCall!.url).toContain("foods%2Ffooddb.json");
    expect(storageCall!.url).toContain("alt=media");
  });

  it("sorts by rank ascending (nulls last), then name ascending", async () => {
    const { client } = makeClient({ storageMock: STORAGE_PAYLOAD });
    const foods = await client.listSolidsCuratedFoods();
    const names = foods.map((f) => f.name);
    // rank 1: Apple, Avocado (alpha); rank 2: Banana; null → last: Cherry
    expect(names).toEqual(["Apple", "Avocado", "Banana", "Cherry"]);
  });

  it("unwraps the dict values into an array", async () => {
    const { client } = makeClient({ storageMock: STORAGE_PAYLOAD });
    const foods = await client.listSolidsCuratedFoods();
    expect(foods).toHaveLength(4);
    expect(foods[0]).toMatchObject({ id: "apple", source: "curated" });
  });

  it("returns empty array for empty payload", async () => {
    const { client } = makeClient({ storageMock: {} });
    const foods = await client.listSolidsCuratedFoods();
    expect(foods).toEqual([]);
  });

  it("delegates from feed.foods namespace", async () => {
    const { client } = makeClient({ storageMock: { x: { id: "x", name: "X", source: "curated" } } });
    const foods = await client.feed.foods.listCurated();
    expect(foods).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// listSolidsCustomFoods
// ---------------------------------------------------------------------------

describe("listSolidsCustomFoods", () => {
  const CUSTOM_FOODS: Record<string, unknown>[] = [
    {
      id: "f1",
      name: "Home Oats",
      archived: false,
      type: "solids",
      source: "custom",
      image: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "f2",
      name: "Old Peas",
      archived: true,
      type: "solids",
      source: "custom",
      image: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
    },
    {
      id: "f3",
      name: "Recent Rice",
      archived: false,
      type: "solids",
      source: "custom",
      image: "",
      created_at: "2026-02-01T00:00:00.000Z",
      updated_at: "2026-06-15T00:00:00.000Z",
    },
  ];

  it("queries types/{cid}/custom with type=solids filter", async () => {
    const { client, calls } = makeClient({ queryMock: CUSTOM_FOODS });
    await client.listSolidsCustomFoods("c1");
    const qCall = calls.find((c) => c.method === "POST" && c.url.includes(":runQuery"));
    expect(qCall).toBeDefined();
    expect(qCall!.url).toBe("https://fs.test/types/c1:runQuery");
    const q = (qCall!.body as { structuredQuery: { where: { fieldFilter: { value: { stringValue: string } } } } })
      .structuredQuery.where.fieldFilter.value.stringValue;
    expect(q).toBe("solids");
  });

  it("excludes archived by default", async () => {
    const { client } = makeClient({ queryMock: CUSTOM_FOODS });
    const foods = await client.listSolidsCustomFoods("c1");
    expect(foods.map((f) => f.id)).not.toContain("f2");
    expect(foods).toHaveLength(2);
  });

  it("includes archived when opted in", async () => {
    const { client } = makeClient({ queryMock: CUSTOM_FOODS });
    const foods = await client.listSolidsCustomFoods("c1", { includeArchived: true });
    expect(foods).toHaveLength(3);
    expect(foods.some((f) => f.id === "f2")).toBe(true);
  });

  it("sorts by updated_at descending", async () => {
    const { client } = makeClient({ queryMock: CUSTOM_FOODS });
    const foods = await client.listSolidsCustomFoods("c1");
    expect(foods[0].id).toBe("f3"); // 2026-06-15 is newest
    expect(foods[1].id).toBe("f1"); // 2026-06-01
  });

  it("delegates from feed.foods namespace", async () => {
    const { client } = makeClient({ queryMock: CUSTOM_FOODS });
    const foods = await client.feed.foods.listCustom("c1");
    expect(foods).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createSolidsCustomFood
// ---------------------------------------------------------------------------

describe("createSolidsCustomFood", () => {
  it("writes two PATCHes: available_types merge then full doc set", async () => {
    const { client, calls } = makeClient();
    const doc = await client.createSolidsCustomFood("c1", "Mango");

    const patches = patchCalls(calls);
    expect(patches).toHaveLength(2);

    // First PATCH: merge-update types/c1 with available_types.solids
    const merge = patches[0];
    const mergeUrl = new URL(merge.url);
    expect(mergeUrl.pathname).toBe("/types/c1");
    expect(mergeUrl.searchParams.getAll("updateMask.fieldPaths")).toContain(
      "available_types.solids",
    );
    const mergeBody = merge.body as { fields: { available_types: { mapValue: { fields: { solids: { booleanValue: boolean } } } } } };
    expect(mergeBody.fields.available_types.mapValue.fields.solids).toEqual({
      booleanValue: true,
    });

    // Second PATCH: full set to types/c1/custom/{uuid}
    const setCall = patches[1];
    expect(setCall.url).toMatch(
      new RegExp(`^https://fs\\.test/types/c1/custom/${doc.id}$`),
    );
    expect(setCall.url).not.toContain("updateMask");
    const setBody = setCall.body as { fields: { name: { stringValue: string }; archived: { booleanValue: boolean }; type: { stringValue: string }; source: { stringValue: string } } };
    expect(setBody.fields.name.stringValue).toBe("Mango");
    expect(setBody.fields.archived.booleanValue).toBe(false);
    expect(setBody.fields.type.stringValue).toBe("solids");
    expect(setBody.fields.source.stringValue).toBe("custom");
  });

  it("returns the created doc with correct shape", async () => {
    const { client } = makeClient();
    const doc = await client.createSolidsCustomFood("c1", "  Banana  ", "banana.jpeg");
    expect(doc.name).toBe("Banana"); // trimmed
    expect(doc.image).toBe("banana.jpeg");
    expect(doc.archived).toBe(false);
    expect(doc.type).toBe("solids");
    expect(doc.source).toBe("custom");
    expect(doc.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(doc.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws on empty name", async () => {
    const { client } = makeClient();
    await expect(client.createSolidsCustomFood("c1", "   ")).rejects.toThrow(
      /non-empty/,
    );
  });

  it("delegates from feed.foods namespace", async () => {
    const { client, calls } = makeClient();
    await client.feed.foods.createCustom("c1", "Pear");
    expect(patchCalls(calls)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// setCustomFoodArchived
// ---------------------------------------------------------------------------

describe("setCustomFoodArchived", () => {
  it("PATCHes types/{cid}/custom/{foodId} with masked archived + updated_at fields", async () => {
    const { client, calls } = makeClient();
    await client.setCustomFoodArchived("c1", "f1", true);

    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    const p = patches[0];
    const url = new URL(p.url);
    expect(url.pathname).toBe("/types/c1/custom/f1");
    const mask = url.searchParams.getAll("updateMask.fieldPaths");
    expect(mask).toContain("archived");
    expect(mask).toContain("updated_at");
    const body = p.body as { fields: { archived: { booleanValue: boolean }; updated_at: { stringValue: string } } };
    expect(body.fields.archived.booleanValue).toBe(true);
    expect(body.fields.updated_at.stringValue).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("can un-archive (archived=false)", async () => {
    const { client, calls } = makeClient();
    await client.setCustomFoodArchived("c1", "f1", false);
    const p = patchCalls(calls)[0];
    const body = p.body as { fields: { archived: { booleanValue: boolean } } };
    expect(body.fields.archived.booleanValue).toBe(false);
  });

  it("delegates from feed.foods namespace", async () => {
    const { client, calls } = makeClient();
    await client.feed.foods.setArchived("c1", "f1", true);
    expect(patchCalls(calls)).toHaveLength(1);
  });
});
