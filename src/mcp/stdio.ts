#!/usr/bin/env node
/**
 * Local MCP server over stdio (Node).
 *
 * Parity with `huckleberry-ts`'s `bunx` server, but on plain Node — runnable via
 * `npx -p huckleberry-js huckleberry-mcp`, no Bun required. Reads credentials
 * from the environment and serves the shared tool registry through the official
 * MCP SDK's stdio transport.
 *
 *   HUCKLEBERRY_EMAIL, HUCKLEBERRY_PASSWORD   (required)
 *
 * `@modelcontextprotocol/sdk` is an optional peer dependency — install it
 * alongside this package to run the stdio server.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  SERVER_NAME,
  SERVER_VERSION,
  createHuckleberryClient,
  runTool,
  toolList,
} from "./tools.js";

async function main(): Promise<void> {
  const writesEnabled =
    process.env.HUCKLEBERRY_ENABLE_WRITES === "1" ||
    process.env.HUCKLEBERRY_ENABLE_WRITES === "true";

  const client = await createHuckleberryClient({
    email: process.env.HUCKLEBERRY_EMAIL,
    password: process.env.HUCKLEBERRY_PASSWORD,
  });

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolList(writesEnabled),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const r = await runTool(client, name, args ?? {}, writesEnabled);
    return {
      content: [
        { type: "text", text: JSON.stringify(r.ok ? r.result : r.error, null, 2) },
      ],
      isError: !r.ok,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the protocol; log readiness to stderr.
  console.error(
    `${SERVER_NAME} MCP server v${SERVER_VERSION} ready (stdio). Writes: ${writesEnabled ? "enabled" : "disabled"}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
