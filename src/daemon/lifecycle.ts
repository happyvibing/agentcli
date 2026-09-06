// Daemon lifecycle from the CLI side: start (detached child), stop, status.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errors } from "../errors.js";
import { DaemonUnavailable } from "../client.js";
import { socketPath, pidPath, logPath, ensureDaemonDir } from "./paths.js";
import { runDaemon } from "./server.js";
import { daemonRequest } from "../client.js";
import type { DaemonStatusData } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function requireUnix(): void {
  if (process.platform === "win32") {
    throw errors.invalidArgument("daemon mode requires unix sockets and is not supported on Windows yet", "calls still work without the daemon (direct mode)");
  }
}

async function isAlive(): Promise<boolean> {
  try {
    const r = (await daemonRequest("ping", {}, { timeoutMs: 1500 })) as { pong?: boolean };
    return !!(r && r.pong);
  } catch {
    return false;
  }
}

interface StartResult {
  ok: boolean;
  alreadyRunning?: boolean;
  started?: boolean;
  stopped?: boolean;
  running?: boolean;
  data?: DaemonStatusData | null;
}

// `agentcli daemon start --foreground` runs it inside this process (debugging);
// default spawns a detached child that survives the CLI process.
export async function startDaemon({ foreground = false }: { foreground?: boolean } = {}): Promise<StartResult> {
  requireUnix();
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

export async function stopDaemon(): Promise<{ ok: boolean; stopped: boolean; running?: boolean; pid?: number }> {
  requireUnix();
  try {
    const status = (await daemonRequest("status", {}, { timeoutMs: 3000 })) as DaemonStatusData | null;
    await daemonRequest("shutdown", {}, { timeoutMs: 5000 });
    // give the daemon a beat to unlink the socket
    for (let i = 0; i < 20; i++) {
      if (!(await isAlive())) break;
      await sleep(100);
    }
    return { ok: true, stopped: true, pid: status ? status.pid : undefined };
  } catch (e) {
    if (e instanceof DaemonUnavailable || (e as { unavailable?: boolean })?.unavailable) return { ok: true, stopped: false, running: false };
    throw e;
  }
}

async function statusPayload(): Promise<{ running: boolean; data: DaemonStatusData | null }> {
  try {
    const data = (await daemonRequest("status", {}, { timeoutMs: 3000 })) as DaemonStatusData;
    return { running: true, data };
  } catch (e) {
    if (e instanceof DaemonUnavailable || (e as { unavailable?: boolean })?.unavailable) return { running: false, data: null };
    throw e;
  }
}

export async function daemonStatus(): Promise<{ ok: boolean; running: boolean; data: DaemonStatusData | null }> {
  const payload = await statusPayload();
  return { ok: true, ...payload };
}

export async function readDaemonPid(): Promise<number | null> {
  try {
    return Number(fs.readFileSync(pidPath(), "utf8").trim());
  } catch {
    return null;
  }
}
