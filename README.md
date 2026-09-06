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

Agents that register every MCP tool upfront pay for it in context: hundreds of schemas loaded at startup, most never used. A CLI flips the model to **progressive disclosure**: discover with `--help`, drill down only as far as needed. stdout/stderr separation, a binary exit code (0/1), and self-describing JSON errors keep the whole thing machine-consumable.

## Install

```bash
pnpm add -g @happyvibing/agentcli  # or: npm install -g @happyvibing/agentcli
```

Requires Node >= 20.10. Or run from source: `git clone && pnpm install && pnpm build && pnpm link --global`.

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

## Agent Skill

`skills/agentcli/SKILL.md` teaches an agent this runtime — the discover → inspect → execute → observe loop and self-describing error recovery. Install it with the skills CLI (also listed on [skills.sh](https://skills.sh)):

```bash
npx skills add happyvibing/agentcli@agentcli -g
```
