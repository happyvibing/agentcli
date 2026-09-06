// End-to-end: register an OpenAPI spec, then call operations against a real
// local HTTP server (base-url override). Covers URL building, body flattening,
// auth header injection with ${ENV} expansion, HTTP error mapping, snapshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const BIN = path.join(ROOT, "bin", "agentcli.js");
const FIXTURE_SPEC = path.join(ROOT, "fixtures", "openapi.json");

let tmp: string;
let configFile: string;
let originSpec: string;
let httpServer: http.Server;
let port = 0;

// Requests seen by the test server (for assertions).
let lastRequest: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

// Async spawn: the in-process HTTP test server must keep serving while the
// CLI child runs (spawnSync would block the event loop and deadlock both).
interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, AGENTCLI_CONFIG: configFile, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentcli-openapi-"));
  configFile = path.join(tmp, "config.json");
  // copy the fixture so we can mutate "origin" without touching the repo file
  originSpec = path.join(tmp, "origin-spec.json");
  fs.copyFileSync(FIXTURE_SPEC, originSpec);

  // the CLI child expands ${TEST_TOKEN} from its own environment
  process.env.TEST_TOKEN = "secret-token";

  httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      lastRequest = { method: req.method || "", url: req.url || "", headers: req.headers, body };
      const url = new URL(req.url || "/", "http://x");
      // petId drives the response shape: error mapping without extra routes
      const petId = url.pathname.match(/\/pets\/(\d+)$/)?.[1];
      if (petId === "404") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "pet not found" }));
        return;
      }
      if (petId === "401") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "bad token" }));
        return;
      }
      if (petId === "500") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "kaboom" } }));
        return;
      }
      if (url.pathname === "/v1/pets" && req.method === "POST" && body.includes('"boom"')) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "7" });
        res.end(JSON.stringify({ message: "slow down" }));
        return;
      }
      if (petId === "999") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("<h1>not json</h1>");
        return;
      }
      const query: Record<string, string | string[]> = {};
      for (const k of new Set(url.searchParams.keys())) {
        const all = url.searchParams.getAll(k);
        query[k] = all.length > 1 ? all : all[0];
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, method: req.method, path: url.pathname, query }));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  port = (httpServer.address() as { port: number }).port;

  // register with a header template + base-url override pointing at the test server
  const add = await cli([
    "server", "add", "mini",
    "--openapi", originSpec,
    "--base-url", "http://127.0.0.1:" + port + "/v1",
    "--header", "Authorization: Bearer ${TEST_TOKEN}",
  ], { TEST_TOKEN: "secret-token" });
  assert.equal(add.status, 0, add.stderr);
  const out = JSON.parse(add.stdout);
  assert.equal(out.ok, true);
  assert.equal(typeof out.operations, "number");
  assert.ok(out.operations >= 7);
});

after(() => {
  httpServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("add snapshots the spec and writes the compiled cache", async () => {
  const snapshot = path.join(path.dirname(configFile), "specs", "mini.json");
  assert.ok(fs.existsSync(snapshot), "snapshot must exist next to the config");
  const cache = path.join(path.dirname(configFile), "cache", "mini.tools.json");
  assert.ok(fs.existsSync(cache));
  const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(cfg.servers.mini.type, "openapi");
  assert.equal(cfg.servers.mini.baseUrl, "http://127.0.0.1:" + port + "/v1");
});

test("server -h lists operations grouped by tag", async () => {
  const r = await cli(["mini", "-h"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout as string, /pets:/);
  assert.match(r.stdout as string, /store:/);
  assert.match(r.stdout as string, /getPetById/);
  assert.match(r.stdout as string, /OpenAPI server/);
});

test("GET with path param builds the URL and injects the auth header", async () => {
  const r = await cli(["mini", "getPetById", "--petId", "7"], { TEST_TOKEN: "t123" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout as string);
  assert.equal(out.ok, true);
  assert.equal(out.data.path, "/v1/pets/7");
  assert.equal(out.data.method, "GET");
  assert.equal(out.meta.via, "direct");
  assert.equal(lastRequest.headers.authorization, "Bearer t123");
});

test("query params (incl. arrays via repeated flags) serialize", async () => {
  const r = await cli(["mini", "listPets", "--tags", "a", "--tags", "b", "--limit", "3"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout as string).data.query, { tags: ["a", "b"], limit: "3" });
  assert.match(lastRequest.url, /tags=a&tags=b/);
});

test("flattened body props POST as JSON", async () => {
  const r = await cli(["mini", "addPet", "--name", "rex", "--kind", "dog"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(lastRequest.body), { name: "rex", kind: "dog" });
  assert.match(lastRequest.headers["content-type"] as string, /application\/json/);
});

test("required body prop is enforced client-side", async () => {
  const r = await cli(["mini", "addPet"]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stderr as string).error.message, /missing required parameter: name/);
});

test("header param maps to a request header", async () => {
  const r = await cli(["mini", "getOrder"]);
  assert.equal(r.status, 0, r.stderr);
  const r2 = await cli(["mini", "getOrder", "--X-Request-Id", "abc-1"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(lastRequest.headers["x-request-id"], "abc-1");
});

test("array body passes through via repeated flags", async () => {
  const r = await cli(["mini", "postBatch", "--body", "a", "--body", "b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(lastRequest.body), ["a", "b"]);
});

test("HTTP 404 -> NOT_FOUND with the API's own message", async () => {
  const r = await cli(["mini", "getPetById", "--petId", "404"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.equal(err.error.code, "NOT_FOUND");
  assert.match(err.error.message, /pet not found/);
});

test("HTTP 401 -> AUTH_REQUIRED", async () => {
  const r = await cli(["mini", "getPetById", "--petId", "401"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr as string).error.code, "AUTH_REQUIRED");
});

test("HTTP 500 -> EXECUTION_ERROR with status in details", async () => {
  const r = await cli(["mini", "getPetById", "--petId", "500"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.equal(err.error.code, "EXECUTION_ERROR");
  assert.match(err.error.message, /kaboom/);
  assert.equal(err.error.details.httpStatus, 500);
});

test("HTTP 429 -> EXECUTION_ERROR with retryAfter", async () => {
  const r = await cli(["mini", "addPet", "--name", "boom"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr as string);
  assert.equal(err.error.code, "EXECUTION_ERROR");
  assert.equal(err.error.details.retryAfter, "7");
});

test("unset ${ENV} in a header -> AUTH_REQUIRED before any request", async () => {
  // empty string is a defined var; force undefined by deleting it from the child env
  const env: Record<string, string | undefined> = { ...process.env, AGENTCLI_CONFIG: configFile };
  delete env.TEST_TOKEN;
  const r2 = await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "mini", "listPets"], { cwd: ROOT, env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
  assert.equal(r2.status, 1);
  assert.equal(JSON.parse(r2.stderr).error.code, "AUTH_REQUIRED");
  assert.match(r2.stderr, /TEST_TOKEN/);
});

test("non-JSON 200 body: text output passes through raw; json wraps as string", async () => {
  const text = await cli(["mini", "getPetById", "--petId", "999", "--output", "text"]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal((text.stdout as string).trim(), "<h1>not json</h1>");

  const json = await cli(["mini", "getPetById", "--petId", "999"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout as string).data, "<h1>not json</h1>");
});

test("--schema prints the flattened input schema", async () => {
  const r = await cli(["mini", "addPet", "--schema"]);
  assert.equal(r.status, 0, r.stderr);
  const schema = JSON.parse(r.stdout as string);
  assert.equal(schema.properties.name.type, "string");
  assert.deepEqual(schema.properties.kind.enum, ["cat", "dog"]);
});

test("snapshot independence: calls work after the origin file disappears", async () => {
  fs.rmSync(originSpec);
  const r = await cli(["mini", "listPets"]);
  assert.equal(r.status, 0, r.stderr);
});

test("--refresh re-pulls a file origin (updated spec wins)", async () => {
  const updated = JSON.parse(fs.readFileSync(FIXTURE_SPEC, "utf8"));
  updated.paths["/refreshed"] = { get: { operationId: "refreshedOp", responses: { "200": { description: "ok" } } } };
  fs.writeFileSync(originSpec, JSON.stringify(updated));
  const stale = await cli(["mini", "-h"]);
  assert.equal(stale.status, 0, stale.stderr);
  assert.ok(!(stale.stdout as string).includes("refreshedOp"));
  const r = await cli(["server", "tools", "mini", "--refresh"]);
  assert.equal(r.status, 0, r.stderr);
  const names = JSON.parse(r.stdout as string).data.map((t: { name: string }) => t.name);
  assert.ok(names.includes("refreshedOp"));
});

test("server remove cleans up snapshot and cache", async () => {
  const r = await cli(["server", "remove", "mini"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(path.dirname(configFile), "specs", "mini.json")));
  assert.ok(!fs.existsSync(path.join(path.dirname(configFile), "cache", "mini.tools.json")));
});

test("add rejects swagger 2.0 specs with a clear error", async () => {
  const swaggerPath = path.join(tmp, "swagger.json");
  fs.writeFileSync(swaggerPath, JSON.stringify({ swagger: "2.0", info: { title: "x", version: "1" }, paths: {} }));
  const r = await cli(["server", "add", "old", "--openapi", swaggerPath]);
  assert.equal(r.status, 1);
  assert.match(r.stderr as string, /Swagger 2.0/);
});

test("add rejects YAML with a conversion hint", async () => {
  const yamlPath = path.join(tmp, "spec.yaml");
  fs.writeFileSync(yamlPath, "openapi: 3.0.3\ninfo:\n  title: x\n");
  const r = await cli(["server", "add", "y", "--openapi", yamlPath]);
  assert.equal(r.status, 1);
  assert.match(r.stderr as string, /YAML/);
});

test("add rejects --openapi together with --url and with a command", async () => {
  const a = await cli(["server", "add", "x1", "--openapi", originSpec, "--url", "http://mcp.example.com"]);
  assert.equal(a.status, 1);
  assert.match(a.stderr as string, /mutually exclusive/);
  const b = await cli(["server", "add", "x2", "--openapi", originSpec, "--", "node", "-v"]);
  assert.equal(b.status, 1);
  assert.match(b.stderr as string, /mutually exclusive/);
});