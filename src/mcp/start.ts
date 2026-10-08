import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { defineExtension, type Registry } from "@earendil-works/pi-durable";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { allowedTools, connectServer } from "./client.ts";
import { createCodemodeTool } from "./codemode.ts";
import type { Policy, ServerConfig } from "./config.ts";
import type { TokenStore } from "./oauth.ts";

export type ServerStatus = "connected" | "login" | "error";

export type Mcp = {
	/** Connects to `server` again, e.g. once the user has logged in to it. */
	reconnect: (server: string) => Promise<void>;
	/** How the agent's connection to `server` stands; `undefined` if it has none. */
	status: (server: string) => ServerStatus | undefined;
	/** Local and MCP names the agent's `codemode` scripts call its tools by. */
	tools: () => string[];
};

/**
 * Connects to every server of the agent's `policy` and offers the tools it
 * allows alongside local tools in the agent's `codemode` (extension `mcp`). A server the user
 * has not logged in to, or one that cannot be reached, is left out, so the
 * agent still runs without it.
 */
export const startMcp = async ({
	registry,
	servers,
	policy,
	tokens,
	localTools = [],
}: {
	registry: Registry;
	servers: ReadonlyMap<string, ServerConfig>;
	policy: Policy;
	tokens: TokenStore;
	localTools?: readonly CodemodeTool[];
}): Promise<Mcp> => {
	const statuses = new Map<string, ServerStatus>();
	const clients = new Map<string, Client>();
	// The allowed tools of each connected server; the codemode tool is
	// installed anew whenever they change.
	const serverTools = new Map<string, CodemodeTool[]>();

	const installCodemode = () => {
		const tools = [...localTools, ...[...serverTools.values()].flat()];
		if (tools.length === 0) {
			registry.uninstall({ name: "mcp" });
			return;
		}
		registry.install(
			defineExtension({ name: "mcp", tools: [createCodemodeTool(tools)] }),
		);
	};

	const connect = async (server: string): Promise<void> => {
		const config = servers.get(server);
		const allowed = policy.get(server);
		if (!config || !allowed) return;

		await clients.get(server)?.close();
		clients.delete(server);
		serverTools.delete(server);

		try {
			const client = await connectServer(server, config, tokens);
			if (!client) {
				statuses.set(server, "login");
				return;
			}
			clients.set(server, client);
			serverTools.set(server, await allowedTools(server, allowed, client));
			statuses.set(server, "connected");
		} catch (error) {
			statuses.set(server, "error");
			console.error(`MCP ${server}: not connected:`, error);
		} finally {
			installCodemode();
		}
	};

	installCodemode();
	await Promise.all([...policy.keys()].map(connect));

	return {
		reconnect: connect,
		status: (server) => statuses.get(server),
		tools: () =>
			[...localTools, ...[...serverTools.values()].flat()].map(
				(tool) => tool.name,
			),
	};
};
