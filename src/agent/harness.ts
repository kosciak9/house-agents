import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { models } from "./models.ts";
import { registry } from "./registry.ts";

const SESSION_FILE = "state/session.sqlite";

export const harness = await Harness.open(
	await openNodeSqliteStorage(SESSION_FILE),
	{ models, registry },
	BACKGROUND_CONTEXT,
);

const MODEL = { provider: "openai-codex", modelId: "gpt-6-luna" };

// `root()` applies the agent only when it creates the conversation; configure
// it on every start so the model chosen here also reaches an existing session.
export const root = await harness.root(BACKGROUND_CONTEXT);
await root.configure({ model: MODEL }, BACKGROUND_CONTEXT);
