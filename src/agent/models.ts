import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

import { credentials } from "./credentials.ts";

// The subscriptions the agent can run on; the user logs in to each from the
// chat (`/login`).
export const models = createModels({ credentials });
models.setProvider(openaiCodexProvider());
models.setProvider(opencodeGoProvider());
models.setProvider(xaiProvider());
