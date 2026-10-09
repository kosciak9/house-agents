import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

import { config } from "../config.ts";
import { credentials } from "./credentials.ts";

// pi-ai lists these at 272k tokens, the window of their base price; they take
// a million, at a higher price above 272k.
const CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-6-luna": 1_000_000,
	"gpt-6.1-sol": 1_000_000,
};

const codex = openaiCodexProvider();
const withWindow = <M extends { id: string; contextWindow?: number }>(
	model: M,
): M =>
	CONTEXT_WINDOWS[model.id] === undefined
		? model
		: { ...model, contextWindow: CONTEXT_WINDOWS[model.id] };

// The subscriptions the agent can run on; the user logs in to each from the
// chat (`/login`).
export const models = createModels({ credentials });
models.setProvider({
	...codex,
	getModels: () => codex.getModels().map(withWindow),
	getAllModels: () => (codex.getAllModels?.() ?? []).map(withWindow),
});
models.setProvider(xaiProvider());
for (const provider of config().providers ?? []) models.setProvider(provider);

/** A cheap model for helper work that would waste the agent's own turns. */
export const SMALL_MODEL = { provider: "openai-codex", modelId: "gpt-6-luna" };
