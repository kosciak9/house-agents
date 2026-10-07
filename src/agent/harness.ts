import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { config, stateFile } from "../config.ts";
import { isSubagentRun } from "../subagents/extension.ts";
import { models } from "./models.ts";
import { registry } from "./registry.ts";

export const harness = await Harness.open(
	await openNodeSqliteStorage(stateFile("session.sqlite")),
	{
		models,
		registry,
		onReport: (error) => console.error("Harness:", error),
		settings: {
			// Every installed extension but the subagents' own, read at every use.
			get extensions() {
				return registry
					.snapshot()
					.installed()
					.filter((extension) => !isSubagentRun(extension));
			},
		},
	},
	BACKGROUND_CONTEXT,
);

// Who the agent is and what it runs on come from its deployment, never from
// this repo: the prompt opens the conversation as its system prompt.
const { prompt, model } = config();
if (!models.getModel(model.provider, model.modelId)) {
	throw new Error(`config.model ${model.provider}/${model.modelId} is unknown`);
}

// `root()` applies the agent only when it creates the conversation; configure
// it on every start so model and prompt changes also reach an existing session.
export const root = await harness.root(BACKGROUND_CONTEXT);
await root.configure(
	{
		model: { provider: model.provider, modelId: model.modelId },
		thinkingLevel: model.thinkingLevel ?? null,
		instructions: prompt,
	},
	BACKGROUND_CONTEXT,
);
