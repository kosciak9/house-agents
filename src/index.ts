import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { harness, root } from "./agent/harness.ts";
import { registry } from "./agent/registry.ts";
import { oauthFile, servers } from "./mcp/config.ts";
import { startMcp } from "./mcp/start.ts";
import { forwardToTelegram, startTelegram } from "./telegram/start.ts";

await forwardToTelegram();
// Resume only once forwarding is attached, so answers of runs interrupted by
// the last shutdown still reach the chat.
harness.resume();

// Tools are in place before the first message is taken.
await startMcp({
	registry,
	servers,
	oauthFile,
	notify: async (text) => {
		await root.submit(
			{ type: "input", content: text, whenBusy: "followUp" },
			BACKGROUND_CONTEXT,
		);
	},
});

await startTelegram();
