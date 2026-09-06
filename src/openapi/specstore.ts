// Spec snapshots: every registered OpenAPI server gets a local copy under
// <configDir>/specs/<name>.json at add time — offline-friendly and immune to
// upstream spec churn. --refresh re-pulls from the recorded origin.
import fs from "node:fs";
import path from "node:path";
import { configPath } from "../config.js";
import { errors } from "../errors.js";

const FETCH_TIMEOUT_MS = 30000;

export function specsDir(): string {
  return process.env.AGENTCLI_SPECS_DIR || path.join(path.dirname(configPath()), "specs");
}

export function snapshotPath(name: string): string {
  return path.join(specsDir(), name + ".json");
}

function looksLikeYaml(text: string): boolean {
  return /^\s*(openapi|swagger)\s*:\s*["']?3/.test(text);
}

// Parse + validate a raw spec document (OpenAPI 3.x JSON only).
export function parseSpecJson(raw: string, source: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    const err = e as Error;
    if (looksLikeYaml(raw)) {
      throw errors.invalidArgument("spec at " + source + " looks like YAML — only JSON is supported", "Convert it: redocly bundle spec.yaml --output spec.json, then re-add");
    }
    throw errors.invalidArgument("spec at " + source + " is not valid JSON", err.message);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw errors.invalidArgument("spec at " + source + " is not a JSON object");
  }
  return doc as Record<string, unknown>;
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

async function fetchOrigin(origin: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  let res: Response;
  try {
    res = await fetch(origin, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") throw errors.timeout("fetching spec timed out: " + origin);
    throw errors.connect("cannot fetch spec from " + origin + ": " + err.message);
  }
  if (!res.ok) {
    throw errors.connect("cannot fetch spec from " + origin + ": HTTP " + res.status);
  }
  return res.text();
}

// Snapshot from a URL or local file path. Validates JSON + 3.x shape.
export async function snapshotSpec(name: string, origin: string, timeoutMs?: number): Promise<Record<string, unknown>> {
  let raw: string;
  if (isHttpUrl(origin)) {
    raw = await fetchOrigin(origin, timeoutMs);
  } else {
    try {
      raw = fs.readFileSync(origin, "utf8");
    } catch {
      throw errors.invalidArgument("cannot read spec file: " + origin, "Check the path (or use an http(s) URL)");
    }
  }
  const doc = parseSpecJson(raw, origin);
  // fail fast on version problems (compileSpec re-checks, this covers add time)
  if (typeof doc.swagger === "string") {
    throw errors.invalidArgument("spec is Swagger 2.0, only OpenAPI 3.x is supported", "Upgrade the spec to 3.x (e.g. with swagger2openapi)");
  }
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw errors.invalidArgument('spec has no "openapi: 3.x" version field', "Expected OpenAPI 3.x JSON");
  }
  fs.mkdirSync(specsDir(), { recursive: true });
  const p = snapshotPath(name);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
  return doc;
}

// Load the local snapshot. Corrupt snapshot + URL origin -> auto re-pull.
export async function loadSnapshotDoc(name: string, origin: string): Promise<Record<string, unknown>> {
  const p = snapshotPath(name);
  const read = (): string => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      throw errors.invalidArgument("spec snapshot is missing for server \"" + name + '"', "Re-add the server: agentcli server remove " + name + " && agentcli server add " + name + " --openapi <spec>");
    }
  };
  let raw: string;
  try {
    raw = read();
    return parseSpecJson(raw, p);
  } catch (e) {
    if (!isHttpUrl(origin)) throw e;
    // corrupt/stale snapshot with a URL origin: re-pull once
    await snapshotSpec(name, origin);
    return parseSpecJson(read(), p);
  }
}

// --refresh: re-pull from origin (URL or local file) and re-snapshot.
export async function refreshSnapshot(name: string, origin: string, timeoutMs?: number): Promise<Record<string, unknown>> {
  return snapshotSpec(name, origin, timeoutMs);
}