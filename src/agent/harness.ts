import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { config, stateFile } from "../config.ts";
import { models } from "./models.ts";
import { registry } from "./registry.ts";

export const harness = await Harness.open(
	await openNodeSqliteStorage(stateFile("session.sqlite")),
	{ models, registry },
	BACKGROUND_CONTEXT,
);

const MODEL = { provider: "openai-codex", modelId: "gpt-6-luna" };

// Who the agent is comes from its deployment, never from this repo: one string
// that opens the conversation as its system prompt.
const PROMPT = config().prompt;

// `root()` applies the agent only when it creates the conversation; configure
// it on every start so model and prompt changes also reach an existing session.
export const root = await harness.root(BACKGROUND_CONTEXT);
await root.configure(
	{ model: MODEL, instructions: PROMPT },
	BACKGROUND_CONTEXT,
);
