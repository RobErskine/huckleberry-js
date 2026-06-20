# MCP server

`huckleberry-js` ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so an LLM (Claude Desktop, etc.) can read your Huckleberry data through
typed, **read-only** tools. The same tool registry is served over two
transports — pick the one that matches where you want it to run.

| | **Local (stdio)** | **Remote (Cloudflare Workers)** |
| --- | --- | --- |
| Runs on | Your machine, Node 18+ | The edge, always-on |
| Entry | `huckleberry-mcp` bin | `huckleberry-js/mcp/worker` |
| Needs the MCP SDK | Yes (optional peer dep) | No (zero extra deps) |
| Credentials live in | Your local MCP config | Worker secrets |
| Best for | Personal use in Claude Desktop | Sharing / hosted assistants |

Both expose the same tools, all `readOnlyHint: true` / `destructiveHint: false`:

`get_capabilities`, `get_user`, `list_children`, `get_child`, `list_sleep`,
`list_feed`, `list_diapers`, `list_activities`, `list_pump`, `list_health`,
`get_latest_growth`.

Successful responses use a stable envelope:

```json
{ "data": [ ... ], "totalResults": 12, "_next": [ { "tool": "get_child", "description": "..." } ] }
```

Errors return the structured form (from `HuckleberryError.toJSON()`):

```json
{ "error": "ChildNotFoundError", "message": "Child not found: abc",
  "category": "not_found", "retryable": false,
  "recovery": "Call list_children to get valid child IDs (cid)." }
```

---

## Form A — Local (stdio)

Runs on Node via the official MCP SDK. Install the optional peer dependency
alongside the package:

```bash
npm install huckleberry-js @modelcontextprotocol/sdk
```

Or run it with no install at all using `npx`:

```bash
HUCKLEBERRY_EMAIL=you@example.com HUCKLEBERRY_PASSWORD=secret \
  npx -p huckleberry-js huckleberry-mcp
```

### Claude Desktop config

```json
{
  "mcpServers": {
    "huckleberry": {
      "command": "npx",
      "args": ["-p", "huckleberry-js", "huckleberry-mcp"],
      "env": {
        "HUCKLEBERRY_EMAIL": "you@example.com",
        "HUCKLEBERRY_PASSWORD": "your-password"
      }
    }
  }
}
```

> Uses `npx`/Node — **no Bun required**. If you've installed the package into a
> project, you can instead point `command` at the local `huckleberry-mcp` bin.

**Advantages**

- Zero infrastructure; nothing to host or secure.
- Credentials never leave your machine.
- Works out of the box with Claude Desktop.

**Disadvantages**

- Only available where it's installed (your laptop).
- Credentials sit in your local MCP config file.
- One process serves one user.

---

## Form B — Remote (Cloudflare Workers)

The Worker handler speaks MCP's Streamable-HTTP transport in stateless JSON mode
over plain `fetch`, so it needs **no extra dependencies** — the core library's
zero-dep, REST-based design is exactly what lets it run on the edge (a Bun-only
client can't). Re-export the handler from your Worker:

```ts
// src/worker.ts
export { default } from "huckleberry-js/mcp/worker";
```

```toml
# wrangler.toml
name = "huckleberry-mcp"
main = "src/worker.ts"
compatibility_date = "2026-01-01"
```

Set secrets (never commit them):

```bash
wrangler secret put HUCKLEBERRY_EMAIL
wrangler secret put HUCKLEBERRY_PASSWORD
wrangler secret put MCP_AUTH_TOKEN   # optional; see "Securing" below
wrangler deploy
```

Point an MCP client at the deployed URL (POST JSON-RPC). With `MCP_AUTH_TOKEN`
set, include `Authorization: Bearer <token>` on requests.

```jsonc
{
  "mcpServers": {
    "huckleberry": {
      "url": "https://huckleberry-mcp.<you>.workers.dev",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

### Securing the endpoint

The Worker can read a child's data, so **gate it**. The handler supports a
shared bearer token out of the box: set `MCP_AUTH_TOKEN` and every request must
present it. For stronger control put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
in front of the Worker. If you set no token, the endpoint is open to anyone with
the URL — only do that behind another gate.

> Persisted sessions: the handler authenticates per request by default. To avoid
> re-signing-in on every call, wire `createHuckleberryClient(..., { session,
> onSession })` to a KV namespace using the same pattern as the library's
> Workers example in the README.

**Advantages**

- Always-on, shareable URL; no local install for clients.
- Centralized credentials (Worker secrets), rotated in one place.
- Fast edge cold-starts thanks to the zero-dependency core.

**Disadvantages**

- You operate and secure the endpoint (auth is on you).
- Per-request sign-in unless you add session caching.
- Hosting a service that can read personal data raises the security bar.

---

## Which should I use?

- Just you, in Claude Desktop, on one machine → **Local (stdio)**.
- A hosted assistant, multiple devices, or sharing access → **Remote (Workers)**,
  with `MCP_AUTH_TOKEN` or Cloudflare Access in front.
