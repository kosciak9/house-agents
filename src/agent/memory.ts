import { createMemory } from "../memory/extension.ts";
import { models, SMALL_MODEL } from "./models.ts";

export const memory = createMemory({ models, model: SMALL_MODEL });

/** When a session of the conversation ends and a new context starts. */
export const sessionLimits = {
	idleMs: 60 * 60 * 1000,
	maxTokens: 750_000,
};
