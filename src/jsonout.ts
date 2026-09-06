// stdout = machine-readable result, stderr = one-line JSON error (grep-friendly).
import type { AgentCliError } from "./errors.js";

export function printJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

export function printError(err: AgentCliError): void {
  const payload: Record<string, unknown> = {
    ok: false,
    error: {
      code: err.code || "INTERNAL",
      message: err.message,
    },
  };
  if (err.hint) (payload.error as Record<string, unknown>).hint = err.hint;
  if (err.details) (payload.error as Record<string, unknown>).details = err.details;
  process.stderr.write(JSON.stringify(payload) + "\n");
}
