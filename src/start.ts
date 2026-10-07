import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { harness, root } from "./agent/harness.ts";
import { compactionLimits, memory } from "./agent/memory.ts";
import { registry } from "./agent/registry.ts";
import { agentPolicy, servers, tokens } from "./mcp/config.ts";
import { startMcp } from "./mcp/start.ts";
import { compactWhenDue } from "./memory/keeper.ts";
import { forwardToTelegram, startTelegram } from "./telegram/start.ts";

await forwardToTelegram();
// Resume only once forwarding is attached, so answers of runs interrupted by
// the last shutdown still reach the chat.
harness.resume();

await compactWhenDue({
	harness,
	conversation: root,
	limits: compactionLimits,
	compact: (conversation) => memory.compact(conversation, BACKGROUND_CONTEXT),
});

// Tools are in place before the first message is taken.
const mcp = await startMcp({
	registry,
	servers,
	policy: agentPolicy,
	tokens,
});

await startTelegram({ mcp });
