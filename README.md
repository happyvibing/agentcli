# AgentCLI

**One CLI. Any MCP server.** Call MCP servers from the command line — dynamically, with no per-tool wrapper code.

> AgentCLI turns any MCP server into a set of CLI commands, on the fly:
>
> ```bash
> agentcli github issue search --repo apache/hertzbeat --query "memory leak"
> ```

This is the scoped MVP of a larger idea — a universal Tool Runtime for AI agents
(discovery, auth, policy across MCP / CLI / HTTP backends). Current scope: **MCP → CLI**, done well.

## Why

Agents that register every MCP tool upfront pay for it in context: hundreds of schemas
loaded at startup, most never used. A CLI flips the model to **progressive disclosure**:
the agent (or human) starts from `--help` and drills down only as far as needed.
stdout/stderr separation, JSON output, and a typed exit-code protocol make the whole
thing machine-consumable.

## Install

```bash
npm install -g @agenticbro/agentcli
```

Requires Node >= 20.

## Quick start

```bash
# Register a stdio MCP server
agentcli server add github -- npx -y @modelcontextprotocol/server-github

# Or a Streamable HTTP server
agentcli server add feishu --url https://feishu.example.com/mcp --header "Authorization: Bearer $TOKEN"

# Discover
agentcli server list
agentcli github --help              # list the server's tools
agentcli github search_issue --help # generated usage from the tool's JSON schema

# Execute
agentcli github search_issue --repo apache/hertzbeat --query "memory leak" --output text
```

## Commands

| Command | Purpose |
|---|---|
| `agentcli server add <name> -- <command...>` | Register a stdio server |
| `agentcli server add <name> --url <url>` | Register a Streamable HTTP server (`--header` repeatable) |
| `agentcli server list` | Configured servers (JSON by default, `-o text` for humans) |
| `agentcli server tools <name>` | Tools a server exposes (`--refresh` bypasses cache) |
| `agentcli server remove <name>` | Unregister |
| `agentcli <server> --help` | List tools |
| `agentcli <server> <tool> --help` | Generated usage for one tool |
| `agentcli <server> <tool> --schema` | Raw JSON Schema of the tool input |
| `agentcli <server> <tool> [flags]` | Execute |

### Flags

The tool's JSON Schema is compiled to flags — for top-level primitives:

| Schema type | Flag form |
|---|---|
| `string` | `--name value` or `--name=value` |
| `string` + `enum` | `--name choice` (validated) |
| `integer` / `number` | `--name 3` (parsed, validated) |
| `boolean` | `--name` or `--name=false` |
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
  "meta": { "durationMs": 189, "schemaCached": true }
}
```

`data` is `structuredContent` if the server sent one; otherwise text content is
parsed as JSON when it parses, passed through as text when it doesn't.

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

- **Tool-list cache**: `tools/list` results are cached next to the config (default TTL 10 min);
  `--refresh` bypasses, `AGENTCLI_TTL_MS` / `AGENTCLI_TIMEOUT_MS` tune TTL and request timeout.
- **Credential isolation**: spawned stdio servers receive only a small env whitelist
  (`PATH`, `HOME`, …) plus explicit `--env KEY=value`; nothing else leaks from the agent's environment.
- **Config**: `~/.agentcli/config.json` (override with `AGENTCLI_CONFIG` or `--config <path>`).
- Server names are reserved if they collide with built-ins (`server`, `call`, `help`, …).

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
npm test    # e2e suite: spawns a real MCP stdio fixture server (fixtures/echo-server.mjs)
```

## Out of scope (for now)

Hierarchical namespaces (`github issue search`), semantic search, native CLI / HTTP-API
adapters, auth `login` flows, policy engine, daemon mode. See the design proposal for the
full roadmap — protocol details above are considered stable commitments and will not change
casually.