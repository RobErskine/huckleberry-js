import { describe, expect, it } from "vitest";
import type { HuckleberryClient } from "../src/client.js";
import { TOOLS, runTool, toolList } from "../src/mcp/tools.js";
import { handleMcpHttpRequest } from "../src/mcp/worker.js";

/** Build a partial client stub; only the methods a tool touches are needed. */
function stub(partial: Record<string, unknown>): HuckleberryClient {
  return partial as unknown as HuckleberryClient;
}

describe("MCP tool registry", () => {
  it("toolList(true) mirrors full TOOLS array with JSON-Schema inputs", () => {
    const list = toolList(true);
    expect(list).toHaveLength(TOOLS.length);
    for (const t of list) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.name).toBe("string");
    }
  });

  it("toolList(false) hides all write tools", () => {
    const readOnly = toolList(false);
    const all = toolList(true);
    expect(readOnly.length).toBeLessThan(all.length);
    for (const t of readOnly) {
      expect(t.annotations?.readOnlyHint).not.toBe(false);
    }
  });

  it("toolList(true) exposes write tools with readOnlyHint: false", () => {
    const all = toolList(true);
    const writeTools = all.filter((t) => t.annotations?.readOnlyHint === false);
    expect(writeTools.length).toBeGreaterThan(0);
    expect(writeTools.some((t) => t.name === "log_diaper")).toBe(true);
    expect(writeTools.some((t) => t.name === "start_sleep")).toBe(true);
    expect(writeTools.some((t) => t.name === "complete_nursing")).toBe(true);
  });

  it("runTool wraps array results with totalResults and _next", async () => {
    const client = stub({ user: { listChildren: async () => [{ cid: "c1" }] } });
    const r = await runTool(client, "list_children");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.totalResults).toBe(1);
      expect(r.result._next?.length).toBeGreaterThan(0);
    }
  });

  it("runTool returns a structured error for an unknown tool", async () => {
    const r = await runTool(stub({}), "does_not_exist");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe("invalid_input");
  });

  it("runTool surfaces missing required args as invalid_input", async () => {
    const r = await runTool(stub({}), "get_child", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe("invalid_input");
  });

  it("runTool maps a missing child to not_found", async () => {
    const client = stub({ user: { getChild: async () => null } });
    const r = await runTool(client, "get_child", { cid: "ghost" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.error).toBe("ChildNotFoundError");
      expect(r.error.category).toBe("not_found");
    }
  });

  it("runTool returns WritesDisabledError when writes are off", async () => {
    const r = await runTool(stub({}), "log_diaper", { cid: "c1", mode: "pee" }, false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.error).toBe("WritesDisabledError");
      expect(r.error.category).toBe("invalid_input");
    }
  });

  it("runTool executes write tool when writesEnabled is true", async () => {
    const logDiaper = async () => ({ dryRun: true, plan: [] });
    const client = stub({ logDiaper });
    const r = await runTool(client, "log_diaper", { cid: "c1", mode: "pee", dryRun: true }, true);
    expect(r.ok).toBe(true);
  });

  it("cancel_sleep and complete_sleep have destructiveHint: true", () => {
    const all = toolList(true);
    const cancel = all.find((t) => t.name === "cancel_sleep");
    const complete = all.find((t) => t.name === "complete_sleep");
    expect(cancel?.annotations?.destructiveHint).toBe(true);
    expect(complete?.annotations?.destructiveHint).toBe(true);
  });
});

describe("MCP Worker transport", () => {
  function post(body: unknown): Request {
    return new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("responds to initialize with server info", async () => {
    const res = await handleMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      {},
    );
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("huckleberry-js");
  });

  it("lists only read tools when HUCKLEBERRY_ENABLE_WRITES is not set", async () => {
    const res = await handleMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      {},
    );
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toHaveLength(toolList(false).length);
    // Write tools must not appear
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("log_diaper");
    expect(names).not.toContain("start_sleep");
  });

  it("lists all tools when HUCKLEBERRY_ENABLE_WRITES=1", async () => {
    const res = await handleMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      { HUCKLEBERRY_ENABLE_WRITES: "1" },
    );
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toHaveLength(TOOLS.length);
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("log_diaper");
    expect(names).toContain("complete_nursing");
  });

  it("rejects requests when MCP_AUTH_TOKEN is set and missing", async () => {
    const res = await handleMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      { MCP_AUTH_TOKEN: "secret" },
    );
    expect(res.status).toBe(401);
  });
});
