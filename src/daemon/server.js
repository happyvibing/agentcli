// agentcli daemon: holds persistent MCP connections so tool calls skip the
// per-call spawn + handshake. Newline-delimited JSON over a unix socket.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createTransport, sdk, ttlFromEnv } from "../client.js";
import { loadConfig } from "../config.js";
import { errors, serializeError } from "../errors.js";
import { socketPath, pidPath, logPath, ensureDaemonDir } from "./paths.js";

const CLIENT_INFO = { name: "agentcli-daemon", version: "0.3.0" };
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

function idleMsFromEnv() {
  const n = Number(process.env.AGENTCLI_DAEMON_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MS;
}

class DaemonState {
  constructor() {
    // Persistent MCP clients keyed by server name.
    this.clients = new Map(); // name -> {client, specJson}
    // In-memory tools cache (direct mode keeps its own on-disk cache).
    this.tools = new Map(); // name -> {tools, fetchedAt}
    this.stats = { startedAt: Date.now(), requests: 0, toolCalls: 0 };
    this.shuttingDown = false;
    this.idleTimer = null;
  }

  freshConfig() {
    return loadConfig();
  }

  armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.stop("idle timeout").catch(() => process.exit(0));
    }, idleMsFromEnv());
    this.idleTimer.unref();
  }

  async getClient(serverName, spec) {
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
    const transport = await createTransport(spec);
    const { Client } = await sdk();
    const client = new Client(CLIENT_INFO);
    await client.connect(transport);
    this.clients.set(serverName, { client, specJson });
    return client;
  }

  async listTools({ server, refresh }) {
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
    const res = await client.listTools(undefined, { timeout: 30000 });
    const tools = res.tools || [];
    this.tools.set(server, { tools, fetchedAt: Date.now() });
    return { tools, cached: false };
  }

  async callTool({ server, tool, args, timeoutMs }) {
    const cfg = this.freshConfig();
    const spec = cfg.servers[server];
    if (!spec) {
      throw errors.notFound('server "' + server + '" is not configured', "agentcli server add " + server + " -- <command...>");
    }
    const client = await this.getClient(server, spec);
    this.stats.toolCalls++;
    return client.callTool({ name: tool, arguments: args || {} }, undefined, { timeout: timeoutMs ?? 60000 });
  }

  status() {
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

  async stop(reason = "shutdown") {
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

async function handleLine(state, sock, line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    sock.write(JSON.stringify({ id: null, ok: false, error: serializeError(errors.usage("invalid daemon request: not JSON")) }) + "\n");
    return;
  }
  const { id, op } = req;
  try {
    state.stats.requests++;
    let result;
    switch (op) {
      case "ping":
        result = { pong: true, pid: process.pid };
        break;
      case "status":
        result = state.status();
        break;
      case "listTools":
        result = await state.listTools(req);
        break;
      case "callTool":
        result = await withWatchdog(state.callTool(req), (req.timeoutMs ?? 60000) + 10000);
        break;
      case "shutdown":
        sock.write(JSON.stringify({ id, ok: true, result: { stopping: true } }) + "\n");
        await state.stop("requested");
        return;
      default:
        throw errors.usage('unknown daemon op "' + op + '"');
    }
    sock.write(JSON.stringify({ id, ok: true, result }) + "\n");
  } catch (e) {
    sock.write(JSON.stringify({ id, ok: false, error: serializeError(e) }) + "\n");
  }
  state.armIdleTimer();
}

function withWatchdog(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(errors.timeout("daemon operation timed out")), ms).unref()),
  ]);
}

// Public: boot the daemon in this process. Resolves when the daemon stops.
export async function runDaemon() {
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
    rl.on("line", (line) => {
      if (!line.trim()) return;
      handleLine(state, sock, line).catch((e) => {
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

  await new Promise((resolve, reject) => {
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
    state.stop = async (reason) => {
      await wrapStop(reason);
      resolve({ stopped: true, reason });
    };
  });
}

export async function pingSocket(timeoutMs = 1000) {
  return new Promise((resolve) => {
    let buf = "";
    const sock = net.connect(socketPath());
    const done = (r) => {
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
    sock.on("data", (d) => {
      buf += d.toString();
      if (!buf.includes("\n")) return;
      clearTimeout(timer);
      try {
        const msg = JSON.parse(buf.slice(0, buf.indexOf("\n")));
        done(!!(msg && msg.ok && msg.result && msg.result.pong));
      } catch {
        done(false);
      }
    });
  });
}