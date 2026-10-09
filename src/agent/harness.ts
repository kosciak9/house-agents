import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { config, modelSettings, stateFile } from "../config.ts";
import { rootExtensions } from "../subagents/extension.ts";
import { withFallback } from "./fallback.ts";
import { models } from "./models.ts";
import { registry } from "./registry.ts";

// Who the agent is and what it runs on come from its deployment, never from
// this repo: the prompt opens the conversation as its system prompt.
const { prompt, model, fallbackModel } = config();
if (!models.getModel(model.provider, model.modelId)) {
	throw new Error(`config.model ${model.provider}/${model.modelId} is unknown`);
}

export const harness = await Harness.open(
	await openNodeSqliteStorage(stateFile("session.sqlite")),
	{
		models: fallbackModel ? withFallback(models, model, fallbackModel) : models,
		registry,
		onReport: (error) => console.error("Harness:", error),
		settings: {
			// Every installed extension but the subagents' own, read at every use.
			get extensions() {
				return rootExtensions(registry);
			},
			// pi's own compaction would keep a summary in the context; the memory
			// compacts instead: the session becomes a line of memory and a new
			// context starts (`src/memory/keeper.ts`, /compact).
			compaction: { enabled: false },
		},
	},
	BACKGROUND_CONTEXT,
);

// `root()` applies the agent only when it creates the conversation; configure
// it on every start so model and prompt changes also reach an existing session.
export const root = await harness.root(BACKGROUND_CONTEXT);
await root.configure(
	{ ...modelSettings(model), instructions: prompt },
	BACKGROUND_CONTEXT,
);
