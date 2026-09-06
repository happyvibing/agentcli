// Error taxonomy + exit-code protocol (see README "Output protocol").
// Exit codes are RECOVERY CLASSES, dense 0..6: 0 ok | 1 tool failed |
// 2 caller fixable | 3 auth | 4 timeout | 5 connect | 6 internal bug.
// Precise diagnosis lives in the stderr JSON `error.code` string.
export const EXIT = {
  OK: 0,         // success
  EXECUTION: 1,   // the tool ran and reported an error
  USAGE: 2,       // caller-side fix: bad flags, bad --input, unknown server/tool/command
  AUTH: 3,        // credentials missing or rejected
  TIMEOUT: 4,     // request timed out (retryable)
  CONNECT: 5,     // transport / server startup failure
  INTERNAL: 6,    // agentcli bug — report, do not retry
};

export class AgentCliError extends Error {
  constructor(code, message, { exitCode = EXIT.EXECUTION, hint, details } = {}) {
    super(message);
    this.name = "AgentCliError";
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
    this.details = details;
  }
}

export const errors = {
  invalidArgument: (message, hint) =>
    new AgentCliError("INVALID_ARGUMENT", message, { exitCode: EXIT.USAGE, hint }),
  notFound: (message, hint) =>
    new AgentCliError("NOT_FOUND", message, { exitCode: EXIT.USAGE, hint }),
  execution: (message, details) =>
    new AgentCliError("EXECUTION_ERROR", message, { exitCode: EXIT.EXECUTION, details }),
  connect: (message, details) =>
    new AgentCliError("CONNECT_FAILED", message, { exitCode: EXIT.CONNECT, details }),
  auth: (message) => new AgentCliError("AUTH_REQUIRED", message, { exitCode: EXIT.AUTH }),
  timeout: (message) => new AgentCliError("TIMEOUT", message, { exitCode: EXIT.TIMEOUT }),
};

// Wire format for daemon <-> CLI error transport.
export function serializeError(e) {
  if (e instanceof AgentCliError) {
    return { code: e.code, message: e.message, hint: e.hint, details: e.details, exitCode: e.exitCode };
  }
  return { code: "INTERNAL", message: String((e && e.message) || e), exitCode: EXIT.INTERNAL };
}

export function reviveError(raw) {
  if (raw && typeof raw.code === "string" && typeof raw.exitCode === "number") {
    return new AgentCliError(raw.code, raw.message || "unknown error", {
      exitCode: raw.exitCode,
      hint: raw.hint,
      details: raw.details,
    });
  }
  return new AgentCliError("INTERNAL", (raw && raw.message) || "unknown error");
}