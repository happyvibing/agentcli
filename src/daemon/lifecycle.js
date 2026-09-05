// Daemon lifecycle from the CLI side: start (detached child), stop, status.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errors } from "../errors.js";
import { socketPath, pidPath, logPath, ensureDaemonDir } from "./paths.js";
import { runDaemon } from "./server.js";
import { daemonRequest } from "../client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isAlive() {
  try {
    const r = await daemonRequest("ping", {}, { timeoutMs: 1500 });
    return !!(r && r.pong);
  } catch {
    return false;
  }
}

// `agentcli daemon start --foreground` runs it inside this process (debugging);
// default spawns a detached child that survives the CLI process.
export async function startDaemon({ foreground = false } = {}) {
  if (foreground) {
    const r = await runDaemon();
    if (r && r.alreadyRunning) return { ok: true, alreadyRunning: true };
    return { ok: true, stopped: true };
  }
  if (await isAlive()) {
    return { ok: true, alreadyRunning: true, ...(await statusPayload()) };
  }
  ensureDaemonDir();
  if (fs.existsSync(socketPath())) fs.rmSync(socketPath(), { force: true }); // stale
  const logFd = fs.openSync(logPath(), "a");
  const child = spawn(process.execPath, [path.join(__dirname, "child.js")], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
  for (let i = 0; i < 50; i++) {
    if (await isAlive()) return { ok: true, started: true, ...(await statusPayload()) };
    await sleep(100);
  }
  throw errors.connect("daemon did not come up in time", { log: logPath() });
}

export async function stopDaemon() {
  try {
    const status = await daemonRequest("status", {}, { timeoutMs: 3000 });
    await daemonRequest("shutdown", {}, { timeoutMs: 5000 });
    // give the daemon a beat to unlink the socket
    for (let i = 0; i < 20; i++) {
      if (!(await isAlive())) break;
      await sleep(100);
    }
    return { ok: true, stopped: true, pid: status ? status.pid : undefined };
  } catch (e) {
    if (e && e.unavailable) return { ok: true, stopped: false, running: false };
    throw e;
  }
}

async function statusPayload() {
  try {
    const data = await daemonRequest("status", {}, { timeoutMs: 3000 });
    return { running: true, data };
  } catch (e) {
    if (e && e.unavailable) return { running: false, data: null };
    throw e;
  }
}

export async function daemonStatus() {
  const payload = await statusPayload();
  return { ok: true, ...payload };
}

export async function readDaemonPid() {
  try {
    return Number(fs.readFileSync(pidPath(), "utf8").trim());
  } catch {
    return null;
  }
}