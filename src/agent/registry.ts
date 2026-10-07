import { createRegistry } from "@earendil-works/pi-durable";

import { servers, tokens } from "../mcp/config.ts";
import { createProgressExtension } from "../progress/extension.ts";
import { SchedulerExtension } from "../scheduler/extension.ts";
import { subagents } from "../subagents/config.ts";
import { createSubagentExtension } from "../subagents/extension.ts";
import { publishProgress } from "../telegram/progress.ts";
import { memory } from "./memory.ts";
import { PromptFirstExtension } from "./prompt-first.ts";

// MCP servers install their own extensions once connected (`mcp/start.ts`),
// and each running subagent its own (`subagents/extension.ts`).
export const registry = createRegistry();
registry.install(PromptFirstExtension);
registry.install(memory.extension);
registry.install(SchedulerExtension);
registry.install(createProgressExtension(publishProgress));
if (subagents.size > 0) {
	registry.install(
		createSubagentExtension({ registry, subagents, servers, tokens }),
	);
}
