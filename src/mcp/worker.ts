/**
 * Remote MCP server for Cloudflare Workers (and any `fetch`-based runtime).
 *
 * This is the form `huckleberry-ts` structurally can't ship: it's Bun-only,
 * while this handler runs on the edge with zero extra dependencies. It speaks
 * MCP's Streamable-HTTP transport in stateless JSON mode — a small, well-defined
 * JSON-RPC surface (`initialize`, `tools/list`, `tools/call`, `ping`) dispatched
 * to the shared registry in `tools.ts`. No `@modelcontextprotocol/sdk` import,
 * so the Worker bundle stays tiny.
 *
 * Deploy: point a Worker's default export at this module (see docs/mcp.md).
 */

import type { HuckleberryClient } from "../client.js";
import { HuckleberryError } from "../errors.js";
import {
  SERVER_NAME,
  SERVER_VERSION,
  createHuckleberryClient,
  runTool,
  toolList,
} from "./tools.js";

const PROTOCOL_VERSION = "2024-11-05";

export interface WorkerEnv {
  HUCKLEBERRY_EMAIL?: string;
  HUCKLEBERRY_PASSWORD?: string;
  /** When set, callers must send `Authorization: Bearer <this>`. */
  MCP_AUTH_TOKEN?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

type ClientFactory = () => Promise<HuckleberryClient>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toolResult(payload: unknown, isError: boolean): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

/** Dispatch a single JSON-RPC message. Returns null for notifications. */
async function handleMessage(
  msg: JsonRpcMessage,
  getClient: ClientFactory,
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolList() });
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      if (typeof name !== "string") {
        return fail(-32602, "Invalid params: missing tool name");
      }
      let client: HuckleberryClient;
      try {
        client = await getClient();
      } catch (err) {
        const payload =
          err instanceof HuckleberryError
            ? err.toJSON()
            : { error: "AuthError", message: String(err), category: "auth", retryable: false, recovery: "" };
        return reply(toolResult(payload, true));
      }
      const r = await runTool(client, name, args);
      return reply(toolResult(r.ok ? r.result : r.error, !r.ok));
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/**
 * Handle one HTTP request against the MCP server. Use this directly if you want
 * to mount the server on a custom route; otherwise use the default export.
 */
export async function handleMcpHttpRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  if (request.method === "GET") {
    return new Response(
      `${SERVER_NAME} MCP server (v${SERVER_VERSION}). POST JSON-RPC to this endpoint.`,
      { status: 200, headers: { "content-type": "text/plain" } },
    );
  }
  if (request.method !== "POST") {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Method not allowed" } }, 405);
  }
  if (env.MCP_AUTH_TOKEN) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body: JsonRpcMessage | JsonRpcMessage[];
  try {
    body = (await request.json()) as JsonRpcMessage | JsonRpcMessage[];
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  // One authenticated client per HTTP request, created lazily (handshake calls
  // like initialize/tools/list don't need credentials).
  let clientPromise: Promise<HuckleberryClient> | undefined;
  const getClient: ClientFactory = () =>
    (clientPromise ??= createHuckleberryClient(
      { email: env.HUCKLEBERRY_EMAIL, password: env.HUCKLEBERRY_PASSWORD },
      { fetch: fetch.bind(globalThis) },
    ));

  if (Array.isArray(body)) {
    const out = await Promise.all(body.map((m) => handleMessage(m, getClient)));
    return json(out.filter((r): r is JsonRpcResponse => r !== null));
  }

  const res = await handleMessage(body, getClient);
  if (res === null) return new Response(null, { status: 202 });
  return json(res);
}

/** Cloudflare Worker entry point. */
export default {
  fetch: (request: Request, env: WorkerEnv): Promise<Response> =>
    handleMcpHttpRequest(request, env),
};
