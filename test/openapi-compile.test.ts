// Unit tests for the OpenAPI spec -> ToolDef compiler.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileSpec } from "../src/openapi/compile.js";
import { resolveRefs } from "../src/openapi/ref.js";
import { AgentCliError } from "../src/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "fixtures", "openapi.json"), "utf8"));

function byName(tools: ReturnType<typeof compileSpec>, name: string) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, "expected tool " + name + " to compile");
  return t;
}

test("compiles operations with operationId as tool names", () => {
  const tools = compileSpec(doc);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("getPetById"));
  assert.ok(names.includes("listPets"));
  assert.ok(names.includes("addPet"));
  assert.ok(names.includes("getOrder"));
});

test("missing operationId falls back to a mechanical slug", () => {
  const tools = compileSpec(doc);
  assert.ok(tools.some((t) => t.name === "get_no-op-id"));
});

test("duplicate names get deterministic suffixes", () => {
  const dup = JSON.parse(JSON.stringify(doc));
  dup.paths["/pets/{petId}"].get.operationId = "listPets";
  const tools = compileSpec(dup);
  const names = tools.map((t) => t.name);
  assert.equal(names.filter((n) => n.startsWith("listPets")).length, 2);
  assert.ok(names.includes("listPets_2"));
});

test("path params are forced required; query params optional unless declared", () => {
  const tool = byName(compileSpec(doc), "getPetById");
  assert.deepEqual(tool.inputSchema?.required, ["petId"]);
  assert.equal(tool.inputSchema?.properties?.petId.type, "integer");
  assert.equal(tool.inputSchema?.properties?.verbose.type, "boolean");
});

test("parameter $refs are inlined with defaults", () => {
  const tool = byName(compileSpec(doc), "getPetById");
  const limit = tool.inputSchema?.properties?.limit;
  assert.equal(limit?.type, "integer");
  assert.equal(limit?.default, 10);
  assert.equal(limit?.description, "Page size");
  assert.equal(tool.openapiMeta?.queryParams.limit, "limit");
});

test("body properties flatten to top-level flags", () => {
  const tool = byName(compileSpec(doc), "addPet");
  const props = tool.inputSchema?.properties || {};
  assert.equal(props.name.type, "string");
  assert.deepEqual(props.kind.enum, ["cat", "dog"]); // resolved $ref inlined
  assert.deepEqual(tool.inputSchema?.required, ["name"]);
  assert.equal(tool.openapiMeta?.bodyProps.name, "name");
});

test("array body becomes a whole-body param", () => {
  const tool = byName(compileSpec(doc), "postBatch");
  assert.equal(tool.openapiMeta?.rawBody, "body");
  assert.equal(tool.inputSchema?.properties?.body.type, "array");
});

test("circular $refs decay instead of recursing", () => {
  const tools = compileSpec(doc); // must not hang
  const tool = byName(tools, "postCircular");
  const children = tool.inputSchema?.properties?.children as { items?: { description?: string } };
  assert.match(String(children?.items?.description || ""), /circular/);
});

test("tags are collected for help grouping", () => {
  const tools = compileSpec(doc);
  assert.deepEqual(byName(tools, "getPetById").tags, ["pets"]);
  assert.deepEqual(byName(tools, "getOrder").tags, ["store"]);
  assert.equal(byName(tools, "get_no-op-id").tags, undefined);
});

test("header params map to header flags", () => {
  const tool = byName(compileSpec(doc), "getOrder");
  assert.equal(tool.openapiMeta?.headerParams["X-Request-Id"], "X-Request-Id");
});

test("meta records method, path template, baseUrl", () => {
  const tool = byName(compileSpec(doc), "getPetById");
  assert.equal(tool.openapiMeta?.method, "GET");
  assert.equal(tool.openapiMeta?.path, "/pets/{petId}");
  assert.equal(tool.openapiMeta?.baseUrl, "https://api.mini.test/v1");
});

test("baseUrl override wins over spec servers", () => {
  const tool = byName(compileSpec(doc, { baseUrl: "https://override.test" }), "getPetById");
  assert.equal(tool.openapiMeta?.baseUrl, "https://override.test");
});

test("no servers and no override -> clear error", () => {
  const noServers = { ...doc, servers: [] };
  assert.throws(() => compileSpec(noServers), (e: unknown) => {
    assert.ok(e instanceof AgentCliError);
    assert.match(e.message, /--base-url/);
    return true;
  });
});

test("swagger 2.0 is rejected with an upgrade hint", () => {
  assert.throws(() => compileSpec({ swagger: "2.0", paths: {} }), (e: unknown) => {
    assert.ok(e instanceof AgentCliError);
    assert.match(e.message, /Swagger 2.0/);
    return true;
  });
});

test("non-3.x openapi field is rejected", () => {
  assert.throws(() => compileSpec({ openapi: "4.0.0", paths: {} }), AgentCliError);
});

test("resolveRefs: external refs are rejected", () => {
  assert.throws(() => resolveRefs({ $ref: "https://evil.example.com/schema.json" }, doc), (e: unknown) => {
    assert.ok(e instanceof AgentCliError);
    assert.match(e.message, /external/);
    return true;
  });
});

test("resolveRefs: unresolvable pointer is rejected", () => {
  assert.throws(() => resolveRefs({ $ref: "#/components/schemas/Missing" }, doc), (e: unknown) => {
    assert.ok(e instanceof AgentCliError);
    assert.match(e.message, /unresolvable/);
    return true;
  });
});

test("relative server URL resolves against the spec origin URL", () => {
  const relative = JSON.parse(JSON.stringify(doc));
  relative.servers = [{ url: "/api/v3" }];
  const tool = byName(compileSpec(relative, { originUrl: "https://petstore.example.com/specs/openapi.json" }), "getPetById");
  assert.equal(tool.openapiMeta?.baseUrl, "https://petstore.example.com/api/v3");
});

test("path-level parameters merge with operation parameters", () => {
  const shared = JSON.parse(JSON.stringify(doc));
  shared.paths["/pets/{petId}"].parameters = [{ name: "X-Shared", in: "header", schema: { type: "string" } }];
  const tool = byName(compileSpec(shared), "getPetById");
  assert.equal(tool.inputSchema?.properties?.["X-Shared"].type, "string");
});