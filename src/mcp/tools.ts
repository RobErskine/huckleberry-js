/**
 * Shared MCP tool registry — the single source of truth for both transports
 * (local stdio in `stdio.ts`, remote Cloudflare Worker in `worker.ts`).
 *
 * Deliberately framework-free: no `@modelcontextprotocol/sdk` and no `zod`
 * import here, so the Worker build stays as lean as the zero-dependency core.
 * Tool input schemas are plain JSON Schema; the stdio transport feeds them to
 * the SDK's low-level `Server`, the Worker serves them over JSON-RPC directly.
 *
 * Every tool is read-only. Results use a stable envelope:
 *   { data, totalResults?, _next? }   (success)
 *   { error, message, category, retryable, recovery }   (failure)
 */

import { HuckleberryClient } from "../client.js";
import { AuthError, type Session } from "../auth.js";
import {
  ChildNotFoundError,
  HuckleberryError,
  InvalidDateRangeError,
  type StructuredErrorJSON,
} from "../errors.js";
import type { DateRange } from "../types.js";

export const SERVER_NAME = "huckleberry-js";
// Keep in sync with package.json "version".
export const SERVER_VERSION = "0.2.0";

/** A minimal JSON Schema object (object-typed inputs only). */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A follow-up suggestion returned alongside data to guide an LLM caller. */
export interface NextHint {
  tool: string;
  description: string;
}

export interface ToolEnvelope {
  data: unknown;
  totalResults?: number;
  _next?: NextHint[];
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (
    client: HuckleberryClient,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; next?: NextHint[] }>;
}

type Args = Record<string, unknown>;

function invalidInput(message: string): HuckleberryError {
  return new HuckleberryError(message, {
    name: "InvalidInputError",
    category: "invalid_input",
    retryable: false,
    recovery: "Check the tool's input schema and required arguments.",
  });
}

function reqString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw invalidInput(`Missing or invalid "${key}" (expected a non-empty string).`);
  }
  return v;
}

function toRangePoint(v: unknown, key: string): Date | number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new InvalidDateRangeError(
    `"${key}" must be an ISO 8601 datetime string or an epoch-seconds number.`,
  );
}

function reqRange(args: Args): DateRange {
  return {
    start: toRangePoint(args.start, "start"),
    end: toRangePoint(args.end, "end"),
  };
}

const NO_ARGS: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const CID_ARG: JsonSchema = {
  type: "object",
  properties: {
    cid: { type: "string", description: "Child ID, from list_children." },
  },
  required: ["cid"],
  additionalProperties: false,
};

const RANGE_ARGS: JsonSchema = {
  type: "object",
  properties: {
    cid: { type: "string", description: "Child ID, from list_children." },
    start: {
      type: ["string", "number"],
      description: "Range start — ISO 8601 datetime or epoch seconds (inclusive).",
    },
    end: {
      type: ["string", "number"],
      description: "Range end — ISO 8601 datetime or epoch seconds (exclusive).",
    },
  },
  required: ["cid", "start", "end"],
  additionalProperties: false,
};

const RANGE_NEXT: NextHint[] = [
  { tool: "get_child", description: "Look up the child's profile and preferences." },
];

export const TOOLS: McpToolDef[] = [
  {
    name: "get_capabilities",
    description:
      "Discover the data sources and read-only tools this server exposes. Call this first.",
    inputSchema: NO_ARGS,
    handler: async () => ({
      data: {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        readOnly: true,
        dataSources: [
          "user",
          "children",
          "sleep",
          "feed",
          "diapers",
          "activities",
          "pump",
          "health",
        ],
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
      },
      next: [
        { tool: "list_children", description: "List children to obtain a cid." },
      ],
    }),
  },
  {
    name: "get_user",
    description: "Retrieve the signed-in account profile (name, email, children list).",
    inputSchema: NO_ARGS,
    handler: async (client) => ({ data: await client.user.get() }),
  },
  {
    name: "list_children",
    description: "List the children on the account with their child IDs (cid).",
    inputSchema: NO_ARGS,
    handler: async (client) => ({
      data: await client.user.listChildren(),
      next: [
        { tool: "get_child", description: "Get a child's details by cid." },
        { tool: "get_capabilities", description: "See all available tools." },
      ],
    }),
  },
  {
    name: "get_child",
    description: "Retrieve one child's details (name, birthdate, preferences) by cid.",
    inputSchema: CID_ARG,
    handler: async (client, args) => {
      const cid = reqString(args, "cid");
      const child = await client.user.getChild(cid);
      if (!child) throw new ChildNotFoundError(cid);
      return { data: child };
    },
  },
  {
    name: "list_sleep",
    description: "List sleep intervals for a child within a date range.",
    inputSchema: RANGE_ARGS,
    handler: async (client, args) => ({
      data: await client.sleep.list(reqString(args, "cid"), reqRange(args)),
      next: RANGE_NEXT,
    }),
  },
  {
    name: "list_feed",
    description:
      "List feeding records (breast, bottle, or solids) for a child within a date range.",
    inputSchema: RANGE_ARGS,
    handler: async (client, args) => ({
      data: await client.feed.list(reqString(args, "cid"), reqRange(args)),
      next: RANGE_NEXT,
    }),
  },
  {
    name: "list_diapers",
    description: "List diaper and potty events for a child within a date range.",
    inputSchema: RANGE_ARGS,
    handler: async (client, args) => ({
      data: await client.diapers.list(reqString(args, "cid"), reqRange(args)),
      next: RANGE_NEXT,
    }),
  },
  {
    name: "list_activities",
    description:
      "List activity records (bath, tummy time, story time, screen time, …) within a date range.",
    inputSchema: RANGE_ARGS,
    handler: async (client, args) => ({
      data: await client.activities.list(reqString(args, "cid"), reqRange(args)),
      next: RANGE_NEXT,
    }),
  },
  {
    name: "list_pump",
    description: "List pump sessions for a child within a date range.",
    inputSchema: RANGE_ARGS,
    handler: async (client, args) => ({
      data: await client.pump.list(reqString(args, "cid"), reqRange(args)),
      next: RANGE_NEXT,
    }),
  },
  {
    name: "list_health",
    description:
      "List health records (growth measurements, etc.) for a child within a date range.",
    inputSchema: RANGE_ARGS,
    handler: async (client, args) => ({
      data: await client.health.list(reqString(args, "cid"), reqRange(args)),
      next: [
        { tool: "get_latest_growth", description: "Just the most recent growth entry." },
      ],
    }),
  },
  {
    name: "get_latest_growth",
    description: "Get the most recent growth measurement (weight/height/head) for a child.",
    inputSchema: CID_ARG,
    handler: async (client, args) => ({
      data: await client.health.getLatestGrowth(reqString(args, "cid")),
    }),
  },
];

/** Tool metadata for an MCP `tools/list` response. */
export function toolList(): Array<Pick<McpToolDef, "name" | "description" | "inputSchema">> {
  return TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export type ToolRunResult =
  | { ok: true; result: ToolEnvelope }
  | { ok: false; error: StructuredErrorJSON };

/** Run a tool by name, returning the success or structured-error envelope. */
export async function runTool(
  client: HuckleberryClient,
  name: string,
  args: Args = {},
): Promise<ToolRunResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      ok: false,
      error: {
        error: "ToolNotFound",
        message: `Unknown tool: ${name}`,
        category: "invalid_input",
        retryable: false,
        recovery: "Call get_capabilities to list the available tools.",
      },
    };
  }
  try {
    const { data, next } = await tool.handler(client, args);
    const envelope: ToolEnvelope = { data };
    if (Array.isArray(data)) envelope.totalResults = data.length;
    if (next?.length) envelope._next = next;
    return { ok: true, result: envelope };
  } catch (err) {
    if (err instanceof HuckleberryError) return { ok: false, error: err.toJSON() };
    return {
      ok: false,
      error: {
        error: "UnexpectedError",
        message: err instanceof Error ? err.message : String(err),
        category: "api",
        retryable: false,
        recovery: "",
      },
    };
  }
}

export interface CreateClientOptions {
  fetch?: typeof fetch;
  session?: Session;
  onSession?: (session: Session) => void | Promise<void>;
}

/**
 * Build an authenticated client from credentials. Skips sign-in when a
 * persisted `session` is supplied (e.g. a Worker rehydrating from KV).
 */
export async function createHuckleberryClient(
  creds: { email?: string; password?: string },
  opts: CreateClientOptions = {},
): Promise<HuckleberryClient> {
  const client = new HuckleberryClient({
    fetch: opts.fetch,
    session: opts.session,
    onSession: opts.onSession,
  });
  if (!opts.session) {
    if (!creds.email || !creds.password) {
      throw new AuthError(
        "Missing credentials: set HUCKLEBERRY_EMAIL and HUCKLEBERRY_PASSWORD.",
        401,
        "",
      );
    }
    await client.authenticate(creds.email, creds.password);
  }
  return client;
}
