import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

import { credentials } from "./credentials.ts";

export const models = createModels({ credentials });
models.setProvider(openaiCodexProvider());
