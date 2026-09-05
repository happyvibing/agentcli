// MCP backend: persistent (daemon) or per-call (direct) execution paths.
//
// The MCP SDK is imported lazily (see sdk()); daemon-routed calls never touch
// it, which keeps CLI startup fast for the common agent path.
import net from "node:net";
import { readToolsCache, writeToolsCache } from "./config.js";
import { errors, reviveError } from "./errors.js";
import { socketPath } from "./daemon/paths.js";

const CLIENT_INFO = { name: "agentcli", version: "0.0.1" };
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60 * 1000;

export function ttlFromEnv() {
  const n = Number(process.env.AGENTCLI_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

export function timeoutFromEnv() {
  const n = Number(process.env.AGENTCLI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// --- SDK lazy loading + protocol version compatibility ---
//
// MCP spec latest is 2026-07-28 (modelcontextprotocol.io), but SDK 1.30.0 only
// negotiates up to 2025-11-25 and *rejects* servers answering with a newer
// version. SUPPORTED_PROTOCOL_VERSIONS is the very array instance the SDK
// client checks, so extending it (ESM live binding to a mutable array) makes
// us accept servers speaking the newer spec. Core methods (initialize /
// tools/list / tools/call) are wire-stable across these versions.
// Override with AGENTCLI_PROTOCOL_VERSIONS (comma-separated). Dedup-safe once
// the SDK ships these versions itself.

let sdkPromise = null;

export function sdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }, { SUPPORTED_PROTOCOL_VERSIONS }] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/stdio.js"),
        import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
        import("@modelcontextprotocol/sdk/types.js"),
      ]);
      const extra = (process.env.AGENTCLI_PROTOCOL_VERSIONS ?? "2026-07-28")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const v of extra) {
        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(v)) SUPPORTED_PROTOCOL_VERSIONS.push(v);
      }
      return { Client, StdioClientTransport, StreamableHTTPClientTransport };
    })();
  }
  return sdkPromise;
}

// Only pass a whitelist of env vars to spawned MCP servers (credential isolation:
// whatever else sits in the agent's environment never reaches the server process).
const ENV_WHITELIST = ["PATH", "PATHEXT", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "COMSPEC"];

export function buildEnv(specEnv) {
  const base = {};
  for (const k of ENV_WHITELIST) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return { ...base, ...(specEnv || {}) };
}

// Accepts both config shapes: {Name: value} (stored config) and
// ["Name: value", ...] (raw --header flags).
function parseHeaders(headerList) {
  if (!headerList) return {};
  if (!Array.isArray(headerList)) {
    if (typeof headerList !== "object") {
      throw errors.invalidArgument("invalid headers: expected an object or array of \"Name: value\" strings");
    }
    return { ...headerList };
  }
  const headers = {};
  for (const h of headerList) {
    const idx = h.indexOf(":");
    if (idx <= 0) throw errors.invalidArgument('invalid header "' + h + '"', 'Expected "Name: value"');
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return headers;
}

export async function createTransport(spec) {
  const { StdioClientTransport, StreamableHTTPClientTransport } = await sdk();
  if (spec.type === "http") {
    return new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: parseHeaders(spec.headers) },
    });
  }
  return new StdioClientTransport({
    command: spec.command,
    args: spec.args || [],
    env: buildEnv(spec.env),
    stderr: "pipe",
  });
}

function mapError(e, serverName, stderrTail) {
  const msg = String((e && e.message) || e);
  if (/timed?\s*out/i.test(msg)) return errors.timeout(serverName + ": " + msg);
  const status = e && (e.status ?? e.code);
  if (status === 401 || status === 403) return errors.auth(serverName + ": " + msg);
  const details = stderrTail ? { stderr: stderrTail } : undefined;
  return errors.connect(serverName + ": " + msg, details);
}

async function withClient(spec, serverName, fn, timeoutMs) {
  const { Client } = await sdk();
  const transport = await createTransport(spec);
  const client = new Client(CLIENT_INFO);
  let stderrTail = "";
  if (transport.stderr && typeof transport.stderr.on === "function") {
    transport.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).split("\n").slice(-20).join("\n");
    });
  }
  try {
    try {
      await client.connect(transport);
    } catch (e) {
      throw mapError(e, serverName, stderrTail);
    }
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
  }
}

function requireServer(cfg, serverName) {
  const spec = cfg.servers[serverName];
  if (!spec) {
    throw errors.notFound(
      'server "' + serverName + '" is not configured',
      "Add it: agentcli server add " + serverName + " -- <command...>   (or: agentcli server add " + serverName + ' --url <http-url>)'
    );
  }
  return spec;
}

// --- daemon (persistent connections) ---

export class DaemonUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "DaemonUnavailable";
    this.unavailable = true;
  }
}

export function daemonEnabled(pref = true) {
  if (!pref) return false;
  if (process.env.AGENTCLI_NO_DAEMON) return false;
  return process.platform !== "win32";
}

let daemonSeq = 0;

// One request per connection: simple, robust against daemon restarts.
export async function daemonRequest(op, payload = {}, { timeoutMs = 65000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let connected = false;
    const sock = net.connect(socketPath());
    const timer = setTimeout(() => {
      sock.destroy();
      reject(connected ? errors.timeout("daemon request timed out: " + op) : new DaemonUnavailable("daemon timeout"));
    }, timeoutMs);
    const fail = (e) => {
      clearTimeout(timer);
      reject(connected ? e : new DaemonUnavailable(String((e && e.message) || e)));
    };
    sock.on("error", fail);
    sock.on("connect", () => {
      connected = true;
      sock.write(JSON.stringify({ id: ++daemonSeq, op, ...payload }) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch (e) {
        reject(errors.connect("daemon sent invalid response: " + e.message));
        return;
      }
      if (msg.ok) resolve(msg.result);
      else reject(reviveError(msg.error));
    });
  });
}

// --- public API: listTools / callTool (daemon first, direct fallback) ---
//
// Fallback only happens when the daemon is *unreachable* (not running / stale
// socket / connect timeout). Once a request has reached the daemon, failures
// are surfaced as-is — never retried against a fresh process, or a non-idempotent
// tool could run twice.

export async function listTools(cfg, serverName, { refresh = false, ttlMs = ttlFromEnv(), timeoutMs, daemon = true } = {}) {
  const spec = requireServer(cfg, serverName);
  if (daemonEnabled(daemon)) {
    try {
      const r = await daemonRequest("listTools", { server: serverName, refresh }, { timeoutMs: timeoutMs ?? 30000 });
      return { tools: r.tools || [], cached: !!r.cached, via: "daemon" };
    } catch (e) {
      if (!(e instanceof DaemonUnavailable) && !e.unavailable) throw e;
    }
  }
  if (!refresh) {
    const cached = readToolsCache(serverName, ttlMs);
    if (cached && cached.fresh) return { tools: cached.tools, cached: true, via: "direct" };
  }
  try {
    const tools = await withClient(spec, serverName, async (client) => {
      const res = await client.listTools(undefined, { timeout: timeoutMs });
      return res.tools || [];
    }, timeoutMs);
    writeToolsCache(serverName, tools);
    return { tools, cached: false, via: "direct" };
  } catch (e) {
    throw mapError(e, serverName);
  }
}

export async function callTool(cfg, serverName, toolName, args, { timeoutMs, daemon = true } = {}) {
  const spec = requireServer(cfg, serverName);
  if (daemonEnabled(daemon)) {
    try {
      const result = await daemonRequest("callTool", { server: serverName, tool: toolName, args: args || {}, timeoutMs: timeoutMs ?? timeoutFromEnv() }, { timeoutMs: (timeoutMs ?? timeoutFromEnv()) + 10000 });
      return { result, via: "daemon" };
    } catch (e) {
      if (!(e instanceof DaemonUnavailable) && !e.unavailable) throw e;
    }
  }
  try {
    const result = await withClient(spec, serverName, async (client) => {
      return client.callTool({ name: toolName, arguments: args || {} }, undefined, { timeout: timeoutMs ?? timeoutFromEnv() });
    }, timeoutMs);
    return { result, via: "direct" };
  } catch (e) {
    throw mapError(e, serverName);
  }
}