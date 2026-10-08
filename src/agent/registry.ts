import { createRegistry } from "@earendil-works/pi-durable";

import { EndingsExtension } from "../endings/endings.ts";
import { servers, tokens } from "../mcp/config.ts";
import { SchedulerExtension } from "../scheduler/extension.ts";
import { subagents } from "../subagents/config.ts";
import { createSubagentExtension } from "../subagents/extension.ts";
import { memory } from "./memory.ts";
import { PromptFirstExtension } from "./prompt-first.ts";

// MCP servers install their own extensions once connected (`mcp/start.ts`),
// and each running subagent its own (`subagents/extension.ts`).
export const registry = createRegistry();
registry.install(PromptFirstExtension);
registry.install(memory.extension);
registry.install(EndingsExtension);
registry.install(SchedulerExtension);
if (subagents.size > 0) {
	registry.install(
		createSubagentExtension({ registry, subagents, servers, tokens }),
	);
}
