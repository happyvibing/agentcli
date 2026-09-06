// Shared types used across the codebase.
// ToolDef is the unified internal tool contract: every backend (MCP, OpenAPI,
// future ones) produces these; dispatch/flags consume them backend-agnostically.

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

export interface OpenApiServerSpec {
  type: "openapi";
  spec: string; // absolute path to the local snapshot
  origin: string; // original source: URL or absolute file path (--refresh re-pulls)
  baseUrl?: string; // overrides spec.servers[0].url
  headers?: Record<string, string>; // may contain ${ENV_VAR} placeholders
}

export type ServerSpec = StdioServerSpec | HttpServerSpec | OpenApiServerSpec;

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

// The unified tool definition (formerly McpTool). MCP tool listings map 1:1;
// the OpenAPI compiler emits these from spec operations.
export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: ToolInputSchema;
  tags?: string[];
  // OpenAPI backend only: execution metadata (method/path/param locations).
  openapiMeta?: OpenApiOperationMeta;
  [key: string]: unknown;
}

// Execution metadata embedded in ToolDef by the OpenAPI compiler and consumed
// by the OpenAPI executor. All maps are flagName -> original spec name.
export interface OpenApiOperationMeta {
  method: string; // uppercase HTTP method
  path: string; // path template, e.g. /pets/{petId}
  baseUrl: string; // resolved base URL (override or spec.servers[0])
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  headerParams: Record<string, string>;
  bodyProps: Record<string, string>; // flagName -> body property name
  rawBody?: string; // flagName holding the whole request body (non-object body schemas)
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
  tools: ToolDef[];
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

export interface DaemonStatusData {
  pid: number;
  startedAt: number;
  uptimeMs: number;
  requests: number;
  toolCalls: number;
  connectedServers: string[];
  socket: string;
}