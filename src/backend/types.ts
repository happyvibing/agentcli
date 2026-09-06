// The Backend contract — the single unification point of the runtime.
// Core (dispatch/flags/help/output) only ever sees ToolDef in and ToolResult
// out; protocol shapes (MCP content arrays, HTTP responses) are converted
// inside each backend and never cross this boundary.
import type { ToolDef } from "../types.js";

// Neutral result: every backend converts its native result into this shape.
//   data — machine-readable payload (JSON envelope `data`, jq-ready)
//   text — raw human-readable text, when the source produced one
//   isError — the tool ran but reported a logical error (MCP isError)
export interface ToolResult {
  data: unknown;
  text?: string;
  isError?: boolean;
}

export interface ListToolsResult {
  tools: ToolDef[];
  cached: boolean;
  via: "daemon" | "direct";
}

export interface CallToolResult {
  result: ToolResult;
  via: "daemon" | "direct";
}

export interface ListToolsOptions {
  refresh?: boolean;
  timeoutMs?: number;
}

export interface CallToolOptions {
  timeoutMs?: number;
  daemon?: boolean; // MCP only; the OpenAPI backend is always direct
}

export interface Backend {
  readonly kind: "mcp" | "openapi";
  listTools(opts?: ListToolsOptions): Promise<ListToolsResult>;
  callTool(tool: string, args: Record<string, unknown>, opts?: CallToolOptions): Promise<CallToolResult>;
}