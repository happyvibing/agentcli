// Detached daemon entrypoint: node dist/src/daemon/child.js
import { runDaemon } from "./server.js";

runDaemon()
  .then((r) => {
    if (r && r.alreadyRunning) process.exit(0); // someone beat us to it
    // otherwise resolved on shutdown
    process.exit(0);
  })
  .catch((e: unknown) => {
    const err = e as Error;
    process.stderr.write("agentcli daemon failed: " + String((err && err.stack) || e) + "\n");
    process.exit(1);
  });
