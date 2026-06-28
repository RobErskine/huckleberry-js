/**
 * Shared MCP tool registry — the single source of truth for both transports
 * (local stdio in `stdio.ts`, remote Cloudflare Worker in `worker.ts`).
 *
 * Deliberately framework-free: no `@modelcontextprotocol/sdk` and no `zod`
 * import here, so the Worker build stays lean. Tool input schemas are plain
 * JSON Schema; the stdio transport feeds them to the SDK, the Worker serves
 * them over JSON-RPC directly.
 *
 * Write tools are hidden and gated unless `writesEnabled = true` (controlled
 * by the `HUCKLEBERRY_ENABLE_WRITES` environment variable). Results use a
 * stable envelope:
 *   { data, totalResults?, _next? }                              (success)
 *   { error, message, category, retryable, recovery }           (failure)
 */

import { HuckleberryClient } from "../client.js";
import { AuthError, type Session } from "../auth.js";
import {
  ChildNotFoundError,
  HuckleberryError,
  InvalidDateRangeError,
  InvalidInputError,
  WritesDisabledError,
  type StructuredErrorJSON,
} from "../errors.js";
import type { DateRange, SolidsFoodSource } from "../types.js";

export const SERVER_NAME = "huckleberry-js";
// Keep in sync with package.json "version".
export const SERVER_VERSION = "0.3.0";

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

/** Optional annotations propagated to MCP clients for UI hints. */
export interface ToolAnnotations {
  /** True = no side effects; false = writes data. */
  readOnlyHint?: boolean;
  /** True = writes are hard to undo (cancel/complete timer). */
  destructiveHint?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  handler: (
    client: HuckleberryClient,
    args: Record<string, unknown>,
    ctx?: { writesEnabled: boolean },
  ) => Promise<{ data: unknown; next?: NextHint[] }>;
}

type Args = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function invalidInput(message: string): InvalidInputError {
  return new InvalidInputError(message, "Check the tool's input schema and required arguments.");
}

function reqString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw invalidInput(`Missing or invalid "${key}" (expected a non-empty string).`);
  }
  return v;
}

function optString(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalidInput(`Invalid "${key}" (expected a string).`);
  return v || undefined;
}

function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return Boolean(v);
}

function reqNumber(args: Args, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw invalidInput(`Missing or invalid "${key}" (expected a finite number).`);
  }
  return v;
}

function optNumber(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw invalidInput(`Invalid "${key}" (expected a finite number).`);
  }
  return v;
}

function optEnum<T extends string>(
  args: Args,
  key: string,
  values: readonly T[],
): T | undefined {
  const v = optString(args, key);
  if (v === undefined) return undefined;
  if (!values.includes(v as T)) {
    throw invalidInput(`Invalid "${key}": must be one of ${values.join(", ")}.`);
  }
  return v as T;
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

function optTimestamp(args: Args, key: string): Date | number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return toRangePoint(v, key);
}

function optDryRun(args: Args): boolean {
  return args.dryRun === true;
}

// ---------------------------------------------------------------------------
// Reusable schema fragments
// ---------------------------------------------------------------------------

const NO_ARGS: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const CID_ARG: JsonSchema = {
  type: "object",
  properties: {
    cid: { type: "string", description: "Child ID (from list_children)." },
  },
  required: ["cid"],
  additionalProperties: false,
};

const RANGE_ARGS: JsonSchema = {
  type: "object",
  properties: {
    cid: { type: "string", description: "Child ID (from list_children)." },
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

const TIMESTAMP_PROP = {
  type: ["string", "number"],
  description: "When it happened — ISO 8601 datetime (e.g. \"2026-06-27T14:30:00Z\") or epoch seconds. Omit for now.",
} as const;

const DRY_RUN_PROP = {
  type: "boolean",
  description: "When true, returns the planned writes without committing (preview). Default: false.",
} as const;

/** Build a write-tool JSON Schema: always includes cid + dryRun. */
function writeSchema(
  extraProps: Record<string, unknown>,
  required: string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties: {
      cid: { type: "string", description: "Child ID (from list_children)." },
      ...extraProps,
      dryRun: DRY_RUN_PROP,
    },
    required: ["cid", ...required],
    additionalProperties: false,
  };
}

const RANGE_NEXT: NextHint[] = [
  { tool: "get_child", description: "Look up the child's profile and preferences." },
];

// ---------------------------------------------------------------------------
// Tools registry
// ---------------------------------------------------------------------------

export const TOOLS: McpToolDef[] = [
  // ── Read tools ────────────────────────────────────────────────────────────

  {
    name: "get_capabilities",
    description:
      "Discover data sources and tools this server exposes. Call this first to understand what's available and whether writes are enabled.",
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true },
    handler: async (_client, _args, ctx) => {
      const writesEnabled = ctx?.writesEnabled ?? false;
      return {
        data: {
          server: SERVER_NAME,
          version: SERVER_VERSION,
          readOnly: !writesEnabled,
          writesEnabled,
          note: writesEnabled
            ? "Write tools are enabled. Use dryRun:true on any write tool to preview before committing."
            : "Write tools are hidden (HUCKLEBERRY_ENABLE_WRITES not set).",
          tools: visibleTools(writesEnabled).map((t) => ({
            name: t.name,
            description: t.description,
            readOnly: t.annotations?.readOnlyHint !== false,
          })),
        },
        next: [
          { tool: "list_children", description: "List children to obtain a cid." },
        ],
      };
    },
  },

  {
    name: "get_user",
    description: "Retrieve the signed-in account profile (name, email, children list).",
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true },
    handler: async (client) => ({ data: await client.user.get() }),
  },

  {
    name: "list_children",
    description: "List the children on the account with their child IDs (cid).",
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const cid = reqString(args, "cid");
      const child = await client.user.getChild(cid);
      if (!child) throw new ChildNotFoundError(cid);
      return { data: child };
    },
  },

  {
    name: "get_sleep",
    description:
      "Get the current sleep document for a child: live timer state (active, paused, timerStartTime in ms) and prefs.lastSleep summary.",
    inputSchema: CID_ARG,
    annotations: { readOnlyHint: true },
    handler: async (client, args) => ({
      data: await client.getSleep(reqString(args, "cid")),
      next: [
        { tool: "list_sleep", description: "List historical sleep intervals." },
      ],
    }),
  },

  {
    name: "list_sleep",
    description: "List sleep intervals for a child within a date range.",
    inputSchema: RANGE_ARGS,
    annotations: { readOnlyHint: true },
    handler: async (client, args) => ({
      data: await client.sleep.list(reqString(args, "cid"), reqRange(args)),
      next: RANGE_NEXT,
    }),
  },

  {
    name: "get_feed",
    description:
      "Get the current feed document for a child: live nursing timer state (active, paused, feedStartTime, left/rightDuration) and prefs.lastNursing/lastBottle/lastSolid summaries.",
    inputSchema: CID_ARG,
    annotations: { readOnlyHint: true },
    handler: async (client, args) => ({
      data: await client.getFeed(reqString(args, "cid")),
      next: [
        { tool: "list_feed", description: "List historical feed intervals." },
      ],
    }),
  },

  {
    name: "list_feed",
    description:
      "List feeding records (breast, bottle, or solids) for a child within a date range.",
    inputSchema: RANGE_ARGS,
    annotations: { readOnlyHint: true },
    handler: async (client, args) => ({
      data: await client.feed.list(reqString(args, "cid"), reqRange(args)),
      next: RANGE_NEXT,
    }),
  },

  {
    name: "list_diapers",
    description: "List diaper and potty events for a child within a date range.",
    inputSchema: RANGE_ARGS,
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
    handler: async (client, args) => ({
      data: await client.activities.list(reqString(args, "cid"), reqRange(args)),
      next: RANGE_NEXT,
    }),
  },

  {
    name: "list_pump",
    description: "List pump sessions for a child within a date range.",
    inputSchema: RANGE_ARGS,
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
    handler: async (client, args) => ({
      data: await client.health.getLatestGrowth(reqString(args, "cid")),
    }),
  },

  {
    name: "list_curated_foods",
    description:
      "List all curated solids foods from the Huckleberry food database, sorted by rank then name. Use the returned id+source when calling log_solids.",
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true },
    handler: async (client) => ({
      data: await client.listSolidsCuratedFoods(),
    }),
  },

  {
    name: "list_custom_foods",
    description:
      "List custom solids foods created for a child. Archived foods excluded by default. Use the returned id+source when calling log_solids.",
    inputSchema: {
      type: "object",
      properties: {
        cid: { type: "string", description: "Child ID (from list_children)." },
        includeArchived: { type: "boolean", description: "Include archived foods. Default: false." },
      },
      required: ["cid"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => ({
      data: await client.listSolidsCustomFoods(reqString(args, "cid"), {
        includeArchived: optBool(args, "includeArchived"),
      }),
    }),
  },

  // ── Write tools: single-shot log methods ──────────────────────────────────

  {
    name: "log_diaper",
    description:
      "Log a diaper change. Records the event and updates the lastDiaper summary. mode is required (pee/poo/both/dry); all other fields are optional.",
    inputSchema: writeSchema(
      {
        mode: {
          type: "string",
          enum: ["pee", "poo", "both", "dry"],
          description: "Type of diaper event.",
        },
        start: TIMESTAMP_PROP,
        peeAmount: { type: "string", enum: ["little", "medium", "big"] },
        pooAmount: { type: "string", enum: ["little", "medium", "big"] },
        color: {
          type: "string",
          enum: ["yellow", "green", "brown", "black", "red", "gray"],
        },
        consistency: { type: "string", enum: ["solid", "loose", "runny", "mucousy", "hard"] },
        diaperRash: { type: "boolean" },
        notes: { type: "string" },
      },
      ["mode"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.logDiaper(
        reqString(args, "cid"),
        {
          mode: optEnum(args, "mode", ["pee", "poo", "both", "dry"] as const) ?? "dry",
          start: optTimestamp(args, "start"),
          peeAmount: optEnum(args, "peeAmount", ["little", "medium", "big"] as const),
          pooAmount: optEnum(args, "pooAmount", ["little", "medium", "big"] as const),
          color: optEnum(args, "color", ["yellow", "green", "brown", "black", "red", "gray"] as const),
          consistency: optEnum(args, "consistency", ["solid", "loose", "runny", "mucousy", "hard"] as const),
          diaperRash: optBool(args, "diaperRash"),
          notes: optString(args, "notes"),
        },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "list_diapers", description: "List recent diaper events to confirm." }],
    }),
  },

  {
    name: "log_potty",
    description:
      "Log a potty event (toilet training). Like log_diaper but uses prefs.lastPotty and adds howItHappened.",
    inputSchema: writeSchema(
      {
        mode: {
          type: "string",
          enum: ["pee", "poo", "both", "dry"],
          description: "Type of potty event.",
        },
        howItHappened: {
          type: "string",
          enum: ["satButDry", "wentPotty", "accident"],
          description: "How the potty event occurred: satButDry (sat but no output), wentPotty (success), accident.",
        },
        start: TIMESTAMP_PROP,
        peeAmount: { type: "string", enum: ["little", "medium", "big"] },
        pooAmount: { type: "string", enum: ["little", "medium", "big"] },
        color: { type: "string", enum: ["yellow", "green", "brown", "black", "red", "gray"] },
        consistency: { type: "string", enum: ["solid", "loose", "runny", "mucousy", "hard"] },
        notes: { type: "string" },
      },
      ["mode", "howItHappened"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.logPotty(
        reqString(args, "cid"),
        {
          mode: optEnum(args, "mode", ["pee", "poo", "both", "dry"] as const) ?? "dry",
          howItHappened: optEnum(args, "howItHappened", ["satButDry", "wentPotty", "accident"] as const) ?? "wentPotty",
          start: optTimestamp(args, "start"),
          peeAmount: optEnum(args, "peeAmount", ["little", "medium", "big"] as const),
          pooAmount: optEnum(args, "pooAmount", ["little", "medium", "big"] as const),
          color: optEnum(args, "color", ["yellow", "green", "brown", "black", "red", "gray"] as const),
          consistency: optEnum(args, "consistency", ["solid", "loose", "runny", "mucousy", "hard"] as const),
          notes: optString(args, "notes"),
        },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "list_diapers", description: "List recent diaper/potty events to confirm." }],
    }),
  },

  {
    name: "log_bottle",
    description:
      "Log a bottle feed. amount is required (in ml or oz). Updates prefs.lastBottle.",
    inputSchema: writeSchema(
      {
        amount: { type: "number", description: "Volume given (in the specified units)." },
        start: TIMESTAMP_PROP,
        bottleType: {
          type: "string",
          enum: ["Formula", "Breast Milk", "Tube Feeding", "Cow Milk", "Goat Milk"],
          description: "Type of bottle contents. Default: Formula.",
        },
        units: {
          type: "string",
          enum: ["ml", "oz"],
          description: "Volume units. Default: ml.",
        },
      },
      ["amount"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.logBottle(
        reqString(args, "cid"),
        {
          amount: reqNumber(args, "amount"),
          start: optTimestamp(args, "start"),
          bottleType: optEnum(args, "bottleType", ["Formula", "Breast Milk", "Tube Feeding", "Cow Milk", "Goat Milk"] as const),
          units: optEnum(args, "units", ["ml", "oz"] as const),
        },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "list_feed", description: "List recent feed records to confirm." }],
    }),
  },

  {
    name: "log_nursing",
    description:
      "Log a completed nursing session (not a live timer). start and end are required. Updates prefs.lastNursing and prefs.lastSide.",
    inputSchema: writeSchema(
      {
        start: {
          type: ["string", "number"],
          description: "Session start — ISO 8601 or epoch seconds.",
        },
        end: {
          type: ["string", "number"],
          description: "Session end — ISO 8601 or epoch seconds.",
        },
        side: {
          type: "string",
          enum: ["left", "right"],
          description: "Which side was used (for attribution when no per-side durations given). Default: left.",
        },
        leftDuration: { type: "number", description: "Seconds on left side (provide both or neither)." },
        rightDuration: { type: "number", description: "Seconds on right side (provide both or neither)." },
      },
      ["start", "end"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.logNursing(
        reqString(args, "cid"),
        {
          start: toRangePoint(args.start, "start"),
          end: toRangePoint(args.end, "end"),
          side: optEnum(args, "side", ["left", "right"] as const),
          leftDuration: optNumber(args, "leftDuration"),
          rightDuration: optNumber(args, "rightDuration"),
        },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "list_feed", description: "List recent feed records to confirm." }],
    }),
  },

  {
    name: "log_sleep",
    description:
      "Log a completed sleep interval (not a live timer). start and end are required. Stores start/duration as integers; updates prefs.lastSleep.",
    inputSchema: writeSchema(
      {
        start: {
          type: ["string", "number"],
          description: "Sleep start — ISO 8601 or epoch seconds.",
        },
        end: {
          type: ["string", "number"],
          description: "Sleep end — ISO 8601 or epoch seconds.",
        },
      },
      ["start", "end"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.logSleep(
        reqString(args, "cid"),
        {
          start: toRangePoint(args.start, "start"),
          end: toRangePoint(args.end, "end"),
        },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "list_sleep", description: "List recent sleep intervals to confirm." }],
    }),
  },

  {
    name: "log_solids",
    description:
      "Log a solid-food meal. Requires at least one food with id+source+name (use list_curated_foods or list_custom_foods to find IDs). Updates prefs.lastSolid.",
    inputSchema: writeSchema(
      {
        foods: {
          type: "array",
          description: "Foods eaten. Each needs id (from list_curated_foods/list_custom_foods), source (curated/custom), and name.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              source: { type: "string", enum: ["curated", "custom"] },
              name: { type: "string" },
              amount: { type: ["string", "number"], description: "Optional amount/serving description." },
            },
            required: ["id", "source", "name"],
          },
        },
        start: TIMESTAMP_PROP,
        reaction: {
          type: "string",
          enum: ["LOVED", "MEH", "HATED", "ALLERGIC"],
          description: "Baby's reaction to the meal: LOVED, MEH (neutral), HATED, or ALLERGIC.",
        },
        notes: { type: "string" },
      },
      ["foods"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => {
      const rawFoods = args.foods;
      if (!Array.isArray(rawFoods) || rawFoods.length === 0) {
        throw invalidInput('"foods" must be a non-empty array.');
      }
      const foods = rawFoods.map((f: unknown) => {
        if (!f || typeof f !== "object") throw invalidInput("Each food must be an object.");
        const food = f as Args;
        return {
          id: String(food.id ?? ""),
          source: String(food.source ?? "curated") as SolidsFoodSource,
          name: String(food.name ?? ""),
          amount: food.amount as string | number | undefined,
        };
      });
      return {
        data: await client.logSolids(
          reqString(args, "cid"),
          {
            foods,
            start: optTimestamp(args, "start"),
            reaction: optEnum(args, "reaction", ["LOVED", "MEH", "HATED", "ALLERGIC"] as const),
            notes: optString(args, "notes"),
          },
          { dryRun: optDryRun(args) },
        ),
        next: [{ tool: "list_feed", description: "List recent feed records to confirm." }],
      };
    },
  },

  {
    name: "log_pump",
    description:
      "Log a pump session. Provide totalAmount (split evenly) OR both leftAmount and rightAmount. Updates prefs.lastPump.",
    inputSchema: writeSchema(
      {
        start: TIMESTAMP_PROP,
        totalAmount: { type: "number", description: "Total volume (split evenly between sides). Use instead of left/right amounts." },
        leftAmount: { type: "number", description: "Volume from left side." },
        rightAmount: { type: "number", description: "Volume from right side." },
        units: { type: "string", enum: ["ml", "oz"], description: "Volume units. Default: ml." },
        duration: { type: "number", description: "Session duration in seconds." },
        notes: { type: "string" },
      },
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.logPump(
        reqString(args, "cid"),
        {
          start: optTimestamp(args, "start"),
          totalAmount: optNumber(args, "totalAmount"),
          leftAmount: optNumber(args, "leftAmount"),
          rightAmount: optNumber(args, "rightAmount"),
          units: optEnum(args, "units", ["ml", "oz"] as const),
          duration: optNumber(args, "duration"),
          notes: optString(args, "notes"),
        },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "list_pump", description: "List recent pump sessions to confirm." }],
    }),
  },

  {
    name: "log_growth",
    description:
      "Log a growth measurement (weight, height, and/or head circumference). At least one measurement is required. Updates prefs.lastGrowthEntry.",
    inputSchema: writeSchema(
      {
        start: TIMESTAMP_PROP,
        weight: { type: "number", description: "Weight (kg for metric, lbs.oz decimal for imperial)." },
        height: { type: "number", description: "Height/length (cm for metric, ft.in decimal for imperial)." },
        head: { type: "number", description: "Head circumference (cm for metric, inches for imperial)." },
        units: { type: "string", enum: ["metric", "imperial"], description: "Unit system. Default: metric." },
      },
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.logGrowth(
        reqString(args, "cid"),
        {
          start: optTimestamp(args, "start"),
          weight: optNumber(args, "weight"),
          height: optNumber(args, "height"),
          head: optNumber(args, "head"),
          units: optEnum(args, "units", ["metric", "imperial"] as const),
        },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "get_latest_growth", description: "Confirm the recorded measurement." }],
    }),
  },

  {
    name: "log_activity",
    description:
      "Log an activity (bath, tummy time, story time, screen time, skin-to-skin, outdoor play, indoor play, brush teeth). Updates the per-mode prefs summary.",
    inputSchema: writeSchema(
      {
        mode: {
          type: "string",
          enum: ["bath", "tummyTime", "storyTime", "screenTime", "skinToSkin", "outdoorPlay", "indoorPlay", "brushTeeth"],
          description: "Type of activity.",
        },
        start: TIMESTAMP_PROP,
        duration: { type: "number", description: "Duration in seconds." },
        notes: { type: "string" },
      },
      ["mode"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.logActivity(
        reqString(args, "cid"),
        {
          mode: optEnum(args, "mode", ["bath", "tummyTime", "storyTime", "screenTime", "skinToSkin", "outdoorPlay", "indoorPlay", "brushTeeth"] as const) ?? "bath",
          start: optTimestamp(args, "start"),
          duration: optNumber(args, "duration"),
          notes: optString(args, "notes"),
        },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "list_activities", description: "List recent activities to confirm." }],
    }),
  },

  // ── Write tools: sleep timer state machine ────────────────────────────────

  {
    name: "start_sleep",
    description:
      "Start the live sleep timer for a child. No pre-read needed — always starts a fresh session. Check get_sleep first to see if a timer is already running.",
    inputSchema: writeSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.startSleep(reqString(args, "cid"), undefined, { dryRun: optDryRun(args) }),
      next: [{ tool: "get_sleep", description: "Check the timer state." }],
    }),
  },

  {
    name: "pause_sleep",
    description:
      "Pause the active sleep timer. Fails if the timer is not active or already paused.",
    inputSchema: writeSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.pauseSleep(reqString(args, "cid"), { dryRun: optDryRun(args) }),
      next: [{ tool: "get_sleep", description: "Check the updated timer state." }],
    }),
  },

  {
    name: "resume_sleep",
    description:
      "Resume a paused sleep timer. Fails if the timer is not active or not paused.",
    inputSchema: writeSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.resumeSleep(reqString(args, "cid"), { dryRun: optDryRun(args) }),
      next: [{ tool: "get_sleep", description: "Check the updated timer state." }],
    }),
  },

  {
    name: "cancel_sleep",
    description:
      "Cancel the sleep timer without logging an interval. Resets timer to inactive state. Use complete_sleep instead to save the session.",
    inputSchema: writeSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (client, args) => ({
      data: await client.cancelSleep(reqString(args, "cid"), { dryRun: optDryRun(args) }),
      next: [{ tool: "get_sleep", description: "Confirm the timer was cleared." }],
    }),
  },

  {
    name: "complete_sleep",
    description:
      "Complete the sleep timer: writes a sleep interval row and resets the timer to inactive. Fails if no timer is active.",
    inputSchema: writeSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (client, args) => ({
      data: await client.completeSleep(reqString(args, "cid"), { dryRun: optDryRun(args) }),
      next: [
        { tool: "list_sleep", description: "List sleep intervals to confirm the saved session." },
        { tool: "get_sleep", description: "Confirm the timer was cleared." },
      ],
    }),
  },

  // ── Write tools: nursing timer state machine ──────────────────────────────

  {
    name: "start_nursing",
    description:
      "Start the live nursing timer. Sets feedStartTime and timerStartTime to now (in seconds). Defaults to left side.",
    inputSchema: writeSchema(
      {
        side: {
          type: "string",
          enum: ["left", "right"],
          description: "Starting side. Default: left.",
        },
      },
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.startNursing(
        reqString(args, "cid"),
        { side: optEnum(args, "side", ["left", "right"] as const) },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "get_feed", description: "Check the timer state." }],
    }),
  },

  {
    name: "pause_nursing",
    description:
      "Pause the nursing timer: banks elapsed time into the active side. Fails if not active or already paused.",
    inputSchema: writeSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.pauseNursing(reqString(args, "cid"), { dryRun: optDryRun(args) }),
      next: [{ tool: "get_feed", description: "Check the updated timer state." }],
    }),
  },

  {
    name: "resume_nursing",
    description:
      "Resume a paused nursing timer. Resets timerStartTime to now. Uses stored lastSide if no side given.",
    inputSchema: writeSchema(
      {
        side: {
          type: "string",
          enum: ["left", "right"],
          description: "Side to resume on. Default: stored lastSide.",
        },
      },
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.resumeNursing(
        reqString(args, "cid"),
        { side: optEnum(args, "side", ["left", "right"] as const) },
        { dryRun: optDryRun(args) },
      ),
      next: [{ tool: "get_feed", description: "Check the updated timer state." }],
    }),
  },

  {
    name: "switch_nursing_side",
    description:
      "Switch nursing to the opposite side: banks elapsed time (if not paused), then resets timerStartTime.",
    inputSchema: writeSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (client, args) => ({
      data: await client.switchNursingSide(reqString(args, "cid"), { dryRun: optDryRun(args) }),
      next: [{ tool: "get_feed", description: "Check the updated timer state." }],
    }),
  },

  {
    name: "cancel_nursing",
    description:
      "Cancel the nursing timer without logging an interval. Resets timer to inactive and clears durations. Use complete_nursing to save the session.",
    inputSchema: writeSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (client, args) => ({
      data: await client.cancelNursing(reqString(args, "cid"), { dryRun: optDryRun(args) }),
      next: [{ tool: "get_feed", description: "Confirm the timer was cleared." }],
    }),
  },

  {
    name: "complete_nursing",
    description:
      "Complete the nursing timer: banks remaining time, writes a breast-feed interval row, and resets the timer. Fails if no timer is active.",
    inputSchema: writeSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (client, args) => ({
      data: await client.completeNursing(reqString(args, "cid"), { dryRun: optDryRun(args) }),
      next: [
        { tool: "list_feed", description: "List feed records to confirm the saved session." },
        { tool: "get_feed", description: "Confirm the timer was cleared." },
      ],
    }),
  },
];

// ---------------------------------------------------------------------------
// Gate: filter by writesEnabled
// ---------------------------------------------------------------------------

function isWriteTool(tool: McpToolDef): boolean {
  return tool.annotations?.readOnlyHint === false;
}

function visibleTools(writesEnabled: boolean): McpToolDef[] {
  if (writesEnabled) return TOOLS;
  return TOOLS.filter((t) => !isWriteTool(t));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Tool metadata for an MCP `tools/list` response. */
export function toolList(
  writesEnabled = false,
): Array<Pick<McpToolDef, "name" | "description" | "inputSchema" | "annotations">> {
  return visibleTools(writesEnabled).map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
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
  writesEnabled = false,
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
  if (isWriteTool(tool) && !writesEnabled) {
    return { ok: false, error: new WritesDisabledError().toJSON() };
  }
  try {
    const { data, next } = await tool.handler(client, args, { writesEnabled });
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
