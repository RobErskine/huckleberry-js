import { describe, expect, it } from "vitest";
import type { HuckleberryClient } from "../src/client.js";
import { TOOLS, runTool, toolList } from "../src/mcp/tools.js";
import { handleMcpHttpRequest } from "../src/mcp/worker.js";

/** Build a partial client stub; only the methods a tool touches are needed. */
function stub(partial: Record<string, unknown>): HuckleberryClient {
  return partial as unknown as HuckleberryClient;
}

describe("MCP tool registry", () => {
  it("toolList mirrors TOOLS with JSON-Schema inputs", () => {
    const list = toolList();
    expect(list).toHaveLength(TOOLS.length);
    for (const t of list) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.name).toBe("string");
    }
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

  it("lists tools without requiring credentials", async () => {
    const res = await handleMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      {},
    );
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toHaveLength(TOOLS.length);
  });

  it("rejects requests when MCP_AUTH_TOKEN is set and missing", async () => {
    const res = await handleMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      { MCP_AUTH_TOKEN: "secret" },
    );
    expect(res.status).toBe(401);
  });
});
