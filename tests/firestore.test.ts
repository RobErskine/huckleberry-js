import { describe, expect, it } from "vitest";
import {
  buildMultiQuery,
  buildStartRangeQuery,
  decodeDocument,
  decodeFields,
  decodeValue,
  DELETE_FIELD,
  encodeFields as encode,
  encodeValue as encodeOne,
  FirestoreRest,
  int,
  listIntervals,
  type FirestoreValue,
} from "../src/firestore.js";

describe("decodeValue", () => {
  it("decodes scalars", () => {
    expect(decodeValue({ stringValue: "hi" })).toBe("hi");
    expect(decodeValue({ booleanValue: true })).toBe(true);
    expect(decodeValue({ doubleValue: 1.5 })).toBe(1.5);
    expect(decodeValue({ nullValue: null })).toBe(null);
  });

  it("decodes integerValue (a JSON string) to a number", () => {
    expect(decodeValue({ integerValue: "1700000000" })).toBe(1700000000);
  });

  it("decodes nested maps and arrays", () => {
    const v: FirestoreValue = {
      mapValue: {
        fields: {
          start: { doubleValue: 100 },
          tags: {
            arrayValue: {
              values: [{ stringValue: "a" }, { stringValue: "b" }],
            },
          },
        },
      },
    };
    expect(decodeValue(v)).toEqual({ start: 100, tags: ["a", "b"] });
  });
});

describe("decodeDocument", () => {
  it("returns null for a doc with no fields", () => {
    expect(decodeDocument(undefined)).toBeNull();
    expect(decodeDocument({})).toBeNull();
  });

  it("decodes a document's fields", () => {
    expect(
      decodeDocument({
        fields: { mode: { stringValue: "breast" }, start: { integerValue: "5" } },
      }),
    ).toEqual({ mode: "breast", start: 5 });
  });
});

describe("buildStartRangeQuery", () => {
  it("builds an AND composite for a two-sided range, ordered by start", () => {
    const q = buildStartRangeQuery({
      collectionId: "intervals",
      startTs: 100,
      endTs: 200,
    }) as any;
    expect(q.from).toEqual([{ collectionId: "intervals" }]);
    expect(q.where.compositeFilter.op).toBe("AND");
    expect(q.where.compositeFilter.filters).toHaveLength(2);
    expect(q.orderBy[0]).toEqual({
      field: { fieldPath: "start" },
      direction: "ASCENDING",
    });
  });

  it("supports a descending limit-1 'latest' query with no filter", () => {
    const q = buildStartRangeQuery({
      collectionId: "intervals",
      orderDirection: "DESCENDING",
      limit: 1,
    }) as any;
    expect(q.where).toBeUndefined();
    expect(q.limit).toBe(1);
    expect(q.orderBy[0].direction).toBe("DESCENDING");
  });
});

describe("buildMultiQuery", () => {
  it("filters multi == true", () => {
    const q = buildMultiQuery("intervals") as any;
    expect(q.where.fieldFilter).toEqual({
      field: { fieldPath: "multi" },
      op: "EQUAL",
      value: { booleanValue: true },
    });
  });
});

// --- listIntervals: regular docs + multi-container expansion + range filter ---

function encodeFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, val] of Object.entries(obj)) {
    fields[k] = encodeValue(val);
  }
  return fields;
}

function encodeValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") return { doubleValue: val };
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(val as Record<string, unknown>) } };
}

function runQueryResponse(docs: Array<Record<string, unknown>>) {
  return docs.map((d) => ({ document: { fields: encodeFields(d) } }));
}

describe("listIntervals", () => {
  it("merges regular + multi entries, filters by range, sorts by start", async () => {
    const regular = [
      { start: 150, mode: "a" },
      { start: 120, mode: "b" },
    ];
    const multiContainer = {
      multi: true,
      data: {
        x: { start: 110, mode: "old-in-range" },
        y: { start: 250, mode: "out-of-range" }, // excluded (>= endTs)
        z: { start: 50, mode: "too-old" }, // excluded (< startTs)
      },
    };

    const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      const isMulti =
        body.structuredQuery?.where?.fieldFilter?.field?.fieldPath === "multi";
      const payload = isMulti
        ? runQueryResponse([multiContainer])
        : runQueryResponse(regular);
      return new Response(JSON.stringify(payload), { status: 200 });
    };

    const fs = new FirestoreRest(
      async () => "fake-token",
      fetchMock as unknown as typeof fetch,
    );

    const rows = await listIntervals<{ start: number; mode: string }>(
      fs,
      "sleep/child1",
      "intervals",
      100,
      200,
    );

    expect(rows.map((r) => r.start)).toEqual([110, 120, 150]);
    expect(rows.map((r) => r.mode)).toEqual(["old-in-range", "b", "a"]);
  });
});

// --- encodeValue / encodeFields (the inverse of decodeValue) ---

describe("encodeValue / encodeFields", () => {
  it("encodes scalars; numbers default to doubleValue", () => {
    expect(encodeOne(1.5)).toEqual({ doubleValue: 1.5 });
    expect(encodeOne(100)).toEqual({ doubleValue: 100 });
    expect(encodeOne("hi")).toEqual({ stringValue: "hi" });
    expect(encodeOne(true)).toEqual({ booleanValue: true });
  });

  it("emits integerValue (a JSON string) for int()", () => {
    expect(encodeOne(int(1700000000))).toEqual({ integerValue: "1700000000" });
  });

  it("encodes Date as epoch seconds (doubleValue)", () => {
    expect(encodeOne(new Date(1700000000000))).toEqual({ doubleValue: 1700000000 });
  });

  it("omits null/undefined keys, but keeps null array elements", () => {
    expect(encode({ a: 1, b: null, c: undefined })).toEqual({
      a: { doubleValue: 1 },
    });
    expect(encodeOne([1, null])).toEqual({
      arrayValue: { values: [{ doubleValue: 1 }, { nullValue: null }] },
    });
  });

  it("round-trips nested maps and arrays back through decode", () => {
    const obj = {
      start: 1.5,
      tags: ["a", "b"],
      nested: { x: 2, y: "z" },
      keepInt: int(7),
    };
    expect(decodeFields(encode(obj))).toEqual({
      start: 1.5,
      tags: ["a", "b"],
      nested: { x: 2, y: "z" },
      keepInt: 7,
    });
  });

  it("throws on non-finite numbers and unsupported types", () => {
    expect(() => encodeOne(NaN)).toThrow();
    expect(() => encodeOne(Infinity)).toThrow();
    expect(() => encodeOne(() => 1)).toThrow();
  });
});

// --- FirestoreRest write ops: assert exact method / URL / mask / body ---

function captureFetch() {
  const calls: Array<{ url: string; method?: string; body: any }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ fields: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("FirestoreRest writes", () => {
  it("setDoc PATCHes the path with encoded fields and no updateMask", async () => {
    const { calls, fetchImpl } = captureFetch();
    const fs = new FirestoreRest(async () => "tok", fetchImpl, "https://fs.test");
    await fs.setDoc("diaper/c1/intervals/abc", { mode: "pee", start: 100 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("https://fs.test/diaper/c1/intervals/abc");
    expect(calls[0].body).toEqual({
      fields: { mode: { stringValue: "pee" }, start: { doubleValue: 100 } },
    });
  });

  it("createDoc builds the {parent}/{collection}/{id} path", async () => {
    const { calls, fetchImpl } = captureFetch();
    const fs = new FirestoreRest(async () => "tok", fetchImpl, "https://fs.test");
    await fs.createDoc("diaper/c1", "intervals", "id9", { mode: "poo" });
    expect(calls[0].url).toBe("https://fs.test/diaper/c1/intervals/id9");
  });

  it("updateFields sends dotted updateMask paths with a nested body", async () => {
    const { calls, fetchImpl } = captureFetch();
    const fs = new FirestoreRest(async () => "tok", fetchImpl, "https://fs.test");
    await fs.updateFields("diaper/c1", {
      "prefs.lastDiaper": { start: 100, mode: "pee" },
      "prefs.local_timestamp": 100,
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/diaper/c1");
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toEqual([
      "prefs.lastDiaper",
      "prefs.local_timestamp",
    ]);
    const prefs = calls[0].body.fields.prefs.mapValue.fields;
    expect(prefs.lastDiaper.mapValue.fields).toEqual({
      start: { doubleValue: 100 },
      mode: { stringValue: "pee" },
    });
    expect(prefs.local_timestamp).toEqual({ doubleValue: 100 });
  });

  it("updateFields with DELETE_FIELD names the path in the mask but omits it from the body", async () => {
    const { calls, fetchImpl } = captureFetch();
    const fs = new FirestoreRest(async () => "tok", fetchImpl, "https://fs.test");
    await fs.updateFields("feed/c1", {
      "timer.paused": true,
      "timer.activeSide": DELETE_FIELD,
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toEqual([
      "timer.paused",
      "timer.activeSide",
    ]);
    const timer = calls[0].body.fields.timer.mapValue.fields;
    expect(timer.paused).toEqual({ booleanValue: true });
    expect(timer.activeSide).toBeUndefined();
  });

  it("throws FirestoreError on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response("denied", { status: 403 })) as unknown as typeof fetch;
    const fs = new FirestoreRest(async () => "tok", fetchImpl, "https://fs.test");
    await expect(fs.setDoc("x/y", { a: 1 })).rejects.toThrow();
  });
});
