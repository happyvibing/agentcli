// MCP backend: adapts the MCP client path (daemon/direct, client.ts) to the
// neutral Backend contract. MCP-specific result parsing lives here — it never
// leaks past this boundary.
import { listTools as mcpListTools, callTool as mcpCallTool } from "../client.js";
import type { AgentCliConfig, ToolDef } from "../types.js";
import type { Backend, CallToolResult, ListToolsOptions, ListToolsResult, ToolResult } from "./types.js";

interface McpContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface McpCallToolResult {
  content?: McpContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
}

function extractText(result: McpCallToolResult): string {
  return (result.content || [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
}

// Some servers return JSON.stringify(JSON.stringify(payload)) — text content that
// is still a JSON string after one parse. Unwrap while it stays a string (bounded).
function parseMaybeEncoded(text: string, maxDepth = 3): unknown {
  let v: unknown = text;
  for (let i = 0; typeof v === "string" && i <= maxDepth; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      break;
    }
  }
  return v;
}

// MCP result -> neutral ToolResult:
//   structuredContent if the server sent one;
//   else if all items are text: parsed JSON (double-encoded strings unwrapped),
//   joined text when it is not JSON;
//   else pass the content items through.
function toToolResult(mcp: McpCallToolResult): ToolResult {
  let data: unknown;
  if (mcp.structuredContent !== undefined) {
    data = mcp.structuredContent;
  } else {
    const items = mcp.content || [];
    if (items.length === 0) {
      data = null;
    } else if (items.every((c) => c && c.type === "text")) {
      data = parseMaybeEncoded(items.map((c) => c.text || "").join("\n"));
    } else {
      data = { content: items };
    }
  }
  const text = extractText(mcp);
  return { data, text: text === "" ? undefined : text, isError: !!mcp.isError };
}

export function mcpBackend(cfg: AgentCliConfig, serverName: string): Backend {
  return {
    kind: "mcp",
    async listTools(opts: ListToolsOptions = {}): Promise<ListToolsResult> {
      const { tools, cached, via } = await mcpListTools(cfg, serverName, opts);
      return { tools: tools as ToolDef[], cached, via };
    },
    async callTool(tool: string, args: Record<string, unknown>, opts: { timeoutMs?: number; daemon?: boolean } = {}): Promise<CallToolResult> {
      const { result, via } = await mcpCallTool(cfg, serverName, tool, args, opts);
      return { result: toToolResult(result as McpCallToolResult), via };
    },
  };
}