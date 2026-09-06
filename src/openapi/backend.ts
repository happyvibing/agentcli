// OpenAPI backend: serves ToolDefs compiled from the spec snapshot and executes
// them over plain HTTP. Stateless — no daemon involvement; `via` is "direct".
import { readToolsCache, writeToolsCache } from "../config.js";
import { ttlFromEnv, timeoutFromEnv } from "../client.js";
import { errors } from "../errors.js";
import type { OpenApiServerSpec, ToolDef } from "../types.js";
import type { Backend, ListToolsResult, ToolResult } from "../backend/types.js";
import { compileSpec } from "./compile.js";
import { isHttpUrl, loadSnapshotDoc, refreshSnapshot } from "./specstore.js";
import { executeOperation } from "./exec.js";

export function openApiBackend(name: string, spec: OpenApiServerSpec): Backend {
  async function listToolsInternal({ refresh = false, timeoutMs }: { refresh?: boolean; timeoutMs?: number } = {}): Promise<ListToolsResult> {
    if (!refresh) {
      const cached = readToolsCache(name, ttlFromEnv());
      if (cached && cached.fresh) return { tools: cached.tools, cached: true, via: "direct" };
    } else {
      // --refresh: re-pull the spec from its origin (URL or local file)
      await refreshSnapshot(name, spec.origin, timeoutMs);
    }
    const doc = await loadSnapshotDoc(name, spec.origin);
    const tools = compileSpec(doc, { baseUrl: spec.baseUrl, originUrl: isHttpUrl(spec.origin) ? spec.origin : undefined });
    writeToolsCache(name, tools);
    return { tools, cached: false, via: "direct" };
  }

  return {
    kind: "openapi",
    async listTools(opts = {}): Promise<ListToolsResult> {
      return listToolsInternal(opts);
    },
    async callTool(tool: string, args: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<{ result: ToolResult; via: "direct" }> {
      const { tools } = await listToolsInternal();
      const def = tools.find((t: ToolDef) => t.name === tool);
      if (!def || !def.openapiMeta) {
        throw errors.notFound('tool "' + tool + '" not found on server "' + name + '"', "List tools: agentcli " + name + " --help");
      }
      const result = await executeOperation(name, spec, def.openapiMeta, args, opts.timeoutMs ?? timeoutFromEnv());
      return { result, via: "direct" };
    },
  };
}