import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { models } from "./models.ts";
import { registry } from "./registry.ts";

// E2E points this at a fresh file so every test starts from an empty session.
const SESSION_FILE = process.env.AGENT_SESSION_FILE ?? "state/session.sqlite";

export const harness = await Harness.open(
	await openNodeSqliteStorage(SESSION_FILE),
	{ models, registry },
	BACKGROUND_CONTEXT,
);

const MODEL = { provider: "openai-codex", modelId: "gpt-6-luna" };

// Who the agent is comes from its deployment, never from this repo: one string
// that opens the conversation as its system prompt.
const PROMPT = process.env.AGENT_PROMPT;
if (!PROMPT) {
	throw new Error("AGENT_PROMPT is required");
}

// `root()` applies the agent only when it creates the conversation; configure
// it on every start so model and prompt changes also reach an existing session.
export const root = await harness.root(BACKGROUND_CONTEXT);
await root.configure(
	{ model: MODEL, instructions: PROMPT },
	BACKGROUND_CONTEXT,
);
