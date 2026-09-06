# AgentCLI

**One CLI. Any tool backend.** Call MCP servers and OpenAPI (REST) APIs from the command line — dynamically, with no per-tool wrapper code.

> ```bash
> $ agentcli github search_issues --repo apache/hertzbeat --query "memory leak"
> { "ok": true, "server": "github", "tool": "search_issues",
>   "data": [ { "number": 123, "title": "Memory leak in collector" } ],
>   "meta": { "durationMs": 412, "via": "daemon" } }
> ```

Every MCP tool — and every OpenAPI operation — becomes a CLI command the first time you type it. Flags are compiled from the tool's JSON Schema on the fly.

## Why

Agents that register every tool upfront pay for it in context: hundreds of schemas loaded at startup, most never used. A CLI flips the model to **progressive disclosure**: discover with `--help`, drill down only as far as needed. stdout/stderr separation, a binary exit code (0/1), and self-describing JSON errors keep the whole thing machine-consumable.

The same loop works for both backend kinds:

| Backend | Register | Tools come from |
|---|---|---|
| MCP (stdio / HTTP) | `agentcli server add <name> -- <command...>` or `--url` | `tools/list` over the protocol |
| OpenAPI 3.x | `agentcli server add <name> --openapi <spec.json|url>` | the spec — every operation becomes a tool |

## Install

```bash
pnpm add -g @happyvibing/agentcli  # or: npm install -g @happyvibing/agentcli
```

Requires Node >= 20.10. Or run from source: `git clone && pnpm install && pnpm build && pnpm link --global`.

## Quick start (MCP)

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

## OpenAPI APIs

Register an OpenAPI 3.x JSON spec and every operation becomes a CLI command — same discovery, same flags, same output envelope:

```bash
# Register (the spec is snapshotted locally; --refresh re-pulls it)
agentcli server add petstore --openapi https://petstore3.swagger.io/api/v3/openapi.json \
  --header "Authorization: Bearer ${PETSTORE_TOKEN}"   # ${ENV} expands at call time

# Discover — operations grouped by their spec tags
agentcli petstore -h

# Execute — path/query params and JSON body properties are all flags
agentcli petstore getPetById --petId 1
agentcli petstore addPet --name rex --kind dog
```

How an OpenAPI spec maps onto the CLI:

- **operationId** becomes the tool name (missing ones get a mechanical slug like `get_pets_petId`)
- path / query / header parameters and **request-body properties flatten into flags** — `POST /pets {name, tag}` is `--name x --tag y`
- HTTP failures map to the same error codes: 401/403 → `AUTH_REQUIRED`, 404 → `NOT_FOUND`, other 4xx/5xx → `EXECUTION_ERROR` with `httpStatus` in details
- OpenAPI calls are stateless HTTP — `meta.via` is always `direct` (no daemon involved)

Swagger 2.0 and YAML specs are rejected with an upgrade/conversion hint. Local spec files work too (`--openapi ./api.json`) — useful for internal APIs.

## Architecture

The core only knows "tools + JSON Schema". Backends produce tool definitions; everything below (flag compiler, help, output, caching, errors) is shared:

```
agentcli <server> <tool> --flags
          │
    dispatch (backend-agnostic)
          │        ToolDef { name, description, inputSchema }
   ┌──────┴──────┐
 McpBackend    OpenApiBackend
 daemon/direct snapshot → compile → fetch
```

## Agent Skill

`skills/agentcli/SKILL.md` teaches an agent this runtime — the discover → inspect → execute → observe loop and self-describing error recovery. Install it with the skills CLI (also listed on [skills.sh](https://skills.sh)):

```bash
npx skills add happyvibing/agentcli@agentcli -g
```