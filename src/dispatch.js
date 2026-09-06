// Dispatch `agentcli <server> <tool> [flags]` — the core execution path.
// Hand-rolled token parsing (commander is bypassed for the dynamic part).
import { listTools, callTool } from "./client.js";
import { suggest } from "./fuzzy.js";
import { buildFlagPlan, parseToolArgs, readInputJson, mergeArgs, renderToolHelp, validateRequired } from "./flags.js";
import { errors, EXIT } from "./errors.js";
import { printJson } from "./jsonout.js";

function firstLine(text) {
  return String(text || "").split("\n")[0];
}

function extractText(result) {
  return (result.content || [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// Some servers return JSON.stringify(JSON.stringify(payload)) — text content that
// is still a JSON string after one parse. Unwrap while it stays a string (bounded).
function parseMaybeEncoded(text, maxDepth = 3) {
  let v = text;
  for (let i = 0; typeof v === "string" && i <= maxDepth; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      break;
    }
  }
  return v;
}

// Result -> data:
//   structuredContent if the server sent one;
//   else if all items are text: parsed JSON (double-encoded strings unwrapped),
//   joined text when it is not JSON;
//   else pass the content items through.
function extractData(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const items = result.content || [];
  if (items.length === 0) return null;
  if (items.every((c) => c && c.type === "text")) {
    return parseMaybeEncoded(items.map((c) => c.text).join("\n"));
  }
  return { content: items };
}

function toolNotFound(serverName, toolName, tools) {
  const similar = suggest(toolName, tools.map((t) => t.name)).slice(0, 5);
  const hints = [];
  if (similar.length) hints.push("Similar tools: " + similar.join(", "));
  hints.push("List tools: agentcli " + serverName + " --help");
  return errors.notFound('tool "' + toolName + '" not found on server "' + serverName + '"', hints.join(" | "));
}

async function printServerHelp(cfg, serverName, refresh) {
  const { tools } = await listTools(cfg, serverName, { refresh });
  const lines = [serverName + " — MCP server (" + tools.length + " tools)", "", "Usage:", "  agentcli " + serverName + " <tool> [flags]", "", "Tools:"];
  for (const t of tools) {
    const name = String(t.name);
    const pad = name.length >= 28 ? "  " : " ".repeat(28 - name.length);
    lines.push("  " + name + pad + firstLine(t.description));
  }
  lines.push("", "  agentcli " + serverName + " <tool> --help    Help for a specific tool");
  console.log(lines.join("\n"));
  return EXIT.OK;
}

export async function runServerCommand(cfg, serverName, tail) {
  // 1. server-level help: `agentcli <server>` or `agentcli <server> --help`
  if (tail.length === 0 || tail[0] === "--help" || tail[0] === "-h") {
    return printServerHelp(cfg, serverName, tail.includes("--refresh"));
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
  const { tools, cached } = await listTools(cfg, serverName, { refresh: rest.includes("--refresh"), daemon: !noDaemon });
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
    args = mergeArgs(readInputJson(opts.input), flagArgs);
  }
  validateRequired(plan, args);
  const output = opts.output || "json";
  if (output !== "json" && output !== "text") {
    throw errors.invalidArgument('invalid --output "' + output + '"', "Supported: json, text");
  }

  const timeoutMs = opts["timeout-ms"] !== undefined ? Number(opts["timeout-ms"]) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw errors.invalidArgument("invalid --timeout-ms", "Must be a positive number of milliseconds");
  }

  // 4. execute
  const started = Date.now();
  const { result, via } = await callTool(cfg, serverName, toolName, args, { timeoutMs, daemon: !noDaemon });

  if (result.isError) {
    throw errors.execution(extractText(result) || "tool reported an error without a message");
  }

  // 5. observe
  if (output === "text") {
    const text = extractText(result);
    if (text === "") {
      // Non-text content items: fall back to the machine-readable form.
      process.stdout.write(JSON.stringify(extractData(result)) + "\n");
    } else {
      // Double-encoded JSON pretty-prints; genuine prose passes through raw.
      const v = parseMaybeEncoded(text);
      const out = v !== null && typeof v === "object" ? JSON.stringify(v, null, 2) : text;
      process.stdout.write(out + "\n");
    }
    return EXIT.OK;
  }
  printJson({
    ok: true,
    server: serverName,
    tool: toolName,
    data: extractData(result),
    meta: { durationMs: Date.now() - started, schemaCached: cached, via },
  });
  return EXIT.OK;
}