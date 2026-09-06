---
name: agentcli
description: Use the agentcli runtime to discover and execute tools from MCP servers and OpenAPI APIs via the command line. Use this skill whenever the user asks to work with external systems — GitHub, Feishu/Lark, Notion, Slack, databases, k8s, internal REST APIs — through MCP servers or OpenAPI specs, or whenever a task involves finding or calling tools via agentcli. Triggers include mentions of agentcli, MCP servers/tools, OpenAPI specs, or tasks like 'search GitHub issues', 'send a Feishu message', 'call the internal API' when a configured server may provide the capability.
license: MIT
metadata:
  compatibility: [claude-code, codex, cursor, opencode]
---

# AgentCLI

`agentcli` turns configured MCP servers and OpenAPI APIs into CLI commands. You
do not need to know what tools exist ahead of time — discover them at runtime.
Never dump tool docs into memory; look them up on demand.

## Core loop: discover → inspect → execute → observe

```bash
# 1. What servers are configured?
agentcli -h              # lists configured servers (and built-ins)
agentcli server list     # same, as JSON

# 2. What tools does a server have?
agentcli <server> -h

# 3. How is one tool called? (generated from its JSON schema — read before first use)
agentcli <server> <tool> -h

# 4. Execute
agentcli <server> <tool> --flag value --other-flag
```

Machine-readable schema instead of help text:

```bash
agentcli <server> <tool> --schema
```

## Registering servers

```bash
agentcli server add <name> -- <command...>                  # stdio MCP
agentcli server add <name> --url <url>                      # HTTP MCP
agentcli server add <name> --openapi <spec.json|url>        # OpenAPI 3.x API
                              [--base-url <url>] [--header "Authorization: Bearer ${ENV_VAR}"]
```

OpenAPI: every operation becomes a tool — path/query params and JSON body
properties are all flags. `${ENV_VAR}` in headers expands at call time; an
unset variable is AUTH_REQUIRED. Ask before adding servers.

## Rules

1. **Never guess flags.** If you have not seen this tool's `--help` in this session, run it first.
2. **stdout is data, stderr is errors.** Success output is JSON by default; parse it.
   A non-zero exit code means failure — read the one-line JSON on stderr and follow its `hint` if present.
3. **Default JSON wraps the payload in an envelope** — take results from `.data`.
   `--output text` is payload-only (no envelope): pretty-printed JSON for structured results, raw text for prose.
4. **Complex parameters go through `--input`**: object, nested, or anyOf values are not flags.

```bash
agentcli <server> <tool> --input '{"query":{"a":1},"tags":["x"]}'
agentcli <server> <tool> --input @payload.json    # file
echo '{}' | agentcli <server> <tool> --input -    # stdin
```

Flags override `--input` keys, so combining them is safe.

## Flag details

- `--flag=value` form works everywhere; use it when a value itself starts with `--`.
- Arrays: repeat the flag — `--tag a --tag b`.
- Booleans: presence means true (`--dry-run`), or explicit `--dry-run=false` / `--dry-run false`.
- Numbers are validated; enums reject invalid choices and list allowed values.
- Some tools document allowed values in their description text instead of a real enum
  (`Available values: ...`). Those are NOT validated client-side — read the description
  carefully and copy the literal value (e.g. `oneMonth`, not "one month").

## Errors

Exit code is binary: 0 = success (parse stdout), 1 = failure (read stderr).
Every failure prints one self-describing JSON line to stderr — no lookup table needed:
```
{"ok":false,"error":{"code":"CONNECT_FAILED","message":"github: spawn failed","hint":"check server config/env or `agentcli daemon` state; do not blind-retry"}}
```
- `code` names the class: INVALID_ARGUMENT | NOT_FOUND | AUTH_REQUIRED | TIMEOUT | CONNECT_FAILED | EXECUTION_ERROR | INTERNAL
- `message` is the diagnosis; `hint` (when present) is the recommended next action — follow it.
- OpenAPI servers map HTTP statuses onto the same codes: 401/403 → AUTH_REQUIRED, 404 → NOT_FOUND, other 4xx/5xx → EXECUTION_ERROR (details carry httpStatus and the API's own error message).

## Composability

Results are plain JSON on stdout, so pipes and jq work:

```bash
agentcli github search_issue --repo org/repo --query "leak" --output text \
  | jq -r '.[] | "\(.number) \(.title)"'
```

Prefer filtering with tool flags or `jq` over loading everything into context.

## Housekeeping

- Tool listings are cached (10 min). Use `--refresh` if a server's tools changed
  (for OpenAPI servers it also re-pulls the spec from its origin).
- `meta.via` in the result envelope says `daemon` (persistent MCP connection) or `direct`;
  OpenAPI calls are always `direct`. Purely informational.
- A background daemon (`agentcli daemon start`) holds MCP server connections so repeated
calls return in milliseconds; calls route through it automatically. Force the
per-call path with `--no-daemon` or `AGENTCLI_NO_DAEMON=1` if it misbehaves.