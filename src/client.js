// MCP client: connect (stdio | streamable HTTP), listTools (with cache), callTool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readToolsCache, writeToolsCache } from "./config.js";
import { errors } from "./errors.js";

const CLIENT_INFO = { name: "agentcli", version: "0.2.0" };
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

// Only pass a whitelist of env vars to spawned MCP servers (credential isolation:
// whatever else sits in the agent's environment never reaches the server process).
const ENV_WHITELIST = ["PATH", "PATHEXT", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "COMSPEC"];

function buildEnv(specEnv) {
  const base = {};
  for (const k of ENV_WHITELIST) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return { ...base, ...(specEnv || {}) };
}

function parseHeaders(headerList) {
  const headers = {};
  for (const h of headerList || []) {
    const idx = h.indexOf(":");
    if (idx <= 0) throw errors.invalidArgument('invalid header "' + h + '"', 'Expected "Name: value"');
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return headers;
}

function createTransport(spec) {
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
  const transport = createTransport(spec);
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

export async function listTools(cfg, serverName, { refresh = false, ttlMs = ttlFromEnv(), timeoutMs } = {}) {
  const spec = requireServer(cfg, serverName);
  if (!refresh) {
    const cached = readToolsCache(serverName, ttlMs);
    if (cached && cached.fresh) return { tools: cached.tools, cached: true };
  }
  try {
    const tools = await withClient(spec, serverName, async (client) => {
      const res = await client.listTools(undefined, { timeout: timeoutMs });
      return res.tools || [];
    }, timeoutMs);
    writeToolsCache(serverName, tools);
    return { tools, cached: false };
  } catch (e) {
    throw mapError(e, serverName);
  }
}

export async function callTool(cfg, serverName, toolName, args, { timeoutMs } = {}) {
  const spec = requireServer(cfg, serverName);
  try {
    return await withClient(spec, serverName, async (client) => {
      return client.callTool({ name: toolName, arguments: args || {} }, undefined, { timeout: timeoutMs ?? timeoutFromEnv() });
    }, timeoutMs);
  } catch (e) {
    throw mapError(e, serverName);
  }
}