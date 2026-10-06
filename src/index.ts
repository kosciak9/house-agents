import { harness } from "./agent/harness.ts";
import { registry } from "./agent/registry.ts";
import { oauthFile, servers } from "./mcp/config.ts";
import { startMcp } from "./mcp/start.ts";
import { sendAuthorizationLink } from "./telegram/mcp-auth.ts";
import { forwardToTelegram, startTelegram } from "./telegram/start.ts";

await forwardToTelegram();
// Resume only once forwarding is attached, so answers of runs interrupted by
// the last shutdown still reach the chat.
harness.resume();

// Tools are in place before the first message is taken.
const mcp = await startMcp({
	registry,
	servers,
	oauthFile,
	onAuthorizationNeeded: sendAuthorizationLink,
});

await startTelegram({ mcp });
