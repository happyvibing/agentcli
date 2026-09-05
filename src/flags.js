// Schema compiler (MVP scope): top-level primitive properties -> CLI flags.
// Everything else (objects, arrays of objects, anyOf/$ref/...) requires --input.
// --input accepts inline JSON, @file, or - (stdin). Flags override --input keys.
import fs from "node:fs";
import { errors } from "./errors.js";

const CONTROL_FLAGS = new Set(["input", "output", "schema", "refresh", "help", "timeout-ms", "no-daemon"]);

export function buildFlagPlan(inputSchema) {
  const schema = inputSchema || {};
  const required = new Set(schema.required || []);
  const plan = { flags: new Map(), complex: [] };
  const props = schema.properties || {};
  for (const name of Object.keys(props)) {
    const ps = props[name] || {};
    const complex =
      !ps.type ||
      ps.type === "object" ||
      (ps.type === "array" && (!ps.items || !ps.items.type || ps.items.type === "object")) ||
      ps.anyOf || ps.oneOf || ps.allOf || ps.$ref;
    if (complex) {
      plan.complex.push({ name, description: ps.description || "" });
    } else {
      plan.flags.set(name, {
        name,
        type: ps.type,
        itemType: ps.type === "array" ? (ps.items && ps.items.type) || "string" : undefined,
        enum: ps.enum,
        default: ps.default,
        description: ps.description || "",
        required: required.has(name),
      });
    }
  }
  return plan;
}

function coerceValue(spec, raw) {
  const type = spec.type === "array" ? spec.itemType : spec.type;
  if (type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw errors.invalidArgument('invalid boolean for --' + spec.name + ': "' + raw + '"', "Use --" + spec.name + " or --" + spec.name + "=true|false");
  }
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) {
      throw errors.invalidArgument("invalid " + type + " for --" + spec.name + ': "' + raw + '"');
    }
    return n;
  }
  if (spec.enum && !spec.enum.includes(raw)) {
    throw errors.invalidArgument('invalid value for --' + spec.name + ': "' + raw + '"', "Allowed values: " + spec.enum.join(", "));
  }
  return raw;
}

// tokens: everything after `agentcli <server> <tool>`
export function parseToolArgs(plan, tokens) {
  const args = {};
  const opts = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("--")) {
      throw errors.invalidArgument('unexpected positional argument "' + tok + '"', "Pass values as flags, or the whole object via --input '<json>'");
    }
    let body = tok.slice(2);
    let value;
    let hasValue = false;
    const eq = body.indexOf("=");
    if (eq >= 0) {
      value = body.slice(eq + 1);
      body = body.slice(0, eq);
      hasValue = true;
    }
    if (CONTROL_FLAGS.has(body)) {
      if (body === "schema" || body === "refresh" || body === "help" || body === "no-daemon") {
        opts[body] = hasValue ? value === "true" : true;
      } else {
        if (!hasValue) {
          value = tokens[++i];
          if (value === undefined) throw errors.invalidArgument("--" + body + " requires a value");
        }
        opts[body] = value;
      }
      continue;
    }
    const spec = plan.flags.get(body);
    if (!spec) {
      const hints = [];
      const available = [...plan.flags.keys()].map((k) => "--" + k).join(", ");
      if (available) hints.push("Available flags: " + available);
      if (plan.complex.length) hints.push("Complex parameters (use --input): " + plan.complex.map((c) => c.name).join(", "));
      if (!hints.length) hints.push("Run: agentcli <server> <tool> --help");
      throw errors.invalidArgument("unknown option --" + body, hints.join(" | "));
    }
    let raw = value;
    if (!hasValue && spec.type !== "boolean") {
      raw = tokens[++i];
      if (raw === undefined || raw.startsWith("--")) {
        throw errors.invalidArgument("--" + body + " requires a value", "Use --" + body + "=<value> when the value itself starts with --");
      }
    }
    if (hasValue === false && spec.type === "boolean") raw = "true";
    const parsed = coerceValue(spec, raw);
    if (spec.type === "array") {
      (args[body] ||= []).push(parsed);
    } else {
      args[body] = parsed;
    }
  }
  return { args, opts };
}

export function readInputJson(spec) {
  let rawText;
  if (spec === "-") {
    rawText = fs.readFileSync(0, "utf8");
  } else if (spec.startsWith("@")) {
    try {
      rawText = fs.readFileSync(spec.slice(1), "utf8");
    } catch (e) {
      throw errors.invalidArgument("cannot read --input file: " + spec.slice(1), e.message);
    }
  } else {
    rawText = spec;
  }
  let value;
  try {
    value = JSON.parse(rawText);
  } catch (e) {
    throw errors.invalidArgument("--input is not valid JSON", e.message);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw errors.invalidArgument("--input must be a JSON object");
  }
  return value;
}

export function mergeArgs(base, overrides) {
  return { ...(base || {}), ...(overrides || {}) };
}

export function renderToolHelp(serverName, tool) {
  const plan = buildFlagPlan(tool.inputSchema);
  const lines = [];
  lines.push(serverName + " " + tool.name);
  if (tool.description) lines.push("", tool.description);
  lines.push("", "Usage:", "  agentcli " + serverName + " " + tool.name + " [flags]");
  const flags = [...plan.flags.values()];
  const req = flags.filter((f) => f.required);
  const opt = flags.filter((f) => !f.required);
  if (req.length) {
    lines.push("", "Required:");
    for (const f of req) lines.push("  --" + f.name + " <" + f.type + ">" + (f.description ? "    " + f.description : ""));
  }
  if (opt.length || plan.complex.length) {
    lines.push("", "Optional:");
    for (const f of opt) {
      const parts = [f.description];
      if (f.enum) parts.push("choices: " + f.enum.join("|"));
      if (f.default !== undefined) parts.push("default: " + JSON.stringify(f.default));
      const d = parts.filter(Boolean).join("; ");
      lines.push("  --" + f.name + " <" + f.type + ">" + (d ? "    " + d : ""));
    }
    for (const c of plan.complex) {
      lines.push("  " + c.name + "    " + (c.description || "complex parameter") + " — pass via --input '<json>'");
    }
  }
  lines.push(
    "",
    "Global:",
    "  --input <json|@file|->    Full JSON arguments object (flags override --input keys)",
    "  --output <json|text>      Output format (default: json)",
    "  --schema                  Print the raw tool input schema",
    "  --refresh                 Bypass the cached tool list",
    "  --timeout-ms <n>          Request timeout in milliseconds"
  );
  return lines.join("\n");
}