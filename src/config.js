// Config (~/.agentcli/config.json) + tools-list cache, overridable via AGENTCLI_CONFIG.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { errors } from "./errors.js";

export const RESERVED_NAMES = new Set(["server", "call", "help", "version", "config", "doctor", "completion", "daemon"]);

export function configPath() {
  return process.env.AGENTCLI_CONFIG || path.join(os.homedir(), ".agentcli", "config.json");
}

export function cacheDir() {
  return process.env.AGENTCLI_CACHE_DIR || path.join(path.dirname(configPath()), "cache");
}

export function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return { version: 1, servers: {} };
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw errors.usage("config file is not valid JSON: " + p, "Fix or remove the file: " + e.message);
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw errors.usage("config file must contain a JSON object: " + p);
  }
  cfg.version = 1;
  cfg.servers ||= {};
  return cfg;
}

export function saveConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

export function validateServerName(name) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw errors.invalidArgument('invalid server name "' + name + '"', "Must start with a letter; only [a-zA-Z0-9_-] allowed");
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw errors.invalidArgument('"' + name + '" is a reserved built-in name', "Pick another name for the server");
  }
}

export function addServer(cfg, name, spec) {
  validateServerName(name);
  if (cfg.servers[name]) {
    throw errors.invalidArgument('server "' + name + '" already exists', "Remove it first: agentcli server remove " + name);
  }
  cfg.servers[name] = spec;
  saveConfig(cfg);
}

export function removeServer(cfg, name) {
  if (!cfg.servers[name]) {
    throw errors.notFound('server "' + name + '" is not configured', "List configured servers: agentcli server list");
  }
  delete cfg.servers[name];
  saveConfig(cfg);
}

// --- tools-list cache ---

function cacheFile(server) {
  return path.join(cacheDir(), server + ".tools.json");
}

export function readToolsCache(server, ttlMs) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cacheFile(server), "utf8"));
  } catch {
    return null;
  }
  if (!raw || !Array.isArray(raw.tools) || typeof raw.fetchedAt !== "number") return null;
  return { tools: raw.tools, fresh: Date.now() - raw.fetchedAt < ttlMs };
}

export function writeToolsCache(server, tools) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(cacheFile(server), JSON.stringify({ fetchedAt: Date.now(), tools }, null, 2));
}