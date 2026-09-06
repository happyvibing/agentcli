// Shared types used across the codebase.

export interface StdioServerSpec {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpServerSpec {
  type: "http";
  url: string;
  headers?: Record<string, string> | string[];
}

export type ServerSpec = StdioServerSpec | HttpServerSpec;

export interface AgentCliConfig {
  version: 1;
  servers: Record<string, ServerSpec>;
}

export interface ToolInputSchema {
  type?: string;
  properties?: Record<string, ToolPropertySchema>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolPropertySchema {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type?: string };
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
  $ref?: string;
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: ToolInputSchema;
  [key: string]: unknown;
}

export interface FlagSpec {
  name: string;
  type: string;
  itemType?: string;
  enum?: string[];
  default?: unknown;
  description: string;
  required: boolean;
}

export interface ComplexParam {
  name: string;
  description: string;
}

export interface FlagPlan {
  flags: Map<string, FlagSpec>;
  complex: ComplexParam[];
  required: string[];
}

export interface ToolsCache {
  tools: McpTool[];
  fetchedAt: number;
}

export interface DaemonRequestPayload {
  id: number;
  op: string;
  server?: string;
  tool?: string;
  args?: Record<string, unknown>;
  refresh?: boolean;
  timeoutMs?: number;
}

export interface DaemonResponse {
  id: number | null;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    hint?: string;
    details?: unknown;
  };
}

export interface CallToolResultEnvelope {
  result: unknown;
  via: "daemon" | "direct";
}

export interface ListToolsResultEnvelope {
  tools: McpTool[];
  cached: boolean;
  via: "daemon" | "direct";
}

export interface DaemonStatusData {
  pid: number;
  startedAt: number;
  uptimeMs: number;
  requests: number;
  toolCalls: number;
  connectedServers: string[];
  socket: string;
}
