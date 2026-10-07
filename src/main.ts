import { startAgent } from "./index.ts";

// As PID 1 in a container the process has no default handlers for these, so
// it would ignore `podman stop` until it is killed.
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

await startAgent();
