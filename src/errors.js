// Error taxonomy + exit-code protocol (see docs/PROTOCOL section in README).
export const EXIT = {
  OK: 0,               // success
  EXECUTION: 1,        // tool execution failure / transport failure
  INVALID_ARGUMENT: 2, // bad flags, bad --input, bad usage
  AUTH: 10,            // authentication required
  PERMISSION: 11,      // permission denied
  NOT_FOUND: 12,       // server or tool not found
  TIMEOUT: 13,         // request timed out
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
    new AgentCliError("INVALID_ARGUMENT", message, { exitCode: EXIT.INVALID_ARGUMENT, hint }),
  notFound: (message, hint) =>
    new AgentCliError("NOT_FOUND", message, { exitCode: EXIT.NOT_FOUND, hint }),
  execution: (message, details) =>
    new AgentCliError("EXECUTION_ERROR", message, { exitCode: EXIT.EXECUTION, details }),
  connect: (message, details) =>
    new AgentCliError("CONNECT_FAILED", message, { exitCode: EXIT.EXECUTION, details }),
  auth: (message) => new AgentCliError("AUTH_REQUIRED", message, { exitCode: EXIT.AUTH }),
  timeout: (message) => new AgentCliError("TIMEOUT", message, { exitCode: EXIT.TIMEOUT }),
  usage: (message, hint) =>
    new AgentCliError("USAGE", message, { exitCode: EXIT.INVALID_ARGUMENT, hint }),
};