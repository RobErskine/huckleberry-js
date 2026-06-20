/**
 * Minimal Firestore REST client (works on Cloudflare Workers, Node 18+, browsers).
 *
 * The Python client used the gRPC Firestore SDK, which cannot run on Workers.
 * Firestore's REST API accepts the same Firebase ID token and enforces the same
 * security rules, so this `fetch`-based port reads the user's own data the same
 * way the official SDK does.
 *
 * REST returns documents as typed-value JSON (e.g. `{ "fields": { "start":
 * { "doubleValue": 1.7e9 } } }`); these helpers convert to/from plain JS.
 */

import { FIRESTORE_BASE_URL } from "./const.js";
import { HuckleberryError } from "./errors.js";

export type FetchLike = typeof fetch;

/** A raw Firestore typed value, as returned by the REST API. */
export interface FirestoreValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  stringValue?: string;
  bytesValue?: string;
  referenceValue?: string;
  geoPointValue?: { latitude: number; longitude: number };
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
}

export interface FirestoreDocument {
  name?: string;
  fields?: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
}

/** Error thrown when Firestore returns a non-2xx response. */
export class FirestoreError extends HuckleberryError {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message, {
      name: "FirestoreError",
      // 5xx (and 429) are worth retrying; 4xx generally are not.
      category: "api",
      retryable: status >= 500 || status === 429,
      recovery:
        status === 401 || status === 403
          ? "The ID token may be expired or lacks access — re-authenticate, then retry."
          : "Retry shortly. If it persists, Huckleberry's backend may have changed.",
    });
  }
}

/** Convert a single Firestore typed value to a plain JS value. */
export function decodeValue(value: FirestoreValue): unknown {
  if (value == null) return null;
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("stringValue" in value) return value.stringValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value) {
    return (value.arrayValue?.values ?? []).map(decodeValue);
  }
  if ("mapValue" in value) {
    return decodeFields(value.mapValue?.fields ?? {});
  }
  return null;
}

/** Convert a Firestore `fields` map to a plain JS object. */
export function decodeFields(
  fields: Record<string, FirestoreValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = decodeValue(value);
  }
  return out;
}

/** Convert a whole document to a plain JS object (or null if it has no fields). */
export function decodeDocument(
  doc: FirestoreDocument | undefined,
): Record<string, unknown> | null {
  if (!doc || !doc.fields) return null;
  return decodeFields(doc.fields);
}

/** A run-query element as returned by the `:runQuery` REST endpoint. */
interface RunQueryElement {
  document?: FirestoreDocument;
  readTime?: string;
  skippedResults?: number;
  done?: boolean;
}

export type Direction = "ASCENDING" | "DESCENDING";

export interface RangeQueryOptions {
  collectionId: string;
  /** Inclusive lower bound on `start` (epoch seconds). */
  startTs?: number;
  /** Exclusive upper bound on `start` (epoch seconds). */
  endTs?: number;
  orderDirection?: Direction;
  limit?: number;
}

/** Build a `structuredQuery` that filters a numeric `start` field by range. */
export function buildStartRangeQuery(opts: RangeQueryOptions): object {
  const filters: object[] = [];
  if (opts.startTs !== undefined) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: "start" },
        op: "GREATER_THAN_OR_EQUAL",
        value: { doubleValue: opts.startTs },
      },
    });
  }
  if (opts.endTs !== undefined) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: "start" },
        op: "LESS_THAN",
        value: { doubleValue: opts.endTs },
      },
    });
  }

  const query: Record<string, unknown> = {
    from: [{ collectionId: opts.collectionId }],
    orderBy: [
      {
        field: { fieldPath: "start" },
        direction: opts.orderDirection ?? "ASCENDING",
      },
    ],
  };
  if (filters.length === 1) {
    query.where = filters[0];
  } else if (filters.length > 1) {
    query.where = { compositeFilter: { op: "AND", filters } };
  }
  if (opts.limit !== undefined) query.limit = opts.limit;
  return query;
}

/** Build a `structuredQuery` that selects the batched `multi == true` docs. */
export function buildMultiQuery(collectionId: string): object {
  return {
    from: [{ collectionId }],
    where: {
      fieldFilter: {
        field: { fieldPath: "multi" },
        op: "EQUAL",
        value: { booleanValue: true },
      },
    },
  };
}

/** Provides a currently-valid Firebase ID token (refreshing as needed). */
export type TokenProvider = () => Promise<string>;

/** Thin Firestore REST wrapper bound to a token provider + fetch impl. */
export class FirestoreRest {
  constructor(
    private readonly getToken: TokenProvider,
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string = FIRESTORE_BASE_URL,
  ) {}

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.getToken()}`,
      "Content-Type": "application/json",
    };
  }

  /** GET a document. Returns the decoded object, or null if it doesn't exist. */
  async getDoc(path: string): Promise<Record<string, unknown> | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      headers: await this.authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new FirestoreError(
        `Firestore getDoc ${path} failed: HTTP ${res.status}`,
        res.status,
        await res.text(),
      );
    }
    const doc = (await res.json()) as FirestoreDocument;
    return decodeDocument(doc);
  }

  /**
   * Run a structured query against the subcollection of a parent document.
   * `parentPath` is the parent doc, e.g. `sleep/{cid}`; the query's `from`
   * names the subcollection, e.g. `intervals`.
   */
  async runQuery(
    parentPath: string,
    structuredQuery: object,
  ): Promise<Array<Record<string, unknown>>> {
    const res = await this.fetchImpl(`${this.baseUrl}/${parentPath}:runQuery`, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) {
      throw new FirestoreError(
        `Firestore runQuery ${parentPath} failed: HTTP ${res.status}`,
        res.status,
        await res.text(),
      );
    }
    const elements = (await res.json()) as RunQueryElement[];
    const docs: Array<Record<string, unknown>> = [];
    for (const el of elements) {
      const decoded = decodeDocument(el.document);
      if (decoded) docs.push(decoded);
    }
    return docs;
  }
}

/** A batched multi-entry interval container: `{ multi: true, data: {...} }`. */
interface MultiContainer {
  multi?: boolean;
  data?: Record<string, { start?: number } & Record<string, unknown>>;
}

/**
 * Fetch every interval row in a subcollection for a time range, expanding the
 * batched `multi: true` containers — mirrors the two-query approach in the
 * Python client (`list_*_intervals`). Returns rows sorted ascending by start.
 */
export async function listIntervals<T extends { start: number }>(
  fs: FirestoreRest,
  parentPath: string,
  collectionId: string,
  startTs: number,
  endTs: number,
): Promise<T[]> {
  const out: T[] = [];

  // Query 1: regular docs filtered by the indexed top-level `start` field.
  const regular = await fs.runQuery(
    parentPath,
    buildStartRangeQuery({ collectionId, startTs, endTs }),
  );
  for (const data of regular) {
    if (data.multi) continue; // multi containers have no top-level `start`
    out.push(data as unknown as T);
  }

  // Query 2: multi-entry containers (can't range-filter the nested `start`).
  const multi = await fs.runQuery(parentPath, buildMultiQuery(collectionId));
  for (const container of multi as MultiContainer[]) {
    if (!container.data) continue;
    for (const entry of Object.values(container.data)) {
      const start = entry.start;
      if (typeof start !== "number") continue;
      if (start >= startTs && start < endTs) out.push(entry as unknown as T);
    }
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}
