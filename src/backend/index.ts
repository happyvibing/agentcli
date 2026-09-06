// Backend factory: dispatches on the configured server spec type. Everything
// above this line (dispatch.ts, help, output) is backend-agnostic.
import { errors } from "../errors.js";
import type { AgentCliConfig } from "../types.js";
import type { Backend } from "./types.js";
import { mcpBackend } from "./mcp.js";
import { openApiBackend } from "../openapi/backend.js";

export function openBackend(cfg: AgentCliConfig, serverName: string): Backend {
  const spec = cfg.servers[serverName];
  if (!spec) {
    throw errors.notFound(
      'server "' + serverName + '" is not configured',
      "Add one: agentcli server add " + serverName + " -- <command...>   |   --url <http-url>   |   --openapi <spec>"
    );
  }
  if (spec.type === "openapi") return openApiBackend(serverName, spec);
  return mcpBackend(cfg, serverName);
}

export type { Backend, ToolResult, ListToolsResult, CallToolResult } from "./types.js";