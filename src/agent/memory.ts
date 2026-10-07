import { createMemory } from "../memory/extension.ts";
import { models, SMALL_MODEL } from "./models.ts";

export const memory = createMemory({ models, model: SMALL_MODEL });

/** When the conversation is compacted: its session ends and a new context starts. */
export const compactionLimits = {
	idleMs: 60 * 60 * 1000,
	maxTokens: 750_000,
};
