// OpenAPI 3.x spec -> ToolDef[] compiler. Each operation becomes one tool:
// path/query/header params and JSON body properties are flattened into a single
// inputSchema, so the existing flag compiler (flags.ts) works unchanged.
import { errors } from "../errors.js";
import type { OpenApiOperationMeta, ToolDef, ToolInputSchema, ToolPropertySchema } from "../types.js";
import { resolveRefs } from "./ref.js";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

interface OpenApiParam {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
  content?: Record<string, { schema?: unknown }>;
  [key: string]: unknown;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  [key: string]: unknown;
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// Mechanical, predictable fallback: GET /pets/{petId} -> get_pets_petId
function slugName(method: string, path: string): string {
  const p = path
    .replace(/^\//, "")
    .replace(/\//g, "_")
    .replace(/[{}]/g, "");
  return sanitizeName(method.toLowerCase() + "_" + p);
}

function expandServerUrl(server: { url?: string; variables?: Record<string, { default?: string }> }): string {
  const url = server.url || "";
  return url.replace(/\{([^}]+)\}/g, (_m, v: string) => server.variables?.[v]?.default ?? "{" + v + "}");
}

function resolveBaseUrl(doc: Record<string, unknown>, override?: string, originUrl?: string): string {
  const base = override || "";
  if (base) return base.replace(/\/+$/, "");
  const servers = (doc.servers as Array<{ url?: string; variables?: Record<string, { default?: string }> }> | undefined)?.[0];
  if (servers && servers.url) {
    let url = expandServerUrl(servers).replace(/\/+$/, "");
    // Relative server URLs (e.g. "/api/v3") resolve against the spec's origin.
    if (url.startsWith("/") && originUrl) {
      try {
        url = new URL(url, originUrl).toString().replace(/\/+$/, "");
      } catch {
        // leave as-is; a later new URL() in exec will produce a clear error
      }
    }
    return url;
  }
  throw errors.invalidArgument(
    "spec declares no servers entry and no --base-url was given",
    "agentcli server add <name> --openapi <spec> --base-url https://api.example.com"
  );
}

// Top-level allOf: merge properties/required from each resolved branch.
function mergeAllOf(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.allOf)) return schema;
  const props: Record<string, unknown> = {};
  const required = new Set<string>((schema.required as string[]) || []);
  for (const sub of schema.allOf as Record<string, unknown>[]) {
    Object.assign(props, (sub.properties as Record<string, unknown>) || {});
    for (const r of (sub.required as string[]) || []) required.add(r);
  }
  Object.assign(props, (schema.properties as Record<string, unknown>) || {});
  const out: Record<string, unknown> = { ...schema, properties: props };
  if (required.size) out.required = [...required];
  else delete out.required;
  delete out.allOf;
  return out;
}

export interface CompileOptions {
  baseUrl?: string; // --base-url override
  originUrl?: string; // spec origin URL, for resolving relative server entries
}

export function compileSpec(doc: unknown, opts: CompileOptions = {}): ToolDef[] {
  if (!doc || typeof doc !== "object") throw errors.invalidArgument("OpenAPI spec is not a JSON object");
  const d = doc as Record<string, unknown>;
  if (typeof d.swagger === "string") {
    throw errors.invalidArgument("spec is Swagger 2.0, only OpenAPI 3.x is supported", "Upgrade the spec to 3.x (e.g. with openapi-diff / swagger2openapi)");
  }
  if (typeof d.openapi !== "string" || !d.openapi.startsWith("3.")) {
    throw errors.invalidArgument('spec has no "openapi: 3.x" version field', "Expected OpenAPI 3.x JSON");
  }
  const baseUrl = resolveBaseUrl(d, opts.baseUrl, opts.originUrl);

  const paths = (d.paths as Record<string, Record<string, unknown>>) || {};
  const tools: ToolDef[] = [];
  const nameCount = new Map<string, number>();

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!path.startsWith("/") || !pathItem || typeof pathItem !== "object") continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? (pathItem.parameters as unknown[]) : [];

    for (const method of METHODS) {
      const op = pathItem[method] as OpenApiOperation | undefined;
      if (!op || typeof op !== "object") continue;

      // --- name ---
      let name = op.operationId ? sanitizeName(op.operationId) : slugName(method, path);
      const seen = nameCount.get(name) || 0;
      nameCount.set(name, seen + 1);
      if (seen > 0) name = name + "_" + (seen + 1);

      // --- parameters: path-item level + operation level (op wins by name+in) ---
      const opParams = Array.isArray(op.parameters) ? op.parameters : [];
      const merged: OpenApiParam[] = [];
      const keyed = (p: OpenApiParam) => (p.in || "") + ":" + (p.name || "");
      const opResolved = opParams.map((p) => resolveRefs(p, d) as OpenApiParam);
      for (const p of sharedParams.map((p) => resolveRefs(p, d) as OpenApiParam)) {
        if (!opResolved.some((q) => keyed(q) === keyed(p))) merged.push(p);
      }
      merged.push(...opResolved);

      const properties: Record<string, ToolPropertySchema> = {};
      const required = new Set<string>();
      const meta: OpenApiOperationMeta = { method: method.toUpperCase(), path, baseUrl, pathParams: {}, queryParams: {}, headerParams: {}, bodyProps: {} };
      const taken = new Set<string>(); // flag names already used

      for (const param of merged) {
        const loc = param.in;
        if (loc !== "path" && loc !== "query" && loc !== "header") continue; // cookie skipped
        if (!param.name) continue;
        let schema = (param.schema as ToolPropertySchema) || undefined;
        if (!schema && param.content) {
          const json = Object.entries(param.content).find(([mime]) => mime.startsWith("application/json"));
          if (json) schema = json[1].schema as ToolPropertySchema;
        }
        schema = (resolveRefs(schema || { type: "string" }, d) as ToolPropertySchema) || { type: "string" };
        if (param.description && !schema.description) schema = { ...schema, description: param.description };

        let flag = param.name;
        if (taken.has(flag)) flag = loc + "_" + param.name; // same name in two locations
        taken.add(flag);
        properties[flag] = schema;
        if (loc === "path") {
          required.add(flag);
          meta.pathParams[flag] = param.name;
        } else if (loc === "query") {
          if (param.required) required.add(flag);
          meta.queryParams[flag] = param.name;
        } else {
          if (param.required) required.add(flag);
          meta.headerParams[flag] = param.name;
        }
      }

      // --- requestBody (application/json only) ---
      let bodyNote = "";
      const rb = resolveRefs(op.requestBody, d) as { content?: Record<string, { schema?: unknown }> } | undefined;
      const jsonContent = rb?.content && Object.entries(rb.content).find(([mime]) => mime.startsWith("application/json"));
      if (rb && !jsonContent) {
        const mimes = Object.keys(rb.content || {}).join(", ") || "(none)";
        bodyNote = "\n(body content type not supported: " + mimes + ")";
      }
      if (jsonContent && jsonContent[1].schema) {
        let schema = resolveRefs(jsonContent[1].schema, d) as Record<string, unknown>;
        schema = mergeAllOf(schema);
        const props = (schema.properties as Record<string, ToolPropertySchema>) || {};
        const bodyRequired = new Set<string>((schema.required as string[]) || []);
        if (schema.type === "object" && Object.keys(props).length) {
          // flatten body properties to top-level flags
          for (const [propName, pschema] of Object.entries(props)) {
            let flag = propName;
            if (taken.has(flag)) flag = "body_" + propName; // collision with a param
            taken.add(flag);
            properties[flag] = pschema;
            if (bodyRequired.has(propName)) required.add(flag);
            meta.bodyProps[flag] = propName;
          }
        } else {
          // non-object body (array/string/...): single param holding the whole body
          let flag = "body";
          if (taken.has(flag)) flag = "body_";
          taken.add(flag);
          properties[flag] = schema as ToolPropertySchema;
          meta.rawBody = flag;
        }
      }

      // --- description ---
      const descParts = [op.summary, op.description].filter((s) => typeof s === "string" && s) as string[];
      const description = (descParts.join("\n\n") || method.toUpperCase() + " " + path) + "\n(" + method.toUpperCase() + " " + path + ")" + bodyNote;

      const inputSchema: ToolInputSchema = { type: "object", properties };
      if (required.size) inputSchema.required = [...required];

      tools.push({ name, description, inputSchema, tags: op.tags, openapiMeta: meta });
    }
  }
  return tools;
}