// agentcli daemon: holds persistent MCP connections so tool calls skip the
// per-call spawn + handshake. Newline-delimited JSON over a unix socket.
import net from "node:net";
import fs from "node:fs";
import readline from "node:readline";
import { createTransport, mapError, sdk, ttlFromEnv } from "../client.js";
import { loadConfig } from "../config.js";
import { errors, serializeError, AgentCliError } from "../errors.js";
import { socketPath, pidPath, ensureDaemonDir } from "./paths.js";
import type { AgentCliConfig, ServerSpec, ToolDef, DaemonStatusData, DaemonResponse } from "../types.js";
import pkg from "../../package.json" with { type: "json" };

const CLIENT_INFO = { name: "agentcli-daemon", version: pkg.version };
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

function idleMsFromEnv(): number {
  const n = Number(process.env.AGENTCLI_DAEMON_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MS;
}

type McpClient = InstanceType<typeof import("@modelcontextprotocol/sdk/client/index.js").Client>;

class DaemonState {
  clients: Map<string, { client: McpClient; specJson: string }> = new Map();
  tools: Map<string, { tools: ToolDef[]; fetchedAt: number }> = new Map();
  stats = { startedAt: Date.now(), requests: 0, toolCalls: 0 };
  shuttingDown = false;
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  server: net.Server | null = null;
  onStopped: ((value: { alreadyRunning?: boolean; stopped?: boolean; reason?: string }) => void) | null = null;

  freshConfig(): AgentCliConfig {
    return loadConfig();
  }

  armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.stop("idle timeout").catch(() => process.exit(0));
    }, idleMsFromEnv());
    this.idleTimer.unref();
  }

  async getClient(serverName: string, spec: ServerSpec): Promise<McpClient> {
    const specJson = JSON.stringify(spec);
    const existing = this.clients.get(serverName);
    if (existing) {
      if (existing.specJson === specJson) return existing.client;
      // Spec changed on disk since connect: drop and recreate.
      this.clients.delete(serverName);
      try {
        await existing.client.close();
      } catch {
        // ignore
      }
    }
    let transport: unknown;
    let Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
    let client: McpClient;
    try {
      transport = await createTransport(spec);
      ({ Client } = await sdk());
      client = new Client(CLIENT_INFO);
      await client.connect(transport as Parameters<typeof client.connect>[0]);
    } catch (e) {
      throw mapError(e, serverName);
    }
    this.clients.set(serverName, { client, specJson });
    return client;
  }

  async listTools({ server, refresh }: { server: string; refresh?: boolean }): Promise<{ tools: ToolDef[]; cached: boolean }> {
    const cfg = this.freshConfig();
    const spec = cfg.servers[server];
    if (!spec) {
      throw errors.notFound('server "' + server + '" is not configured', "agentcli server add " + server + " -- <command...>");
    }
    const cached = this.tools.get(server);
    if (!refresh && cached && Date.now() - cached.fetchedAt < ttlFromEnv()) {
      return { tools: cached.tools, cached: true };
    }
    const client = await this.getClient(server, spec);
    let res: { tools?: unknown[] };
    try {
      res = await client.listTools(undefined, { timeout: 30000 });
    } catch (e) {
      throw mapError(e, server);
    }
    const tools = (res.tools as ToolDef[]) || [];
    this.tools.set(server, { tools, fetchedAt: Date.now() });
    return { tools, cached: false };
  }

  async callTool({ server, tool, args, timeoutMs }: { server: string; tool: string; args?: Record<string, unknown>; timeoutMs?: number }): Promise<unknown> {
    const cfg = this.freshConfig();
    const spec = cfg.servers[server];
    if (!spec) {
      throw errors.notFound('server "' + server + '" is not configured', "agentcli server add " + server + " -- <command...>");
    }
    const client = await this.getClient(server, spec);
    this.stats.toolCalls++;
    try {
      return await client.callTool({ name: tool, arguments: args || {} }, undefined, { timeout: timeoutMs ?? 60000 });
    } catch (e) {
      throw mapError(e, server);
    }
  }

  status(): DaemonStatusData {
    return {
      pid: process.pid,
      startedAt: this.stats.startedAt,
      uptimeMs: Date.now() - this.stats.startedAt,
      requests: this.stats.requests,
      toolCalls: this.stats.toolCalls,
      connectedServers: [...this.clients.keys()],
      socket: socketPath(),
    };
  }

  async stop(reason = "shutdown"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const [, entry] of this.clients) {
      try {
        await entry.client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    try {
      fs.rmSync(socketPath(), { force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(pidPath(), { force: true });
    } catch {
      // ignore
    }
    if (this.server) {
      this.server.close(() => process.exit(0));
      // force-exit if close hangs on open sockets
      setTimeout(() => process.exit(0), 1500).unref();
    } else {
      process.exit(0);
    }
  }
}

interface DaemonRequest {
  id: number | null;
  op: string;
  server?: string;
  tool?: string;
  args?: Record<string, unknown>;
  refresh?: boolean;
  timeoutMs?: number;
}

async function handleLine(state: DaemonState, sock: net.Socket, line: string): Promise<void> {
  let req: DaemonRequest;
  try {
    req = JSON.parse(line);
  } catch {
    sock.write(JSON.stringify({ id: null, ok: false, error: serializeError(errors.invalidArgument("invalid daemon request: not JSON")) }) + "\n");
    return;
  }
  const { id, op } = req;
  try {
    state.stats.requests++;
    let result: unknown;
    switch (op) {
      case "ping":
        result = { pong: true, pid: process.pid };
        break;
      case "status":
        result = state.status();
        break;
      case "listTools":
        result = await state.listTools({ server: req.server!, refresh: req.refresh });
        break;
      case "callTool":
        result = await withWatchdog(state.callTool({ server: req.server!, tool: req.tool!, args: req.args, timeoutMs: req.timeoutMs }), (req.timeoutMs ?? 60000) + 10000);
        break;
      case "shutdown":
        sock.write(JSON.stringify({ id, ok: true, result: { stopping: true } }) + "\n");
        await state.stop("requested");
        return;
      default:
        throw errors.invalidArgument('unknown daemon op "' + op + '"');
    }
    sock.write(JSON.stringify({ id, ok: true, result }) + "\n");
  } catch (e) {
    sock.write(JSON.stringify({ id, ok: false, error: serializeError(e) }) + "\n");
  }
  state.armIdleTimer();
}

function withWatchdog<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(errors.timeout("daemon operation timed out")), ms).unref()),
  ]);
}

// Public: boot the daemon in this process. Resolves when the daemon stops.
export async function runDaemon(): Promise<{ alreadyRunning?: boolean; stopped?: boolean; reason?: string }> {
  ensureDaemonDir();

  // Already running? Exit quietly (the CLI layer reports the live daemon).
  if (fs.existsSync(socketPath())) {
    const alive = await pingSocket(600);
    if (alive) return { alreadyRunning: true };
    fs.rmSync(socketPath(), { force: true }); // stale socket from a killed daemon
  }

  const state = new DaemonState();
  const server = net.createServer((sock) => {
    const rl = readline.createInterface({ input: sock });
    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      handleLine(state, sock, line).catch((e: unknown) => {
        // last-resort: never leave a request unanswered
        try {
          sock.write(JSON.stringify({ id: null, ok: false, error: serializeError(e) }) + "\n");
        } catch {
          // socket gone
        }
      });
    });
    sock.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath(), resolve);
  });
  try {
    fs.chmodSync(socketPath(), 0o600); // only the owner may talk to the daemon
  } catch {
    // some filesystems ignore socket chmods; the config dir is user-scoped anyway
  }
  state.server = server;

  fs.writeFileSync(pidPath(), String(process.pid) + "\n");
  process.on("SIGTERM", () => state.stop("SIGTERM"));
  process.on("SIGINT", () => state.stop("SIGINT"));
  state.armIdleTimer();

  return new Promise((resolve) => {
    state.onStopped = resolve;
    const wrapStop = state.stop.bind(state);
    state.stop = async (reason: string) => {
      await wrapStop(reason);
      resolve({ stopped: true, reason });
    };
  });
}

export async function pingSocket(timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = "";
    const sock = net.connect(socketPath());
    const done = (r: boolean) => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(r);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: 0, op: "ping" }) + "\n");
    });
    sock.on("data", (d: Buffer) => {
      buf += d.toString();
      if (!buf.includes("\n")) return;
      clearTimeout(timer);
      try {
        const msg = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as DaemonResponse;
        done(!!(msg && msg.ok && msg.result && (msg.result as { pong?: boolean }).pong));
      } catch {
        done(false);
      }
    });
  });
}
