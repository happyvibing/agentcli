// Local $ref resolver: inlines #/components/... references into standalone
// schemas. External refs are rejected with a clear error; circular refs decay
// into an opaque object marker instead of recursing forever.
import { errors } from "../errors.js";

const MAX_DEPTH = 16;
const CIRCULAR: Record<string, unknown> = { type: "object", description: "(circular $ref)" };
// Keys that never affect execution and are often huge — skip resolving inside.
const SKIP_KEYS = new Set(["example", "examples", "externalDocs"]);

function lookupPointer(root: unknown, ref: string): unknown {
  const parts = ref
    .slice(2)
    .split("/")
    .map((s) => decodeURIComponent(s).replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function resolveRefs(node: unknown, root: unknown, seen: ReadonlySet<string> = new Set(), depth = 0): unknown {
  if (depth > MAX_DEPTH) return { type: "object", description: "(too deeply nested)" };
  if (Array.isArray(node)) {
    return node.map((v) => resolveRefs(v, root, seen, depth + 1));
  }
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const ref = typeof obj.$ref === "string" ? obj.$ref : undefined;
  if (ref) {
    if (!ref.startsWith("#/")) {
      throw errors.invalidArgument(
        'external $ref is not supported: "' + ref + '"',
        "Inline the referenced schema into the spec, or bundle it (tools like openapi-cli / redocly can bundle)"
      );
    }
    if (seen.has(ref)) return { ...CIRCULAR };
    const target = lookupPointer(root, ref);
    if (target === undefined) {
      throw errors.invalidArgument('unresolvable $ref: "' + ref + '"', "Fix the spec — the referenced path does not exist");
    }
    const { $ref: _drop, ...siblings } = obj;
    const resolved = resolveRefs(target, root, new Set(seen).add(ref), depth + 1);
    if (resolved !== null && typeof resolved === "object" && Object.keys(siblings).length) {
      return { ...(resolved as object), ...siblings };
    }
    return resolved;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SKIP_KEYS.has(k) ? v : resolveRefs(v, root, seen, depth + 1);
  }
  return out;
}