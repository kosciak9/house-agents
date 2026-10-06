import { createRegistry } from "@earendil-works/pi-durable";

import { servers } from "../mcp/config.ts";
import { createMcpExtension } from "../mcp/extension.ts";
import { createProgressExtension } from "../progress/extension.ts";
import { SchedulerExtension } from "../scheduler/extension.ts";
import { publishProgress } from "../telegram/progress.ts";

export const registry = createRegistry();
registry.install(SchedulerExtension);
registry.install(await createMcpExtension(servers));
registry.install(createProgressExtension(publishProgress));
