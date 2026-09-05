# AgentCLI

**One CLI. Any MCP server.** Call MCP servers from the command line — dynamically, with no per-tool wrapper code.

> ```bash
> $ agentcli zsearch web_search_prime --search_query "MCP latest version" --location cn
> {
>   "ok": true,
>   "server": "zsearch",
>   "tool": "web_search_prime",
>   "data": [ { "title": "…", "link": "…", "content": "…" }, … ],
>   "meta": { "durationMs": 2144, "schemaCached": true, "via": "direct" }
> }
> ```

Every MCP tool becomes a CLI command the first time you type it. Flags are compiled from the tool's JSON Schema on the fly.

## Why

Agents that register every MCP tool upfront pay for it in context: hundreds of schemas
loaded at startup, most never used. A CLI flips the model to **progressive disclosure**:
the agent (or human) starts from `--help` and drills down only as far as needed.
stdout/stderr separation, JSON output, and a typed exit-code protocol make the whole
thing machine-consumable.

## Install

```bash
npm install -g @happyvibing/agentcli
```

Requires Node >= 20. Or run from source: `git clone && npm install && npm link`.

## Try it in 30 seconds

With a server that needs no credentials:

```bash
agentcli server add everything -- npx -y @modelcontextprotocol/server-everything

agentcli everything --help                # what tools exist?
agentcli everything get-sum --help        # how is one called?
agentcli everything get-sum --a 40 --b 2  # call it
```

Generated usage looks like this (straight from the tool's schema, nothing hand-written):

```text
everything get-sum

Returns the sum of two numbers

Usage:
  agentcli everything get-sum [flags]

Required:
  --a <number>    First number
  --b <number>    Second number

Global:
  --input <json|@file|->    Full JSON arguments object (flags override --input keys)
  --output <json|text>      Output format (default: json)
  --schema                  Print the raw tool input schema
  ...
```

## Real servers

```bash
# stdio with env vars (credentials stay out of the agent's environment)
agentcli server add github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx -- npx -y @modelcontextprotocol/server-github

# Streamable HTTP with auth headers (e.g. Zhipu web search)
agentcli server add zsearch --url https://open.bigmodel.cn/api/mcp/web_search_prime/mcp \
  --header "Authorization: Bearer $KEY"

agentcli github search_issues --help
agentcli zsearch web_search_prime --search_query "GLM-5" --location cn
```

## Commands

| Command | Purpose |
|---|---|
| `agentcli --help` | Overview: built-ins **and configured servers** (discovery entry point) |
| `agentcli server add <name> -- <command...>` | Register a stdio server (`--env KEY=value` repeatable) |
| `agentcli server add <name> --url <url>` | Register a Streamable HTTP server (`--header` repeatable) |
| `agentcli server list` / `server tools <name>` | Configured servers / a server's tools (JSON default, `-o text` for humans) |
| `agentcli server remove <name>` | Unregister |
| `agentcli <server> --help` | List tools |
| `agentcli <server> <tool> --help` | Generated usage for one tool |
| `agentcli <server> <tool> --schema` | Raw JSON Schema of the tool input |
| `agentcli <server> <tool> [flags]` | Execute |
| `agentcli daemon start/stop/status/restart` | Manage the background daemon |
| `agentcli version` | Print version |

Unknown server or tool names get typo-tolerant suggestions
(`Did you mean: everything?`), so a mistyped word self-corrects without another discovery roundtrip.

### Flags

The tool's JSON Schema is compiled to flags — for top-level primitives:

| Schema type | Flag form |
|---|---|
| `string` | `--name value` or `--name=value` |
| `string` + `enum` | `--name choice` (validated) |
| `integer` / `number` | `--name 3` (parsed, validated) |
| `boolean` | `--name` (true), `--name=false`, or `--name false` |
| `array` of primitives | repeat: `--tag a --tag b` |
| object / anyOf / $ref / … | not a flag — use `--input` |

`--input` is the escape hatch for everything else:

```bash
agentcli github create_issue --input '{"repo":"x/y","title":"bug","labels":["p1"]}'
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
  "server": "demo",
  "tool": "echo",
  "data": "hi hi",
  "meta": { "durationMs": 189, "schemaCached": true, "via": "direct" }
}
```

- `data`: `structuredContent` if the server sent one; otherwise text content parsed
  as JSON when it parses, passed through as text when it doesn't.
- `meta.via`: `"daemon"` when the call reused a persistent connection, `"direct"` otherwise.

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
result=$(agentcli github search_issue --repo x/y --query "leak") || handle_error
```

## Behavior notes

- **Tool-list cache**: `tools/list` results are cached (daemon: in memory, direct: on disk next to the
  config; default TTL 10 min). `--refresh` bypasses; `AGENTCLI_TTL_MS` / `AGENTCLI_TIMEOUT_MS` tune TTL
  and request timeout. A corrupted cache file is recovered transparently.
- **Daemon mode**: `agentcli daemon start` keeps persistent MCP connections so repeated calls skip the
  spawn + handshake — measured ~2400 ms → ~3 ms per call against `server-everything` via npx. Calls route
  through it automatically and fall back to the per-call path whenever it is unreachable. `--no-daemon`
  or `AGENTCLI_NO_DAEMON=1` bypasses it; `AGENTCLI_DAEMON_IDLE_MS` sets the idle shutdown (default 30 min).
  A non-idempotent tool can never run twice: once a request has reached the daemon, failures are surfaced,
  not retried. Unix sockets only (skipped on Windows). The socket is `0600`.
- **Credential isolation**: spawned stdio servers receive only a small env whitelist
  (`PATH`, `HOME`, …) plus explicit `--env KEY=value`; nothing else leaks from the agent's environment.
- **Config**: `~/.agentcli/config.json` (override with `AGENTCLI_CONFIG` or `--config <path>`).
- **Protocol versions**: the bundled official SDK negotiates up to 2025-11-25; we extend its accepted
  versions with the current spec (2026-07-28, see modelcontextprotocol.io) so newer servers connect.
  Override with `AGENTCLI_PROTOCOL_VERSIONS`. Legacy 2024-11-05 HTTP+SSE servers need an SSE fallback
  (not yet implemented).
- Server names are reserved if they collide with built-ins (`server`, `daemon`, `call`, `help`, …).

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