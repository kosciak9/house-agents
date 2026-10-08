import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import {
	allowedTools,
	type Connection,
	createClient,
	toolName,
} from "../mcp/client.ts";

// Lightpanda, the headless browser in the image, as tools of a subagent that
// has `lightpanda: true`: each one starts its own browser, so a fresh page
// and cookie jar, and closes it once it answers. It drives the browser
// through Lightpanda's own MCP mode, but the deployment configures no server
// for it. Only reading: search, open a page, read it as markdown, list its
// links.

const SERVER = "lightpanda";
const TOOLS = ["search", "goto", "markdown", "links"];

/** Its tools, as `codemode` scripts call them. */
export const LIGHTPANDA_TOOLS = TOOLS.map((tool) => toolName(SERVER, tool));

/** A browser of its own for one subagent; `close` ends it. */
export const connectLightpanda = async (): Promise<Connection> => {
	const client = createClient();
	try {
		await client.connect(
			new StdioClientTransport({
				command: "lightpanda",
				// Nothing on the host's networks or the tailnet (CGNAT range).
				args: [
					"mcp",
					"--block-private-networks",
					"--block-cidrs",
					"100.64.0.0/10",
				],
				env: {
					...getDefaultEnvironment(),
					LIGHTPANDA_DISABLE_TELEMETRY: "true",
				},
				stderr: "inherit",
			}),
		);
		return {
			tools: await allowedTools(SERVER, TOOLS, client),
			close: () => client.close(),
		};
	} catch (error) {
		await client.close();
		throw error;
	}
};
