// Error taxonomy. Exit protocol is binary: 0 = success, 1 = failure.
// Semantics are self-describing on stderr: { code, message, hint } —
// the string code names the failure class, the hint carries the
// recommended next action. No numeric lookup table anywhere.
export const EXIT = {
  OK: 0,
  FAILURE: 1,
};

export class AgentCliError extends Error {
  constructor(code, message, { hint, details } = {}) {
    super(message);
    this.name = "AgentCliError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export const errors = {
  invalidArgument: (message, hint) =>
    new AgentCliError("INVALID_ARGUMENT", message, { hint }),
  notFound: (message, hint) =>
    new AgentCliError("NOT_FOUND", message, { hint }),
  execution: (message, details) =>
    new AgentCliError("EXECUTION_ERROR", message, { details }),
  connect: (message, details) =>
    new AgentCliError("CONNECT_FAILED", message, {
      details,
      hint: "check server config/env or `agentcli daemon` state; do not blind-retry",
    }),
  auth: (message) =>
    new AgentCliError("AUTH_REQUIRED", message, {
      hint: "ask the user for credentials; do not retry with the same token",
    }),
  timeout: (message) =>
    new AgentCliError("TIMEOUT", message, { hint: "retry, or raise --timeout-ms" }),
};

// Wire format for daemon <-> CLI error transport.
export function serializeError(e) {
  if (e instanceof AgentCliError) {
    return { code: e.code, message: e.message, hint: e.hint, details: e.details };
  }
  return { code: "INTERNAL", message: String((e && e.message) || e), hint: "agentcli bug — please report it" };
}

export function reviveError(raw) {
  if (raw && typeof raw.code === "string") {
    return new AgentCliError(raw.code, raw.message || "unknown error", {
      hint: raw.hint,
      details: raw.details,
    });
  }
  return new AgentCliError("INTERNAL", (raw && raw.message) || "unknown error");
}
