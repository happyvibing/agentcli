// End-to-end tests: spawn bin/agentcli.js against a real MCP stdio fixture server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentcli-test-"));
  configFile = path.join(tmp, "config.json");
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("server add (stdio) writes config", () => {
  const r = cli(["server", "add", "demo", "--", process.execPath, FIXTURE]);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(cfg.servers.demo.type, "stdio");
  assert.equal(cfg.servers.demo.command, process.execPath);
});

test("server list shows the server (json default)", () => {
  const r = cli(["server", "list"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.data[0].name, "demo");
  assert.match(out.data[0].command, /echo-server\.mjs$/);
});

test("server tools lists tools (json default)", () => {
  const r = cli(["server", "tools", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  const names = JSON.parse(r.stdout).data.map((t) => t.name).sort();
  assert.deepEqual(names, ["complex", "double", "echo", "fail", "slow"]);
});

test("tool call with flags", () => {
  const r = cli(["demo", "echo", "--message", "hi", "--times", "2"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.data, "hi hi");
  assert.equal(out.server, "demo");
  assert.equal(out.tool, "echo");
});

test("tool call with --flag=value and boolean flag", () => {
  const r = cli(["demo", "echo", "--message=hey", "--upper"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).data, "HEY");
});

test("invalid integer value -> exit 2 INVALID_ARGUMENT", () => {
  const r = cli(["demo", "echo", "--message", "x", "--times", "bad"]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, "INVALID_ARGUMENT");
});

test("unknown flag -> exit 2 with hint listing flags", () => {
  const r = cli(["demo", "echo", "--nope", "1"]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, "INVALID_ARGUMENT");
  assert.match(err.error.hint, /--message/);
});

test("positional argument -> exit 2", () => {
  const r = cli(["demo", "echo", "positional"]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, "INVALID_ARGUMENT");
});

test("enum rejects invalid choice -> exit 2 with allowed values", () => {
  const r = cli(["demo", "echo", "--message", "hi", "--mode", "loud"]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, "INVALID_ARGUMENT");
  assert.match(err.error.hint, /Allowed values: plain, shout/);
});

test("enum accepts a valid choice", () => {
  const r = cli(["demo", "echo", "--message", "hi", "--mode", "shout"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).data, "HI!!!");
});

test("unknown tool -> exit 12 NOT_FOUND", () => {
  const r = cli(["demo", "nope"]);
  assert.equal(r.status, 12);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, "NOT_FOUND");
  assert.match(err.error.hint, /agentcli demo --help/);
});

test("unknown server -> exit 12 NOT_FOUND", () => {
  const r = cli(["ghost", "whatever"]);
  assert.equal(r.status, 12);
  assert.equal(JSON.parse(r.stderr).error.code, "NOT_FOUND");
});

test("typo in server name suggests the closest configured server", () => {
  const r = cli(["demoa", "whatever"]);
  assert.equal(r.status, 12);
  const err = JSON.parse(r.stderr);
  assert.match(err.error.hint, /Did you mean: demo/);
});

test("top-level --help lists configured servers; empty config shows onboarding", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Configured servers/);
  assert.match(r.stdout, /demo/);

  const emptyConfig = path.join(tmp, "empty.json");
  const empty = cli(["--help"], { AGENTCLI_CONFIG: emptyConfig });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No servers configured yet/);
  assert.match(empty.stdout, /server add/);
});

test("server -h lists configured servers", () => {
  const r = cli(["server", "-h"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Configured servers: demo/);
});

test("object parameter cannot be a flag; --input works and flags merge", () => {
  const bad = cli(["demo", "complex", "--spec", "x"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--input/);

  const ok = cli(["demo", "complex", "--input", '{"spec":{"a":1}}']);
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual(out.data, { received: { a: 1 } });
});

test("array-of-primitives via repeated flag, merged over --input", () => {
  const r = cli(["demo", "complex", "--input", '{"spec":{}}', "--tags", "a", "--tags", "b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).data.receivedTags, ["a", "b"]);
});

test("--input from file", () => {
  const file = path.join(tmp, "input.json");
  fs.writeFileSync(file, JSON.stringify({ spec: { via: "file" } }));
  const r = cli(["demo", "complex", "--input", "@" + file]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).data.received, { via: "file" });
});

test("tool error -> exit 1 EXECUTION_ERROR", () => {
  const r = cli(["demo", "fail"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, "EXECUTION_ERROR");
  assert.match(err.error.message, /boom/);
});

test("--output text prints raw content", () => {
  const r = cli(["demo", "echo", "--message", "plain", "--output", "text"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "plain");
});

test("--schema prints the raw input schema", () => {
  const r = cli(["demo", "echo", "--schema"]);
  assert.equal(r.status, 0, r.stderr);
  const schema = JSON.parse(r.stdout);
  assert.equal(schema.properties.message.type, "string");
});

test("--help renders generated usage (tool and server level)", () => {
  const tool = cli(["demo", "echo", "--help"]);
  assert.equal(tool.status, 0, tool.stderr);
  assert.match(tool.stdout, /Required:/);
  assert.match(tool.stdout, /--message <string>/);
  assert.match(tool.stdout, /default: 1/);

  const srv = cli(["demo", "--help"]);
  assert.equal(srv.status, 0, srv.stderr);
  assert.match(srv.stdout, /echo/);
  assert.match(srv.stdout, /complex/);
});

test("timeout -> exit 13 TIMEOUT", () => {
  const r = cli(["demo", "slow", "--ms", "5000"], { AGENTCLI_TIMEOUT_MS: "400" });
  assert.equal(r.status, 13, r.stderr);
  assert.equal(JSON.parse(r.stderr).error.code, "TIMEOUT");
});

test("tools cache file is written and reused", () => {
  const cache = path.join(tmp, "cache", "demo.tools.json");
  assert.ok(fs.existsSync(cache));
  const c = JSON.parse(fs.readFileSync(cache, "utf8"));
  assert.ok(Array.isArray(c.tools) && c.tools.length === 5);
});

test("reserved names are rejected", () => {
  const r = cli(["server", "add", "server", "--", process.execPath, FIXTURE]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reserved/);
});

test("duplicate server is rejected", () => {
  const r = cli(["server", "add", "demo", "--", process.execPath, FIXTURE]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already exists/);
});

test("double-encoded text content is unwrapped into data (json mode)", () => {
  const r = cli(["demo", "double", "--n", "7"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.data, [{ id: 7 }, { id: 8 }]);
});

test("double-encoded text content pretty-prints in --output text (jq-ready)", () => {
  const r = cli(["demo", "double", "--n", "7", "--output", "text"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{ id: 7 }, { id: 8 }]);
  assert.match(r.stdout, /\n\s+"id"/);
});

test("prose text passes through raw in --output text", () => {
  const r = cli(["demo", "echo", "--message", "hi", "--output", "text"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "hi");
});
test("server remove", () => {
  const r = cli(["server", "remove", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.ok(!cfg.servers.demo);
});