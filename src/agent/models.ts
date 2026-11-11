import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

import { config } from "../config.ts";
import { credentials } from "./credentials.ts";
import { withFallback } from "./fallback.ts";

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

// Models OpenRouter serves that pi-ai's catalog does not list yet: each is a
// sibling's entry under its own id, at its own price.
const OPENROUTER_ADDED = [
	{
		sibling: "anthropic/claude-sonnet-5.5",
		id: "anthropic/claude-haiku-5.5",
		name: "Anthropic: Claude Haiku 5.5",
		cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	},
	{
		sibling: "openai/gpt-6.1-sol",
		id: "openai/gpt-6.1-terra",
		name: "OpenAI: GPT-6.1 Terra",
		cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0 },
	},
];

const openrouter = openrouterProvider();
const withAdded = <M extends { id: string }>(catalog: readonly M[]): M[] => [
	...catalog,
	...OPENROUTER_ADDED.flatMap(({ sibling, ...added }) => {
		const entry = catalog.find((model) => model.id === sibling);
		return entry && !catalog.some((model) => model.id === added.id)
			? [{ ...entry, ...added }]
			: [];
	}),
];

// The subscriptions the agent can run on; the user logs in to each from the
// chat (`/login`). OpenRouter takes its key from OPENROUTER_API_KEY.
export const models = createModels({ credentials });
models.setProvider({
	...codex,
	getModels: () => codex.getModels().map(withWindow),
	getAllModels: () => (codex.getAllModels?.() ?? []).map(withWindow),
});
models.setProvider({
	...openrouter,
	getModels: () => withAdded(openrouter.getModels()),
	getAllModels: () => withAdded(openrouter.getAllModels?.() ?? []),
});
models.setProvider(xaiProvider());
for (const provider of config().providers ?? []) models.setProvider(provider);

/** A cheap model for helper work that would waste the agent's own turns. */
export const SMALL_MODEL = config().smallModel ?? {
	provider: "openai-codex",
	modelId: "gpt-6-luna",
};

/**
 * What the agent, its subagents and its memory run on: `models` with the
 * fallback model, so every request to the agent's model can fall back.
 */
const { model, fallbackModel } = config();
export const agentModels = fallbackModel
	? withFallback(models, model, fallbackModel)
	: models;
