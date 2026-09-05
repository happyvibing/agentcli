// Daemon mode: persistent MCP connections + transparent routing + fallback.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "agentcli.js");
const FIXTURE = path.join(ROOT, "fixtures", "echo-server.mjs");

let tmp;
let configFile;

function cli(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AGENTCLI_CONFIG: configFile, ...env },
  });
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentcli-daemon-"));
  configFile = path.join(tmp, "config.json");
  const r = cli(["server", "add", "demo", "--", process.execPath, FIXTURE]);
  assert.equal(r.status, 0, r.stderr);
});

after(() => {
  cli(["daemon", "stop"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("daemon status before start: running=false, exit 0", () => {
  const r = cli(["daemon", "status"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.running, false);
});

test("daemon start returns a live status", () => {
  const r = cli(["daemon", "start"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.running, true);
  assert.ok(Number.isInteger(out.data.pid));
});

test("daemon start is idempotent", () => {
  const r = cli(["daemon", "start"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).alreadyRunning, true);
});

test("tool calls route through the daemon", () => {
  const r = cli(["demo", "echo", "--message", "hi"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.data, "hi");
  assert.equal(out.meta.via, "daemon");
});

test("server tools lists via daemon", () => {
  const r = cli(["server", "tools", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.data.length === 4);
});

test("tool errors keep their exit codes through the daemon", () => {
  const r = cli(["demo", "fail"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error.code, "EXECUTION_ERROR");

  const nf = cli(["demo", "nope"]);
  assert.equal(nf.status, 12);
  assert.equal(JSON.parse(nf.stderr).error.code, "NOT_FOUND");
});

test("--no-daemon flag forces the direct path", () => {
  const r = cli(["demo", "echo", "--message", "x", "--no-daemon"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).meta.via, "direct");
});

test("AGENTCLI_NO_DAEMON env forces the direct path", () => {
  const r = cli(["demo", "echo", "--message", "x"], { AGENTCLI_NO_DAEMON: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).meta.via, "direct");
});

test("daemon status shows the connected server", () => {
  const r = cli(["daemon", "status"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.running, true);
  assert.ok(out.data.connectedServers.includes("demo"));
});

test("after daemon stop, calls transparently fall back to direct", () => {
  const stopped = cli(["daemon", "stop"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);

  const status = cli(["daemon", "status"]);
  assert.equal(JSON.parse(status.stdout).running, false);

  const r = cli(["demo", "echo", "--message", "after-stop"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.data, "after-stop");
  assert.equal(out.meta.via, "direct");
});

test("daemon restarts cleanly", async () => {
  const started = cli(["daemon", "start"]);
  assert.equal(started.status, 0, started.stderr);
  const r = cli(["demo", "echo", "--message", "restarted"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).meta.via, "daemon");
  const stopped = cli(["daemon", "stop"]);
  assert.equal(stopped.status, 0, stopped.stderr);
});