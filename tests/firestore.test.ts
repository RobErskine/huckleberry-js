import { describe, expect, it } from "vitest";
import {
  buildMultiQuery,
  buildStartRangeQuery,
  decodeDocument,
  decodeValue,
  FirestoreRest,
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
