# MCP server

`huckleberry-js` ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so an LLM (Claude Desktop, etc.) can read **and (optionally) write** your
Huckleberry data through typed tools. The same tool registry is served over two
transports — pick the one that matches where you want it to run.

| | **Local (stdio)** | **Remote (Cloudflare Workers)** |
| --- | --- | --- |
| Runs on | Your machine, Node 20+ | The edge, always-on |
| Entry | `huckleberry-mcp` bin | `huckleberry-js/mcp/worker` |
| Needs the MCP SDK | Yes (optional peer dep) | No (zero extra deps) |
| Credentials live in | Your local MCP config | Worker secrets |
| Best for | Personal use in Claude Desktop | Sharing / hosted assistants |

## Tools

### Read tools (always available, `readOnlyHint: true`)

`get_capabilities`, `get_user`, `list_children`, `get_child`, `get_sleep`,
`list_sleep`, `get_feed`, `list_feed`, `list_diapers`, `list_activities`,
`list_pump`, `list_health`, `get_latest_growth`, `list_curated_foods`,
`list_custom_foods`.

### Write tools (gated — see below)

Hidden from `tools/list` and rejected with `WritesDisabledError` unless
`HUCKLEBERRY_ENABLE_WRITES` is set. All carry `readOnlyHint: false`; the
`cancel_*`/`complete_*` timer tools also carry `destructiveHint: true` so clients
can prompt for confirmation. Every write tool accepts `dryRun: true` to preview
the planned Firestore writes without committing.

- **Single-shot logs**: `log_diaper`, `log_potty`, `log_bottle`, `log_nursing`,
  `log_sleep`, `log_solids`, `log_pump`, `log_growth`, `log_activity`.
- **Sleep timer**: `start_sleep`, `pause_sleep`, `resume_sleep`, `cancel_sleep`,
  `complete_sleep`.
- **Nursing timer**: `start_nursing`, `pause_nursing`, `resume_nursing`,
  `switch_nursing_side`, `cancel_nursing`, `complete_nursing`.

### Enabling writes

Set `HUCKLEBERRY_ENABLE_WRITES=1` (or `true`) in the server environment — a stdio
env var or a Worker secret. With it **unset** the server behaves exactly like the
read-only releases: write tools don't appear in `tools/list` and any call to one
returns:

```json
{ "error": "WritesDisabledError", "category": "invalid_input", "retryable": false,
  "recovery": "Ask the server operator to set HUCKLEBERRY_ENABLE_WRITES=1 and restart the server." }
```

`get_capabilities` reports the current state (`writesEnabled`, `readOnly`) and the
visible tool list, so an LLM can discover up front whether it can write.

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

To allow writes, add `"HUCKLEBERRY_ENABLE_WRITES": "1"` to that `env` block. The
server logs `Writes: enabled.` / `Writes: disabled.` on startup (to stderr) so
you can confirm which mode it's in.

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
wrangler secret put MCP_AUTH_TOKEN          # optional; see "Securing" below
wrangler secret put HUCKLEBERRY_ENABLE_WRITES   # optional; set to "1" to allow writes
wrangler deploy
```

> Leave `HUCKLEBERRY_ENABLE_WRITES` unset for a read-only endpoint. If you enable
> writes on a hosted Worker, make sure `MCP_AUTH_TOKEN` (or Cloudflare Access) is
> in front of it — an unauthenticated write endpoint can mutate a child's data.

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
