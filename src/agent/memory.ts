import { config } from "../config.ts";
import { createMemory } from "../memory/extension.ts";
import type { CompactionLimits } from "../memory/keeper.ts";
import { models, SMALL_MODEL } from "./models.ts";

export const memory = createMemory({ models, model: SMALL_MODEL });

/** When the conversation is compacted: its session ends and a new context starts. */
export const compactionLimits: CompactionLimits = {
	idleMs: 60 * 60 * 1000,
	maxTokens: 300_000,
	cron: config().compaction,
};
