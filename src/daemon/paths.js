// Daemon file locations — all derived from the config dir so AGENTCLI_CONFIG
// gives full isolation (tests, multiple profiles).
import fs from "node:fs";
import path from "node:path";
import { configPath } from "../config.js";

export function daemonDir() {
  return path.dirname(configPath());
}

export function ensureDaemonDir() {
  const dir = daemonDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function socketPath() {
  return path.join(daemonDir(), "daemon.sock");
}

export function pidPath() {
  return path.join(daemonDir(), "daemon.pid");
}

export function logPath() {
  return path.join(daemonDir(), "daemon.log");
}