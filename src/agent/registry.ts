import { createRegistry } from "@earendil-works/pi-durable";

import { createProgressExtension } from "../progress/extension.ts";
import { SchedulerExtension } from "../scheduler/extension.ts";
import { publishProgress } from "../telegram/progress.ts";
import { memory } from "./memory.ts";
import { PromptFirstExtension } from "./prompt-first.ts";

// MCP servers install their own extensions once connected (`mcp/start.ts`).
export const registry = createRegistry();
registry.install(PromptFirstExtension);
registry.install(memory.extension);
registry.install(SchedulerExtension);
registry.install(createProgressExtension(publishProgress));
