import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { defineExtension, type Registry } from "@earendil-works/pi-durable";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	CallToolResult,
	Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import { createCodemodeTool } from "./codemode.ts";
import type { ServerConfig } from "./config.ts";
import { createOAuthProvider, openTokenStore } from "./oauth.ts";

const CALL_TIMEOUT_MS = 5 * 60_000;

const toolName = (server: string, tool: string): string => `${server}__${tool}`;

const partText = (part: CallToolResult["content"][number]): string => {
	switch (part.type) {
		case "text":
			return part.text;
		case "resource":
			return "text" in part.resource
				? part.resource.text
				: `[binary resource ${part.resource.uri}]`;
		case "resource_link":
			return `${part.name}: ${part.uri}`;
		default:
			return `[${part.type} content omitted]`;
	}
};

// What a script gets back: the structured result when the tool declares one,
// its text otherwise.
const scriptValue = (result: CallToolResult): unknown => {
	const text = result.content.map(partText).join("\n");
	if (result.isError) throw new Error(text || "The tool failed");
	return result.structuredContent ?? text;
};

export type Mcp = {
	/**
	 * Finishes the authorization the address the browser ended up on belongs
	 * to; resolves with the server's name.
	 */
	finishAuthorization: (redirect: URL) => Promise<string>;
	/** Servers waiting for the user to authorize them, with their links. */
	pendingAuthorizations: () => { server: string; url: URL }[];
};

/**
 * Connects to every server and offers their allowed tools to the agent's
 * `codemode` tool (extension `mcp`). A server that cannot be reached is left
 * out, so the agent still runs without it.
 *
 * A server that needs OAuth hands its authorization link to
 * `onAuthorizationNeeded`, past the agent. Nothing listens for the way back:
 * whoever shows the link takes the address the browser ends up on and passes
 * it to `finishAuthorization`, and the server's tools arrive.
 */
export const startMcp = async ({
	registry,
	servers,
	oauthFile,
	onAuthorizationNeeded,
}: {
	registry: Registry;
	servers: ReadonlyMap<string, ServerConfig>;
	oauthFile: string;
	onAuthorizationNeeded: (server: string, url: URL) => Promise<void>;
}): Promise<Mcp> => {
	const store = openTokenStore(oauthFile);
	// Of servers whose authorization was started: where the user authorizes,
	// which server each flow's `state` belongs to, and the transport to finish.
	const authorizationUrls = new Map<string, URL>();
	const states = new Map<string, string>();
	const transports = new Map<string, StreamableHTTPClientTransport>();

	const askForAuthorization = async (name: string): Promise<void> => {
		const url = authorizationUrls.get(name);
		if (url) await onAuthorizationNeeded(name, url);
	};

	const createTransport = (name: string, config: ServerConfig) => {
		if (config.type === "stdio") {
			return new StdioClientTransport({
				command: config.command,
				args: config.args,
				env: config.env,
				cwd: config.cwd,
				stderr: "inherit",
			});
		}

		const authProvider = config.oauth
			? createOAuthProvider({
					server: name,
					url: config.url,
					client: config.oauth,
					store,
					onAuthorizationUrl: (url) => {
						authorizationUrls.set(name, url);
						const state = url.searchParams.get("state");
						if (state) states.set(state, name);
					},
				})
			: undefined;

		const transport = new StreamableHTTPClientTransport(config.url, {
			requestInit: { headers: config.headers },
			authProvider,
		});
		if (authProvider) transports.set(name, transport);
		return transport;
	};

	const sandboxTool = (
		name: string,
		client: Client,
		tool: McpTool,
	): CodemodeTool => ({
		name: toolName(name, tool.name),
		description: tool.description ?? tool.title ?? tool.name,
		inputSchema: tool.inputSchema,
		outputSchema: tool.outputSchema ?? { type: "string" },
		execute: async (args, { signal }) => {
			try {
				return scriptValue(
					(await client.callTool(
						{ name: tool.name, arguments: args as Record<string, unknown> },
						undefined,
						{ timeout: CALL_TIMEOUT_MS, signal },
					)) as CallToolResult,
				);
			} catch (error) {
				// The tokens expired and could not be refreshed.
				if (error instanceof UnauthorizedError && authorizationUrls.has(name)) {
					await askForAuthorization(name);
					throw new Error(
						`MCP server "${name}" needs the user's authorization again; ` +
							"the user has been sent the link.",
					);
				}
				throw error;
			}
		},
	});

	// The allowed tools of each connected server; the codemode tool is
	// installed anew whenever they change.
	const serverTools = new Map<string, CodemodeTool[]>();
	const installCodemode = () => {
		const tools = [...serverTools.values()].flat();
		if (tools.length === 0) return;
		registry.install(
			defineExtension({ name: "mcp", tools: [createCodemodeTool(tools)] }),
		);
	};

	// Only the allowed tools of a server ever reach the agent.
	const allowedTools = async (
		name: string,
		config: ServerConfig,
		client: Client,
	) => {
		const { tools } = await client.listTools();

		const missing = config.tools.filter(
			(tool) => !tools.some((offered) => offered.name === tool),
		);
		if (missing.length > 0) {
			console.warn(
				`MCP ${name}: allowed tools not offered: ${missing.join(", ")}`,
			);
		}

		return tools
			.filter((tool) => config.tools.includes(tool.name))
			.map((tool) => sandboxTool(name, client, tool));
	};

	const connectServer = async (
		name: string,
		config: ServerConfig,
	): Promise<void> => {
		const client = new Client({ name: "house-agents", version: "1.0.0" });
		try {
			await client.connect(createTransport(name, config));
		} catch (error) {
			if (error instanceof UnauthorizedError && authorizationUrls.has(name)) {
				await askForAuthorization(name);
				return;
			}
			throw error;
		}

		serverTools.set(name, await allowedTools(name, config, client));
		installCodemode();
	};

	const finishAuthorization = async (redirect: URL): Promise<string> => {
		const error = redirect.searchParams.get("error");
		if (error) throw new Error(`The server refused authorization: ${error}`);

		const name = states.get(redirect.searchParams.get("state") ?? "");
		const code = redirect.searchParams.get("code");
		const transport = name && transports.get(name);
		const config = name && servers.get(name);
		if (!name || !code || !transport || !config) {
			throw new Error("No pending authorization matches this address");
		}

		await transport.finishAuth(code);
		states.delete(redirect.searchParams.get("state") ?? "");
		authorizationUrls.delete(name);
		await connectServer(name, config);
		return name;
	};

	await Promise.all(
		[...servers].map(async ([name, config]) => {
			try {
				await connectServer(name, config);
			} catch (error) {
				console.error(`MCP ${name}: not connected:`, error);
			}
		}),
	);

	return {
		finishAuthorization,
		pendingAuthorizations: () =>
			[...authorizationUrls].map(([server, url]) => ({ server, url })),
	};
};
