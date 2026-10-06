import { type TSchema, Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Registry,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	CallToolResult,
	Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import type { ServerConfig } from "./config.ts";
import { createOAuthProvider, openTokenStore } from "./oauth.ts";

const AUTHORIZE_TOOL = "mcp_authorize";

const CALL_TIMEOUT_MS = 5 * 60_000;

// Model tool names allow only these characters, up to 64 of them.
const toolName = (server: string, tool: string): string =>
	`${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

type Content = NonNullable<ToolExecutionResult["content"]>[number];

const toContent = (part: CallToolResult["content"][number]): Content => {
	switch (part.type) {
		case "text":
			return { type: "text", text: part.text };
		case "image":
			return { type: "image", data: part.data, mimeType: part.mimeType };
		case "resource":
			return "text" in part.resource
				? { type: "text", text: part.resource.text }
				: { type: "text", text: `[binary resource ${part.resource.uri}]` };
		case "resource_link":
			return { type: "text", text: `${part.name}: ${part.uri}` };
		default:
			return { type: "text", text: `[${part.type} content omitted]` };
	}
};

const toResult = (result: CallToolResult): ToolExecutionResult => {
	const content =
		result.content.length > 0
			? result.content.map(toContent)
			: [
					{
						type: "text" as const,
						text: JSON.stringify(result.structuredContent ?? {}),
					},
				];

	return { content, isError: result.isError === true };
};

const errorResult = (text: string): ToolExecutionResult => ({
	content: [{ type: "text", text }],
	isError: true,
});

/**
 * Connects to every server and offers each one's allowed tools as the
 * extension `mcp:<server>`. A server that cannot be reached is left out, so the
 * agent still runs without it.
 *
 * A server that needs OAuth asks the user, through `notify`, to open its
 * authorization link. Nothing listens for the way back: the user pastes the
 * address the browser ends up on into the chat, the agent hands it to
 * `mcp_authorize`, and the server's tools arrive.
 */
export const startMcp = async ({
	registry,
	servers,
	oauthFile,
	notify,
}: {
	registry: Registry;
	servers: ReadonlyMap<string, ServerConfig>;
	oauthFile: string;
	notify: (text: string) => Promise<void>;
}): Promise<void> => {
	const store = openTokenStore(oauthFile);
	// Of servers whose authorization was started: where the user authorizes,
	// which server each flow's `state` belongs to, and the transport to finish.
	const authorizationUrls = new Map<string, URL>();
	const states = new Map<string, string>();
	const transports = new Map<string, StreamableHTTPClientTransport>();

	const authorizationMessage = (name: string): string =>
		`MCP server "${name}" needs the user's authorization before its tools ` +
		"work. Send the user this link, exactly as it is: " +
		`${authorizationUrls.get(name)?.href} . After approving, the browser ` +
		"opens a page that does not load; ask the user to paste that page's full " +
		`address into the chat, then pass it to ${AUTHORIZE_TOOL}.`;

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

	const defineMcpTool = (name: string, client: Client, tool: McpTool) =>
		defineTool({
			name: toolName(name, tool.name),
			description: tool.description ?? tool.title ?? tool.name,
			// MCP tools describe their input as JSON Schema, which TypeBox validates.
			parameters: tool.inputSchema as TSchema,
			execute: async (args) => {
				try {
					return toResult(
						(await client.callTool(
							{ name: tool.name, arguments: args as Record<string, unknown> },
							undefined,
							{ timeout: CALL_TIMEOUT_MS },
						)) as CallToolResult,
					);
				} catch (error) {
					// The tokens expired and could not be refreshed.
					if (
						error instanceof UnauthorizedError &&
						authorizationUrls.has(name)
					) {
						return errorResult(authorizationMessage(name));
					}
					throw error;
				}
			},
		});

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
			.map((tool) => defineMcpTool(name, client, tool));
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
				await notify(authorizationMessage(name));
				return;
			}
			throw error;
		}

		registry.install(
			defineExtension({
				name: `mcp:${name}`,
				tools: await allowedTools(name, config, client),
			}),
		);
	};

	// Finishes the flow the pasted redirect address belongs to.
	const finishAuthorization = async (redirect: URL): Promise<string> => {
		const error = redirect.searchParams.get("error");
		if (error) throw new Error(`The server refused authorization: ${error}`);

		const name = states.get(redirect.searchParams.get("state") ?? "");
		const code = redirect.searchParams.get("code");
		const transport = name && transports.get(name);
		const config = name && servers.get(name);
		if (!name || !code || !transport || !config) {
			throw new Error(
				"This address belongs to no pending authorization; " +
					"the user has to start again from the latest link.",
			);
		}

		await transport.finishAuth(code);
		states.delete(redirect.searchParams.get("state") ?? "");
		authorizationUrls.delete(name);
		await connectServer(name, config);
		return name;
	};

	const authorizeTool = defineTool({
		name: AUTHORIZE_TOOL,
		description:
			"Finish authorizing an MCP server with the address the user's browser " +
			"ended up on after approving it.",
		parameters: Type.Object({
			redirect_url: Type.String({
				description: "The full address the user pasted, unchanged.",
			}),
		}),
		execute: async (args) => {
			const name = await finishAuthorization(new URL(args.redirect_url));
			return {
				content: [
					{ type: "text", text: `Authorized "${name}"; its tools are ready.` },
				],
			};
		},
	});

	const usesOAuth = [...servers.values()].some(
		(config) => config.type === "http" && config.oauth,
	);
	if (usesOAuth) {
		registry.install(defineExtension({ name: "mcp", tools: [authorizeTool] }));
	}

	await Promise.all(
		[...servers].map(async ([name, config]) => {
			try {
				await connectServer(name, config);
			} catch (error) {
				console.error(`MCP ${name}: not connected:`, error);
			}
		}),
	);
};
