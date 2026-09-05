// stdout = machine-readable result, stderr = one-line JSON error (grep-friendly).
export function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

export function printError(err) {
  const payload = {
    ok: false,
    error: {
      code: err.code || "INTERNAL",
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.details ? { details: err.details } : {}),
    },
  };
  process.stderr.write(JSON.stringify(payload) + "\n");
}