// Dispatch `agentcli <server> <tool> [flags]` — the core execution path.
// Backend-agnostic: all server interaction goes through the Backend contract.
import { openBackend } from "./backend/index.js";
import type { Backend } from "./backend/types.js";
import { suggest } from "./fuzzy.js";
import { buildFlagPlan, parseToolArgs, readInputJson, mergeArgs, renderToolHelp, validateRequired } from "./flags.js";
import { errors, EXIT } from "./errors.js";
import { printJson } from "./jsonout.js";
import type { AgentCliConfig, ToolDef } from "./types.js";

function firstLine(text: string | undefined): string {
  return String(text || "").split("\n")[0];
}

function toolNotFound(serverName: string, toolName: string, tools: ToolDef[]): Error {
  const similar = suggest(toolName, tools.map((t) => t.name)).slice(0, 5);
  const hints: string[] = [];
  if (similar.length) hints.push("Similar tools: " + similar.join(", "));
  hints.push("List tools: agentcli " + serverName + " --help");
  return errors.notFound('tool "' + toolName + '" not found on server "' + serverName + '"', hints.join(" | "));
}

function kindLabel(backend: Backend): string {
  return backend.kind === "openapi" ? "OpenAPI server" : "MCP server";
}

function printServerHelp(backend: Backend, serverName: string, tools: ToolDef[]): number {
  const lines = [serverName + " — " + kindLabel(backend) + " (" + tools.length + " tools)", "", "Usage:", "  agentcli " + serverName + " <tool> [flags]", ""];
  const row = (t: ToolDef) => {
    const name = String(t.name);
    const pad = name.length >= 28 ? "  " : " ".repeat(28 - name.length);
    return "  " + name + pad + firstLine(t.description);
  };
  if (tools.some((t) => t.tags && t.tags.length)) {
    // Group by first tag (spec order preserved); untagged tools go last.
    const groups = new Map<string, ToolDef[]>();
    const untagged: ToolDef[] = [];
    for (const t of tools) {
      const g = t.tags && t.tags[0];
      if (g) {
        if (!groups.has(g)) groups.set(g, []);
        (groups.get(g) as ToolDef[]).push(t);
      } else {
        untagged.push(t);
      }
    }
    for (const [tag, list] of groups) {
      lines.push(tag + ":");
      for (const t of list) lines.push(row(t));
      lines.push("");
    }
    if (untagged.length) {
      lines.push("other:");
      for (const t of untagged) lines.push(row(t));
      lines.push("");
    }
    lines.push("  agentcli " + serverName + " <tool> --help    Help for a specific tool");
    console.log(lines.join("\n"));
    return EXIT.OK;
  }
  lines.push("Tools:");
  for (const t of tools) lines.push(row(t));
  lines.push("", "  agentcli " + serverName + " <tool> --help    Help for a specific tool");
  console.log(lines.join("\n"));
  return EXIT.OK;
}

export async function runServerCommand(cfg: AgentCliConfig, serverName: string, tail: string[]): Promise<number> {
  const backend = openBackend(cfg, serverName);

  // 1. server-level help: `agentcli <server>` or `agentcli <server> --help`
  if (tail.length === 0 || tail[0] === "--help" || tail[0] === "-h") {
    const { tools } = await backend.listTools({ refresh: tail.includes("--refresh") });
    return printServerHelp(backend, serverName, tools);
  }

  const toolName = tail[0];
  if (toolName.startsWith("-")) {
    throw errors.invalidArgument('expected a tool name after "' + serverName + '", got "' + toolName + '"', "agentcli " + serverName + " --help lists tools");
  }
  const rest = tail.slice(1);

  // 2. tool-level help / schema need the tool definition
  const wantsHelp = rest.includes("--help") || rest.includes("-h");
  const wantsSchema = rest.includes("--schema");
  const noDaemon = rest.includes("--no-daemon");
  const { tools, cached } = await backend.listTools({ refresh: rest.includes("--refresh") });
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) throw toolNotFound(serverName, toolName, tools);

  if (wantsHelp) {
    console.log(renderToolHelp(serverName, tool));
    return EXIT.OK;
  }
  if (wantsSchema) {
    printJson(tool.inputSchema || { type: "object" });
    return EXIT.OK;
  }

  // 3. parse flags against the schema plan, merge with --input
  const plan = buildFlagPlan(tool.inputSchema);
  const { args: flagArgs, opts } = parseToolArgs(plan, rest);
  let args = flagArgs;
  if (opts.input !== undefined) {
    args = mergeArgs(readInputJson(opts.input as string), flagArgs);
  }
  validateRequired(plan, args);
  const output = (opts.output as string) || "json";
  if (output !== "json" && output !== "text") {
    throw errors.invalidArgument('invalid --output "' + output + '"', "Supported: json, text");
  }

  const timeoutMs = opts["timeout-ms"] !== undefined ? Number(opts["timeout-ms"]) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw errors.invalidArgument("invalid --timeout-ms", "Must be a positive number of milliseconds");
  }

  // 4. execute
  const started = Date.now();
  const { result, via } = await backend.callTool(toolName, args, { timeoutMs, daemon: !noDaemon });

  if (result.isError) {
    throw errors.execution(result.text || "tool reported an error without a message");
  }

  // 5. observe
  if (output === "text") {
    const out = result.data !== null && typeof result.data === "object" ? JSON.stringify(result.data, null, 2) : result.text ?? JSON.stringify(result.data);
    process.stdout.write(out + "\n");
    return EXIT.OK;
  }
  printJson({
    ok: true,
    server: serverName,
    tool: toolName,
    data: result.data,
    meta: { durationMs: Date.now() - started, schemaCached: cached, via },
  });
  return EXIT.OK;
}