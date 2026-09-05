import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, addServer, removeServer } from "./config.js";
import { AgentCliError, errors, EXIT } from "./errors.js";
import { printError, printJson } from "./jsonout.js";
import { runServerCommand } from "./dispatch.js";
import { listTools } from "./client.js";
import { startDaemon, stopDaemon, daemonStatus } from "./daemon/lifecycle.js";
import { suggest } from "./fuzzy.js";

const { version } = pkg;

// Built-in top-level commands (everything else that matches a configured
// server name is dispatched dynamically).
const KNOWN_BUILTINS = new Set(["server", "daemon", "help", "version"]);

function exitWithError(e) {
  if (e instanceof AgentCliError) {
    printError(e);
    process.exitCode = e.exitCode;
    return;
  }
  if (e && typeof e.code === "string" && e.code.startsWith("commander.")) {
    // help/version output has already been written by commander
    if (e.code === "commander.help" || e.code === "commander.helpDisplayed" || e.code === "commander.version") {
      process.exitCode = EXIT.OK;
      return;
    }
    const isUnknownCommand = e.code === "commander.unknownCommand";
    printError(
      new AgentCliError(isUnknownCommand ? "NOT_FOUND" : "INVALID_ARGUMENT", e.message.replace(/^error:\s*/, ""), {
        exitCode: isUnknownCommand ? EXIT.NOT_FOUND : EXIT.INVALID_ARGUMENT,
        hint: "agentcli --help",
      })
    );
    process.exitCode = isUnknownCommand ? EXIT.NOT_FOUND : EXIT.INVALID_ARGUMENT;
    return;
  }
  printError(new AgentCliError("INTERNAL", (e && e.stack) || String(e)));
  process.exitCode = EXIT.EXECUTION;
}

function parseKeyValueList(list, flagName, expected) {
  const out = {};
  for (const kv of list || []) {
    const idx = kv.indexOf("=");
    if (idx <= 0) throw errors.invalidArgument("invalid --" + flagName + ' "' + kv + '"', "Expected " + expected);
    out[kv.slice(0, idx)] = kv.slice(idx + 1);
  }
  return out;
}

function stripGlobalFlags(argv) {
  let configPath;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-c") {
      configPath = argv[++i];
      if (configPath === undefined) throw errors.usage("--config requires a path");
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
function serversHelpSection(cfg) {
  const entries = Object.entries(cfg.servers);
  if (entries.length === 0) {
    return [
      "",
      "No servers configured yet:",
      "  agentcli server add <name> -- <command...> [args...]   # stdio server",
      "  agentcli server add <name> --url <http-url>            # Streamable HTTP server",
      "",
    ].join("\n");
  }
  const lines = entries.map(([name, spec]) => {
    const detail = spec.type === "http" ? spec.url : [spec.command, ...(spec.args || [])].join(" ");
    return "  " + name.padEnd(16) + (spec.type === "http" ? "http - " : "stdio - ") + detail;
  });
  return [
    "",
    "Configured servers (agentcli <server> <tool> ...):",
    ...lines,
    "  agentcli <server> --help    List a server's tools",
    "",
  ].join("\n");
}

function buildBuiltins(cfg) {
  const program = new Command();
  program
    .name("agentcli")
    .version(version)
    .description("AgentCLI -- call MCP servers from the command line.")
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  program.addHelpText("after", serversHelpSection(cfg));

  const server = program.command("server").description("Manage configured MCP servers.");
  server.addHelpText(
    "after",
    "\nConfigured servers: " + (Object.keys(cfg.servers).join(", ") || "none") + "\n  agentcli server list    Details as JSON\n"
  );

  server
    .command("add <name>")
    .description("Register a server: stdio via `-- <command...>`, or Streamable HTTP via --url.")
    .option("--url <url>", "Streamable HTTP endpoint of the MCP server")
    .option("--header <name:value...>", "HTTP header sent on every request (repeatable)")
    .option("--env <key=value...>", "Extra env vars for a stdio server (repeatable)")
    .argument("[cmd...]", "stdio server command and args (after --)")
    .action(async (name, cmd, opts) => {
      const current = loadConfig();
      if (opts.url) {
        if (cmd && cmd.length) throw errors.usage("--url and a command are mutually exclusive");
        addServer(current, name, { type: "http", url: opts.url, headers: parseKeyValueList(opts.header, "header", '"Name: value"') });
      } else {
        if (!cmd || cmd.length === 0) {
          throw errors.usage(
            "a stdio server needs a command",
            "agentcli server add <name> -- <command...> [args...]   |   agentcli server add <name> --url <http-url>"
          );
        }
        const [command, ...args] = cmd;
        addServer(current, name, { type: "stdio", command, args, env: parseKeyValueList(opts.env, "env", "KEY=value") });
      }
      printJson({ ok: true, server: name, config: process.env.AGENTCLI_CONFIG });
    });

  server
    .command("list")
    .description("List configured servers.")
    .option("-o, --output <fmt>", "json | text (default: json)")
    .action((opts) => {
      const current = loadConfig();
      const rows = Object.entries(current.servers).map(([name, spec]) => ({
        name,
        type: spec.type,
        ...(spec.type === "http" ? { url: spec.url } : { command: [spec.command, ...(spec.args || [])].join(" ") }),
      }));
      if (opts.output === "text") {
        for (const r of rows) console.log(r.name.padEnd(16) + r.type.padEnd(8) + (r.command || r.url || ""));
        return;
      }
      printJson({ ok: true, data: rows });
    });

  server
    .command("remove <name>")
    .description("Remove a configured server.")
    .action((name) => {
      removeServer(loadConfig(), name);
      printJson({ ok: true, removed: name });
    });

  server
    .command("tools <name>")
    .description("List the tools a server exposes.")
    .option("--refresh", "Bypass the tools cache")
    .option("-o, --output <fmt>", "json | text (default: json)")
    .action(async (name, opts) => {
      const { tools } = await listTools(loadConfig(), name, { refresh: !!opts.refresh });
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
    .action((opts, cmd) => cmd.help());

  daemon
    .command("start")
    .description("Start the daemon in the background (persists after this command exits).")
    .option("-f, --foreground", "Run in the foreground (logs to console; Ctrl-C stops it)")
    .action(async (opts) => {
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

export async function run(argv) {
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
      const hints = [];
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