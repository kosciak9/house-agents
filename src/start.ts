import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { harness, root } from "./agent/harness.ts";
import { compactionLimits, memory } from "./agent/memory.ts";
import { registry } from "./agent/registry.ts";
import { fileTools } from "./files/tools.ts";
import { agentPolicy, servers, tokens } from "./mcp/config.ts";
import { startMcp } from "./mcp/start.ts";
import { compactWhenDue } from "./memory/keeper.ts";
import { presentationTools } from "./presentations/tools.ts";
import { spreadsheetTools } from "./spreadsheets/tools.ts";
import { refreshGeneralSubagents } from "./subagents/resume.ts";
import { forwardToTelegram, startTelegram } from "./telegram/start.ts";
import { telegramTools } from "./telegram/tools.ts";
import { wordTools } from "./word/tools.ts";

await forwardToTelegram();
// Resumed runs need the same catalogue as new inputs, even without MCP servers.
const mcp = await startMcp({
	registry,
	servers,
	policy: agentPolicy,
	tokens,
	localTools: [
		...fileTools,
		...spreadsheetTools,
		...wordTools,
		...presentationTools,
		...telegramTools,
	],
});
await refreshGeneralSubagents({ harness, registry }, BACKGROUND_CONTEXT);
// Resume only once forwarding is attached, so answers of runs interrupted by
// the last shutdown still reach the chat.
harness.resume();

await compactWhenDue({
	harness,
	conversation: root,
	limits: compactionLimits,
	compact: (conversation) => memory.compact(conversation, BACKGROUND_CONTEXT),
});

await startTelegram({ mcp });
