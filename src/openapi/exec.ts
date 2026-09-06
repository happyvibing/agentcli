// OpenAPI executor: compiled operation metadata + CLI args -> HTTP request ->
// neutral ToolResult. HTTP failures throw typed AgentCliErrors (the dispatch
// layer never sees an HTTP status).
import { errors } from "../errors.js";
import { timeoutFromEnv } from "../client.js";
import type { OpenApiOperationMeta, OpenApiServerSpec } from "../types.js";
import type { ToolResult } from "../backend/types.js";
import pkg from "../../package.json" with { type: "json" };

const ENV_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Expand ${VAR} placeholders in configured header values. A referenced env var
// that is unset is a missing credential: AUTH_REQUIRED, never a silent empty header.
function expandEnvValue(value: string, header: string): string {
  return value.replace(ENV_VAR, (m, v: string) => {
    const val = process.env[v];
    if (val === undefined) {
      throw errors.auth('missing env var ' + v + ' for header "' + header + '"');
    }
    return val;
  });
}

function truncate(s: string, max = 2048): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Pull a human-readable message out of an error body if one exists.
function extractErrorMessage(bodyText: string): string | undefined {
  try {
    const v = JSON.parse(bodyText) as { message?: unknown; error?: { message?: unknown } | string };
    if (typeof v.message === "string" && v.message) return v.message;
    if (typeof v.error === "string" && v.error) return v.error;
    if (v.error && typeof v.error === "object" && typeof v.error.message === "string") return v.error.message;
  } catch {
    // not JSON
  }
  return undefined;
}

function mapHttpError(serverName: string, status: number, bodyText: string, retryAfter: string | null): Error {
  const msg = serverName + ": HTTP " + status + (extractErrorMessage(bodyText) ? " — " + extractErrorMessage(bodyText) : "");
  if (status === 401 || status === 403) return errors.auth(msg);
  if (status === 404) return errors.notFound(msg, "Check the path parameters and the API base URL");
  if (status === 429) return errors.execution(msg, { httpStatus: status, retryAfter: retryAfter || undefined });
  return errors.execution(msg, { httpStatus: status, body: truncate(bodyText) });
}

export async function executeOperation(
  serverName: string,
  spec: OpenApiServerSpec,
  meta: OpenApiOperationMeta,
  args: Record<string, unknown>,
  timeoutMs?: number
): Promise<ToolResult> {
  // 1. headers: Accept, header params, config headers (env-expanded), UA
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "agentcli/" + pkg.version };
  for (const [flag, orig] of Object.entries(meta.headerParams)) {
    if (args[flag] !== undefined) headers[orig] = String(args[flag]);
  }
  for (const [k, v] of Object.entries(spec.headers || {})) {
    headers[k] = expandEnvValue(String(v), k);
  }

  // 2. path + query
  let path = meta.path;
  for (const [flag, orig] of Object.entries(meta.pathParams)) {
    const v = args[flag];
    if (v === undefined) throw errors.invalidArgument("missing path parameter --" + flag);
    path = path.split("{" + orig + "}").join(encodeURIComponent(String(v)));
  }
  const query = new URLSearchParams();
  for (const [flag, orig] of Object.entries(meta.queryParams)) {
    const v = args[flag];
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) query.append(orig, String(item));
    else query.append(orig, String(v));
  }
  const urlStr = meta.baseUrl + path + (query.size ? "?" + query.toString() : "");

  // 3. body
  let body: string | undefined;
  if (meta.rawBody && args[meta.rawBody] !== undefined) {
    body = JSON.stringify(args[meta.rawBody]);
  } else if (Object.keys(meta.bodyProps).length) {
    const bodyObj: Record<string, unknown> = {};
    for (const [flag, orig] of Object.entries(meta.bodyProps)) {
      if (args[flag] !== undefined) bodyObj[orig] = args[flag];
    }
    if (Object.keys(bodyObj).length) body = JSON.stringify(bodyObj);
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";

  // 4. fetch
  let res: Response;
  try {
    res = await fetch(urlStr, {
      method: meta.method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs ?? timeoutFromEnv()),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") throw errors.timeout(serverName + ": request timed out");
    throw errors.connect(serverName + ": " + (err.message || String(e)));
  }

  // 5. HTTP status -> typed errors
  const text = await res.text();
  if (res.status >= 400) {
    throw mapHttpError(serverName, res.status, text, res.headers.get("retry-after"));
  }

  // 6. neutral ToolResult
  let data: unknown = null;
  if (text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      data = text; // non-JSON body: keep raw (json envelope carries it as a string)
    }
  }
  return { data, text: text === "" ? undefined : text };
}