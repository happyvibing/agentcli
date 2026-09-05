# AgentCLI

**One CLI. Any MCP server.** Call MCP servers from the command line — dynamically, with no per-tool wrapper code.

> ```bash
> $ agentcli github search_issues --repo apache/hertzbeat --query "memory leak"
> {
>   "ok": true,
>   "server": "github",
>   "tool": "search_issues",
>   "data": [ { "number": 123, "title": "Memory leak in collector", "url": "https://github.com/apache/hertzbeat/issues/123" } ],
>   "meta": { "durationMs": 412, "schemaCached": true, "via": "daemon" }
> }
> ```

Every MCP tool becomes a CLI command the first time you type it. Flags are compiled from the tool's JSON Schema on the fly.

## Why

Agents that register every MCP tool upfront pay for it in context: hundreds of schemas
loaded at startup, most never used. A CLI flips the model to **progressive disclosure**:
discover with `--help`, drill down only as far as needed. stdout/stderr separation,
JSON output, and a typed exit-code protocol make the whole thing machine-consumable.

## Install

```bash
npm install -g @happyvibing/agentcli
```

Requires Node >= 20. Or run from source: `git clone && npm install && npm link`.

## Quick start

Help is the interface. Every level answers one question:

```bash
# 1. Register the GitHub MCP server (token: github.com/settings/tokens)
agentcli server add github \
  --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx \
  -- npx -y @modelcontextprotocol/server-github

# 2. Discover — help shows what exists at every level
agentcli -h                       # → configured servers
agentcli github -h                # → the server's tools
agentcli github search_issues -h  # → generated usage for one tool

# 3. Execute
agentcli github search_issues --repo apache/hertzbeat --query "memory leak"
```

Generated usage comes straight from the tool's JSON Schema — nothing is hand-written:

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
  ...
```

Streamable HTTP servers work the same way:

```bash
agentcli server add github --url https://mcp.example.com/github --header "Authorization: Bearer $TOKEN"
```

## Commands

| Command | Purpose |
|---|---|
| `agentcli -h` | Discovery entry point: built-ins **and configured servers** |
| `agentcli server add <name> -- <command...>` | Register a stdio server (`--env KEY=value` repeatable) |
| `agentcli server add <name> --url <url>` | Register a Streamable HTTP server (`--header` repeatable) |
| `agentcli server list` / `server tools <name>` | Configured servers / a server's tools (JSON default, `-o text` for humans) |
| `agentcli server remove <name>` | Unregister |
| `agentcli <server> -h` | List tools |
| `agentcli <server> <tool> -h` | Generated usage for one tool |
| `agentcli <server> <tool> --schema` | Raw JSON Schema of the tool input |
| `agentcli <server> <tool> [flags]` | Execute |
| `agentcli daemon start/stop/status/restart` | Manage the background daemon |
| `agentcli version` | Print version |

Unknown server or tool names get typo-tolerant suggestions
(`Did you mean: github?`), so a mistyped word self-corrects without another discovery roundtrip.

### Flags

The tool's JSON Schema is compiled to flags — for top-level primitives:

| Schema type | Flag form |
|---|---|
| `string` | `--name value` or `--name=value` |
| `string` + `enum` | `--name choice` (validated) |
| `integer` / `number` | `--name 3` (parsed, validated) |
| `boolean` | `--name` (true), `--name=false`, or `--name false` |
| `array` of primitives | repeat: `--labels bug --labels p1` |
| object / anyOf / $ref / … | not a flag — use `--input` |

`--input` is the escape hatch for everything else:

```bash
agentcli github create_issue --input '{"owner":"x","repo":"y","title":"bug","labels":["p1"]}'
agentcli github create_issue --input @payload.json
cat payload.json | agentcli github create_issue --input -
```

Flags override `--input` keys, so you can combine them.

## Output protocol (for agent authors)

**stdout** carries only the result; **stderr** carries only diagnostics. Exit codes are stable.

Success (`--output json`, the default):

```json
{
  "ok": true,
  "server": "github",
  "tool": "search_issues",
  "data": [],
  "meta": { "durationMs": 412, "schemaCached": true, "via": "daemon" }
}
```

- `data`: the payload itself. `structuredContent` if the server sent one; otherwise text
  content parsed as JSON — including bounded unwrapping of doubly-encoded strings
  (`JSON.stringify(JSON.stringify(payload))`, common among HTTP servers). Never a
  JSON-string-in-a-string.
- `meta.via`: `"daemon"` when the call reused a persistent connection, `"direct"` otherwise.

`--output text` drops the envelope — payload only, jq-ready:

```bash
agentcli github search_issues --repo x/y --query "leak" --output text | jq -r '.[0].title'
```

Structured results pretty-print as JSON; prose passes through raw.

Failure — one JSON line on stderr:

```json
{"ok":false,"error":{"code":"INVALID_ARGUMENT","message":"invalid integer for --times: \"bad\"","hint":"..."}}
```

| Exit code | Meaning |
|---|---|
| `0` | success |
| `1` | execution failure (tool error, connect failure) |
| `2` | invalid arguments / usage |
| `10` | authentication required |
| `12` | server or tool not found |
| `13` | timeout |

Error codes: `INVALID_ARGUMENT`, `EXECUTION_ERROR`, `CONNECT_FAILED`, `AUTH_REQUIRED`,
`NOT_FOUND`, `TIMEOUT`, `USAGE`, `INTERNAL`.

So an agent can safely do:

```bash
result=$(agentcli github search_issues --repo x/y --query "leak") || handle_error
```

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

`skills/agentcli/SKILL.md` teaches an agent how to use this runtime — the loop
(discover → inspect → execute → observe), the `--input` escape hatch, exit codes,
and error-recovery rules. It is deliberately thin: the runtime owns what capabilities
exist; the skill only teaches how to ask.

Install it for your agent:

```bash
mkdir -p ~/.agents/skills/agentcli
cp skills/agentcli/SKILL.md ~/.agents/skills/agentcli/SKILL.md
```

(For Claude Code or other agents, copy it into the equivalent skills directory,
or into `.agents/skills/` inside a project to scope it to that repo.)

## Development

```bash
npm install
npm test    # 41 tests: e2e against a real MCP stdio fixture + daemon lifecycle + skill guard
```

## Roadmap

Hierarchical namespaces (`github issue search`), semantic search, native CLI / HTTP-API
adapters, auth `login` flows, policy engine, SSE transport fallback. Protocol details above
are considered stable commitments and will not change casually.
