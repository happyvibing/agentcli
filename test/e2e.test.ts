// End-to-end tests: spawn bin/agentcli.js against a real MCP stdio fixture server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const BIN = path.join(ROOT, "bin", "agentcli.js");
const FIXTURE = path.join(ROOT, "dist", "fixtures", "echo-server.js");

let tmp: string;
let configFile: string;

function cli(args: string[], env: Record<string, string> = {}) {
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
  const out = JSON.parse(r.stdout as string);
  assert.equal(out.data[0].name, "demo");
  assert.match(out.data[0].command, /echo-server\.js$/);
});

test("server tools lists tools (json default)", () => {
  const r = cli(["server", "tools", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  const names = JSON.parse(r.stdout as string).data.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, ["complex", "double", "echo", "fail", "slow"]);
});

test("tool call with flags", () => {
  const r = cli(["demo", "echo", "--message", "hi", "--times", "2"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout as string);
  assert.equal(out.ok, true);
  assert.equal(out.data, "hi hi");
  assert.equal(out.server, "demo");
  assert.equal(out.tool, "echo");
});

test("tool call with --flag=value and boolean flag", () => {
  const r = cli(["demo", "echo", "--message=hey", "--upper"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout as string).data, "HEY");
});

test("invalid integer value -> exits 1 INVALID_ARGUMENT", () => {
  const r = cli(["demo", "echo", "--message", "x", "--times", "bad"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.equal(err.error.code, "INVALID_ARGUMENT");
});

test("unknown flag -> exits 1 with hint listing flags", () => {
  const r = cli(["demo", "echo", "--nope", "1"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.equal(err.error.code, "INVALID_ARGUMENT");
  assert.match(err.error.hint, /--message/);
});

test("positional argument -> exits 1", () => {
  const r = cli(["demo", "echo", "positional"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr as string).error.code, "INVALID_ARGUMENT");
});

test("enum rejects invalid choice -> exits 1 with allowed values", () => {
  const r = cli(["demo", "echo", "--message", "hi", "--mode", "loud"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.equal(err.error.code, "INVALID_ARGUMENT");
  assert.match(err.error.hint, /Allowed values: plain, shout/);
});

test("enum accepts a valid choice", () => {
  const r = cli(["demo", "echo", "--message", "hi", "--mode", "shout"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout as string).data, "HI!!!");
});

test("missing required flag -> exits 1 before hitting the server", () => {
  const r = cli(["demo", "echo"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.equal(err.error.code, "INVALID_ARGUMENT");
  assert.match(err.error.message, /missing required parameter: message/);
  assert.match(err.error.hint, /--message/);
});

test("required complex param satisfied via --input is accepted", () => {
  const r = cli(["demo", "complex", "--input", "{\"spec\":{\"a\":1}}"]);
  assert.equal(r.status, 0, r.stderr);
  const r2 = cli(["demo", "complex"]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr as string, /spec \(via --input\)/);
});

test("unknown tool -> exits 1 NOT_FOUND", () => {
  const r = cli(["demo", "nope"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.equal(err.error.code, "NOT_FOUND");
  assert.match(err.error.hint, /agentcli demo --help/);
});

test("unknown server -> exits 1 NOT_FOUND", () => {
  const r = cli(["ghost", "whatever"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr as string).error.code, "NOT_FOUND");
});

test("typo in server name suggests the closest configured server", () => {
  const r = cli(["demoa", "whatever"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.match(err.error.hint, /Did you mean: demo/);
});

test("top-level --help lists configured servers; empty config shows onboarding", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout as string, /Configured servers/);
  assert.match(r.stdout as string, /demo/);

  const emptyConfig = path.join(tmp, "empty.json");
  const empty = cli(["--help"], { AGENTCLI_CONFIG: emptyConfig });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout as string, /No servers configured yet/);
  assert.match(empty.stdout as string, /server add/);
});

test("server -h lists configured servers", () => {
  const r = cli(["server", "-h"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout as string, /Configured servers: demo/);
});

test("object parameter cannot be a flag; --input works and flags merge", () => {
  const bad = cli(["demo", "complex", "--spec", "x"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr as string, /--input/);

  const ok = cli(["demo", "complex", "--input", '{"spec":{"a":1}}']);
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout as string);
  assert.deepEqual(out.data, { received: { a: 1 } });
});

test("array-of-primitives via repeated flag, merged over --input", () => {
  const r = cli(["demo", "complex", "--input", '{"spec":{}}', "--tags", "a", "--tags", "b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout as string).data.receivedTags, ["a", "b"]);
});

test("--input from file", () => {
  const file = path.join(tmp, "input.json");
  fs.writeFileSync(file, JSON.stringify({ spec: { via: "file" } }));
  const r = cli(["demo", "complex", "--input", "@" + file]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout as string).data.received, { via: "file" });
});

test("tool error -> exit 1 EXECUTION_ERROR", () => {
  const r = cli(["demo", "fail"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.equal(err.error.code, "EXECUTION_ERROR");
  assert.match(err.error.message, /boom/);
});

test("--output text prints raw content", () => {
  const r = cli(["demo", "echo", "--message", "plain", "--output", "text"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout as string).trim(), "plain");
});

test("--schema prints the raw input schema", () => {
  const r = cli(["demo", "echo", "--schema"]);
  assert.equal(r.status, 0, r.stderr);
  const schema = JSON.parse(r.stdout as string);
  assert.equal(schema.properties.message.type, "string");
});

test("--help renders generated usage (tool and server level)", () => {
  const tool = cli(["demo", "echo", "--help"]);
  assert.equal(tool.status, 0, tool.stderr);
  assert.match(tool.stdout as string, /Required:/);
  assert.match(tool.stdout as string, /--message <string>/);
  assert.match(tool.stdout as string, /default: 1/);

  const srv = cli(["demo", "--help"]);
  assert.equal(srv.status, 0, srv.stderr);
  assert.match(srv.stdout as string, /echo/);
  assert.match(srv.stdout as string, /complex/);
});

test("timeout -> exits 1 TIMEOUT", () => {
  const r = cli(["demo", "slow", "--ms", "5000"], { AGENTCLI_TIMEOUT_MS: "400" });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stderr as string).error.code, "TIMEOUT");
});

test("tools cache file is written and reused", () => {
  const cache = path.join(tmp, "cache", "demo.tools.json");
  assert.ok(fs.existsSync(cache));
  const c = JSON.parse(fs.readFileSync(cache, "utf8"));
  assert.ok(Array.isArray(c.tools) && c.tools.length === 5);
});

test("reserved names are rejected", () => {
  const r = cli(["server", "add", "server", "--", process.execPath, FIXTURE]);
  assert.equal(r.status, 1);
  assert.match(r.stderr as string, /reserved/);
});

test("duplicate server is rejected", () => {
  const r = cli(["server", "add", "demo", "--", process.execPath, FIXTURE]);
  assert.equal(r.status, 1);
  assert.match(r.stderr as string, /already exists/);
});

test("double-encoded text content is unwrapped into data (json mode)", () => {
  const r = cli(["demo", "double", "--n", "7"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout as string);
  assert.deepEqual(out.data, [{ id: 7 }, { id: 8 }]);
});

test("double-encoded text content pretty-prints in --output text (jq-ready)", () => {
  const r = cli(["demo", "double", "--n", "7", "--output", "text"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout as string), [{ id: 7 }, { id: 8 }]);
  assert.match(r.stdout as string, /\n\s+"id"/);
});

test("prose text passes through raw in --output text", () => {
  const r = cli(["demo", "echo", "--message", "hi", "--output", "text"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout as string).trim(), "hi");
});
test("server remove", () => {
  const r = cli(["server", "remove", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.ok(!cfg.servers.demo);
});
