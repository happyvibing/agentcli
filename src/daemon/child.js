// Detached daemon entrypoint: node src/daemon/child.js
import { runDaemon } from "./server.js";

runDaemon()
  .then((r) => {
    if (r && r.alreadyRunning) process.exit(0); // someone beat us to it
    // otherwise resolved on shutdown
    process.exit(0);
  })
  .catch((e) => {
    process.stderr.write("agentcli daemon failed: " + String((e && e.stack) || e) + "\n");
    process.exit(1);
  });