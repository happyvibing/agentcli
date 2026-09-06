import { Command } from "commander";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, addServer, removeServer, writeToolsCache } from "./config.js";
import { AgentCliError, errors, EXIT } from "./errors.js";
import { printError, printJson } from "./jsonout.js";
import { runServerCommand } from "./dispatch.js";
import { openBackend } from "./backend/index.js";
import { snapshotSpec, snapshotPath } from "./openapi/specstore.js";
import { compileSpec } from "./openapi/compile.js";
import { startDaemon, stopDaemon, daemonStatus } from "./daemon/lifecycle.js";
import { suggest } from "./fuzzy.js";
import type { AgentCliConfig, ServerSpec, StdioServerSpec, HttpServerSpec, OpenApiServerSpec } from "./types.js";

const { version } = pkg;

// Built-in top-level commands (everything else that matches a configured
// server name is dispatched dynamically).
const KNOWN_BUILTINS = new Set(["server", "daemon", "help", "version"]);

function exitWithError(e: unknown): void {
  if (e instanceof AgentCliError) {
    printError(e);
    process.exitCode = EXIT.FAILURE;
    return;
  }
  const err = e as Error & { code?: string };
  if (err && typeof err.code === "string" && err.code.startsWith("commander.")) {
    // help/version output has already been written by commander
    if (err.code === "commander.help" || err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      process.exitCode = EXIT.OK;
      return;
    }
    const isUnknownCommand = err.code === "commander.unknownCommand";
    printError(
      new AgentCliError(isUnknownCommand ? "NOT_FOUND" : "INVALID_ARGUMENT", err.message.replace(/^error:\s*/, ""), {
        hint: "agentcli --help",
      })
    );
    process.exitCode = EXIT.FAILURE;
    return;
  }
  printError(new AgentCliError("INTERNAL", (err && err.stack) || String(e)));
  process.exitCode = EXIT.FAILURE;
}

function parseKeyValueList(list: string[] | undefined, flagName: string, expected: string, sep = "="): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of list || []) {
    const idx = kv.indexOf(sep);
    if (idx <= 0) throw errors.invalidArgument("invalid --" + flagName + ' "' + kv + '"', "Expected " + expected);
    out[kv.slice(0, idx).trim()] = kv.slice(idx + sep.length).trim();
  }
  return out;
}

function stripGlobalFlags(argv: string[]): { rest: string[]; configPath: string | undefined } {
  let configPath: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-c") {
      configPath = argv[++i];
      if (configPath === undefined) throw errors.invalidArgument("--config requires a path");
      continue;
    }
    if (a.startsWith("--config=")) {
      configPath = a.slice("--config=".length);
      continue;
    }
    rest.push(a);
  }
  return { rest, configPath };
}

// The dynamic `agentcli <server> <tool>` surface is invisible to commander's
// generated help, so surface configured servers explicitly -- top-level help is
// the discovery entry point for agents and humans alike.
function serversHelpSection(cfg: AgentCliConfig): string {
  const entries = Object.entries(cfg.servers);
  if (entries.length === 0) {
    return [
      "",
      "No servers configured yet:",
      "  agentcli server add <name> -- <command...> [args...]   # stdio MCP server",
      "  agentcli server add <name> --url <http-url>            # Streamable HTTP MCP server",
      "  agentcli server add <name> --openapi <spec.json|url>   # OpenAPI 3.x API",
      "",
    ].join("\n");
  }
  const lines = entries.map(([name, spec]: [string, ServerSpec]) => {
    const kind = spec.type === "http" ? "http" : spec.type === "openapi" ? "openapi" : "stdio";
    const detail = spec.type === "http" ? spec.url : spec.type === "openapi" ? spec.origin : [spec.command, ...(spec.args || [])].join(" ");
    return "  " + name.padEnd(16) + kind + " - " + detail;
  });
  return [
    "",
    "Configured servers (agentcli <server> <tool> ...):",
    ...lines,
    "  agentcli <server> --help    List a server's tools",
    "",
  ].join("\n");
}

function buildBuiltins(cfg: AgentCliConfig): Command {
  const program = new Command();
  program
    .name("agentcli")
    .version(version)
    .description("AgentCLI -- call MCP servers and OpenAPI APIs from the command line.")
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  program.addHelpText("after", serversHelpSection(cfg));

  const server = program.command("server").description("Manage configured servers (MCP or OpenAPI).");
  server.addHelpText(
    "after",
    "\nConfigured servers: " + (Object.keys(cfg.servers).join(", ") || "none") + "\n  agentcli server list    Details as JSON\n"
  );

  server
    .command("add <name>")
    .description("Register a server: stdio via `-- <command...>`, HTTP via --url, or an OpenAPI 3.x spec via --openapi.")
    .option("--url <url>", "Streamable HTTP endpoint of the MCP server")
    .option("--openapi <spec>", "OpenAPI 3.x JSON spec (local path or URL) — every operation becomes a tool")
    .option("--base-url <url>", "Override the API base URL (with --openapi)")
    .option("--header <name:value...>", "HTTP header sent on every request (repeatable; ${ENV_VAR} placeholders expand at call time)")
    .option("--env <key=value...>", "Extra env vars for a stdio server (repeatable)")
    .argument("[cmd...]", "stdio server command and args (after --)")
    .action(async (name: string, cmd: string[], opts: { url?: string; openapi?: string; baseUrl?: string; header?: string[]; env?: string[] }) => {
      const current = loadConfig();
      if (opts.openapi) {
        if (opts.url) throw errors.invalidArgument("--openapi and --url are mutually exclusive");
        if (cmd && cmd.length) throw errors.invalidArgument("--openapi and a command are mutually exclusive");
        // fail fast: snapshot + compile at add time so bad specs never register
        const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(opts.openapi);
        const origin = hasScheme ? opts.openapi : path.resolve(opts.openapi);
        const doc = await snapshotSpec(name, origin);
        const tools = compileSpec(doc, { baseUrl: opts.baseUrl, originUrl: hasScheme ? origin : undefined });
        const spec: OpenApiServerSpec = {
          type: "openapi",
          spec: snapshotPath(name),
          origin,
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          headers: parseKeyValueList(opts.header, "header", '"Name: value"', ":"),
        };
        addServer(current, name, spec);
        writeToolsCache(name, tools);
        printJson({ ok: true, server: name, operations: tools.length, config: process.env.AGENTCLI_CONFIG });
        return;
      }
      if (opts.url) {
        if (cmd && cmd.length) throw errors.invalidArgument("--url and a command are mutually exclusive");
        const spec: HttpServerSpec = { type: "http", url: opts.url, headers: parseKeyValueList(opts.header, "header", '"Name: value"', ":") };
        addServer(current, name, spec);
      } else {
        if (!cmd || cmd.length === 0) {
          throw errors.invalidArgument(
            "a stdio server needs a command",
            "agentcli server add <name> -- <command...> [args...]   |   agentcli server add <name> --url <http-url>   |   agentcli server add <name> --openapi <spec>"
          );
        }
        const [command, ...args] = cmd;
        const spec: StdioServerSpec = { type: "stdio", command, args, env: parseKeyValueList(opts.env, "env", "KEY=value") };
        addServer(current, name, spec);
      }
      printJson({ ok: true, server: name, config: process.env.AGENTCLI_CONFIG });
    });

  server
    .command("list")
    .description("List configured servers.")
    .option("-o, --output <fmt>", "json | text (default: json)")
    .action((opts: { output?: string }) => {
      const current = loadConfig();
      const rows: Array<{ name: string; type: string; command?: string; url?: string; origin?: string }> = Object.entries(current.servers).map(([name, spec]: [string, ServerSpec]) => {
        if (spec.type === "http") return { name, type: spec.type, url: spec.url };
        if (spec.type === "openapi") return { name, type: spec.type, origin: spec.origin };
        return { name, type: spec.type, command: [spec.command, ...(spec.args || [])].join(" ") };
      });
      if (opts.output === "text") {
        for (const r of rows) console.log(r.name.padEnd(16) + r.type.padEnd(8) + (r.command || r.url || r.origin || ""));
        return;
      }
      printJson({ ok: true, data: rows });
    });

  server
    .command("remove <name>")
    .description("Remove a configured server.")
    .action((name: string) => {
      removeServer(loadConfig(), name);
      printJson({ ok: true, removed: name });
    });

  server
    .command("tools <name>")
    .description("List the tools a server exposes.")
    .option("--refresh", "Bypass the tools cache (OpenAPI: also re-pull the spec from its origin)")
    .option("-o, --output <fmt>", "json | text (default: json)")
    .action(async (name: string, opts: { refresh?: boolean; output?: string }) => {
      const { tools } = await openBackend(loadConfig(), name).listTools({ refresh: !!opts.refresh });
      if (opts.output === "text") {
        for (const t of tools) console.log(String(t.name).padEnd(28) + String(t.description || "").split("\n")[0]);
        return;
      }
      printJson({
        ok: true,
        data: tools.map((t) => ({ name: t.name, description: t.description || "" })),
      });
    });

  const daemon = program
    .command("daemon")
    .description("Manage the background daemon (persistent MCP connections, fast repeated calls).")
    .action((_opts: unknown, cmd: Command) => cmd.help());

  daemon
    .command("start")
    .description("Start the daemon in the background (persists after this command exits).")
    .option("-f, --foreground", "Run in the foreground (logs to console; Ctrl-C stops it)")
    .action(async (opts: { foreground?: boolean }) => {
      const r = await startDaemon({ foreground: !!opts.foreground });
      printJson(r);
    });

  daemon
    .command("stop")
    .description("Stop a running daemon.")
    .action(async () => {
      printJson(await stopDaemon());
    });

  daemon
    .command("status")
    .description("Show whether the daemon runs, plus uptime and connected servers.")
    .action(async () => {
      printJson(await daemonStatus());
    });

  daemon
    .command("restart")
    .description("Stop then start the daemon.")
    .action(async () => {
      await stopDaemon();
      printJson(await startDaemon());
    });

  return program;
}

export async function run(argv: string[]): Promise<void> {
  try {
    const { rest, configPath } = stripGlobalFlags(argv);
    if (configPath) process.env.AGENTCLI_CONFIG = configPath;

    const cfg = loadConfig();
    const first = rest[0];

    if (first === "version") {
      console.log(version);
      return;
    }

    // Dynamic path: `agentcli <server> <tool> [flags...]`
    if (first && cfg.servers[first]) {
      const code = await runServerCommand(cfg, first, rest.slice(1));
      process.exitCode = code;
      return;
    }

    // Unknown top-level command that is not a configured server: richer error
    // than commander's generic one -- suggest configured servers so agents can
    // self-correct without another roundtrip.
    if (first && !first.startsWith("-") && !cfg.servers[first] && !KNOWN_BUILTINS.has(first)) {
      const names = Object.keys(cfg.servers);
      const near = suggest(first, names);
      const hints: string[] = [];
      if (near.length) hints.push("Did you mean: " + near.join(", ") + "?");
      hints.push(
        names.length
          ? "Configured servers: " + names.join(", ")
          : "No servers configured -- agentcli server add <name> -- <command...>"
      );
      throw errors.notFound('unknown command "' + first + '"', hints.join(" | "));
    }

    // Built-ins: `agentcli server ...`, `agentcli daemon ...`, `agentcli --help`, ...
    const program = buildBuiltins(cfg);
    await program.parseAsync(rest, { from: "user" });
  } catch (e) {
    exitWithError(e);
  }
}