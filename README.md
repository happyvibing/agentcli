# AgentCLI

**One CLI. Any MCP server.** Call MCP servers from the command line — dynamically, with no per-tool wrapper code.

> ```bash
> $ agentcli github search_issues --repo apache/hertzbeat --query "memory leak"
> { "ok": true, "server": "github", "tool": "search_issues",
>   "data": [ { "number": 123, "title": "Memory leak in collector" } ],
>   "meta": { "durationMs": 412, "via": "daemon" } }
> ```

Every MCP tool becomes a CLI command the first time you type it. Flags are compiled from the tool's JSON Schema on the fly.

## Why

Agents that register every MCP tool upfront pay for it in context: hundreds of schemas loaded at startup, most never used. A CLI flips the model to **progressive disclosure**: discover with `--help`, drill down only as far as needed. stdout/stderr separation and a typed exit-code protocol keep the whole thing machine-consumable.

## Install

```bash
npm install -g @happyvibing/agentcli
```

Requires Node >= 20. Or run from source: `git clone && npm install && npm link`.

## Quick start

```bash
# 1. Register a server
agentcli server add github \
  --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx \
  -- npx -y @modelcontextprotocol/server-github

# HTTP servers work the same way:
#   agentcli server add github --url https://mcp.example.com/github --header "Authorization: Bearer $TOKEN"

# 2. Discover — help is the interface; every level answers one question
agentcli -h                       # → configured servers
agentcli github -h                # → the server's tools
agentcli github search_issues -h  # → generated usage for one tool

# 3. Execute
agentcli github search_issues --repo apache/hertzbeat --query "memory leak"
```

Usage is generated straight from each tool's JSON Schema — nothing hand-written:

```text
github create_issue

Create a GitHub issue

Usage:
  agentcli github create_issue [flags]

Required:
  --owner <string>    Repository owner
  --repo <string>     Repository name
  --title <string>    Issue title

Optional:
  --body <string>     Issue body
  --labels <string>   Issue labels (repeatable: --labels bug --labels p1)

Global:
  --input <json|@file|->    Full JSON arguments object (flags override --input keys)
  --output <json|text>      Output format (default: json)
  --schema                  Print the raw tool input schema
```

## Commands

| Command | Purpose |
|---|---|
| `agentcli -h` | Discovery entry: built-ins **and configured servers** |
| `agentcli server add <name> -- <command...>` | Register a stdio server (`--env KEY=value` repeatable) |
| `agentcli server add <name> --url <url>` | Register a Streamable HTTP server (`--header` repeatable) |
| `agentcli server list` / `server tools <name>` | List servers / a server's tools |
| `agentcli server remove <name>` | Unregister |
| `agentcli <server> -h` | List the server's tools |
| `agentcli <server> <tool> -h` | Generated usage for one tool |
| `agentcli <server> <tool> --schema` | Raw input schema of the tool |
| `agentcli <server> <tool> [flags]` | Execute |
| `agentcli daemon start/stop/status/restart` | Manage the background daemon (persistent connections, millisecond repeated calls) |
| `agentcli version` | Print version |

Typos self-correct: unknown names get suggestions (`Did you mean: github?`).

### Flags

The tool's JSON Schema compiles to flags for top-level primitives:

| Schema type | Flag form |
|---|---|
| `string` | `--name value` or `--name=value` |
| `string` + `enum` | `--name choice` (validated) |
| `integer` / `number` | `--name 3` (parsed, validated) |
| `boolean` | `--name` (true), `--name=false`, or `--name false` |
| `array` of primitives | repeat: `--labels bug --labels p1` |
| object / anyOf / $ref / … | not a flag — use `--input` |

`--input` takes the full arguments object (inline JSON, `@file`, or `-` for stdin); flags override its keys:

```bash
agentcli github create_issue --input '{"owner":"x","repo":"y","title":"bug"}' --labels p1
```

## Output

**stdout** carries only the result; **stderr** only diagnostics; exit codes are stable.

Default JSON wraps the payload — take results from `.data`:

```json
{ "ok": true, "server": "github", "tool": "search_issues",
  "data": [ "… payload …" ],
  "meta": { "durationMs": 412, "schemaCached": true, "via": "daemon" } }
```

`data` is the payload itself — server-side double encoding is unwrapped; never a JSON-string-in-a-string.

`--output text` drops the envelope — payload only, jq-ready:

```bash
agentcli github search_issues --repo x/y --query "leak" --output text | jq -r '.[0].title'
```

Failure — one JSON line on stderr:

```json
{"ok":false,"error":{"code":"INVALID_ARGUMENT","message":"invalid integer for --times: \"bad\"","hint":"…"}}
```

Error codes: `INVALID_ARGUMENT`, `EXECUTION_ERROR`, `CONNECT_FAILED`, `AUTH_REQUIRED`, `NOT_FOUND`, `TIMEOUT`, `USAGE`, `INTERNAL`.

| Exit code | Meaning |
|---|---|
| `0` | success |
| `1` | execution failure (tool error, connect failure) |
| `2` | invalid arguments / usage |
| `10` | authentication required |
| `12` | server or tool not found |
| `13` | timeout |

### Environment

| Variable | Effect (default) |
|---|---|
| `AGENTCLI_CONFIG` | config path (`~/.agentcli/config.json`) |
| `AGENTCLI_TIMEOUT_MS` | per-request timeout (60000) |
| `AGENTCLI_TTL_MS` | tool-list cache TTL (10 min) |
| `AGENTCLI_NO_DAEMON` | `1` = never use the daemon |
| `AGENTCLI_DAEMON_IDLE_MS` | daemon idle shutdown (30 min) |
| `AGENTCLI_CACHE_DIR` | cache location (next to the config) |
| `AGENTCLI_PROTOCOL_VERSIONS` | extra accepted protocol versions |

## Agent Skill

`skills/agentcli/SKILL.md` teaches an agent this runtime — the discover → inspect → execute → observe loop, exit codes, and error recovery. Install it:

```bash
mkdir -p ~/.agents/skills/agentcli && cp skills/agentcli/SKILL.md ~/.agents/skills/agentcli/
```
