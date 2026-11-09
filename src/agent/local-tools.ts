import type { CodemodeTool } from "@earendil-works/pi-codemode";

import { fileTools } from "../files/tools.ts";
import { skillTools } from "../memory/skills.ts";
import { officeTools } from "../office/tools.ts";
import { telegramTools } from "../telegram/tools.ts";

/** The in-process tools in the codemode of the agent and of its workers. */
export const localTools: readonly CodemodeTool[] = [
	...fileTools,
	...officeTools,
	...telegramTools,
	...skillTools,
];
