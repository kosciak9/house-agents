import type { CodemodeTool } from "@earendil-works/pi-codemode";
import {
	type OAuthClientProvider,
	UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	CallToolResult,
	Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import type { HttpServer, Policy, ServerConfig } from "./config.ts";
import { createOAuthProvider, hasTokens, type TokenStore } from "./oauth.ts";

const CALL_TIMEOUT_MS = 5 * 60_000;

/** How `codemode` scripts call `tool` of `server`. */
export const toolName = (server: string, tool: string): string =>
	`${server}__${tool}`;

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

// A script gets the whole result back, so it sees the images a tool returns
// as well as its text and structured result; a failure throws.
const scriptValue = (result: CallToolResult): CallToolResult => {
	if (result.isError) {
		const text = result.content.map(partText).join("\n");
		throw new Error(text || "The tool failed");
	}
	return result;
};

// Declared as MCP's `CallToolResult`, which `renderDeclarations` types with
// the tool's own structured result.
const resultSchema = (structured?: McpTool["outputSchema"]) => ({
	type: "object",
	properties: {
		content: { type: "array", items: { type: "object" } },
		isError: { type: "boolean" },
		_meta: { type: "object" },
		...(structured && { structuredContent: structured }),
	},
	required: ["content"],
});

export const createClient = (): Client =>
	new Client({ name: "house-agents", version: "1.0.0" });

export const httpTransport = (
	config: HttpServer,
	authProvider?: OAuthClientProvider,
) =>
	new StreamableHTTPClientTransport(config.url, {
		requestInit: { headers: config.headers },
		authProvider,
	});

/** The error a call to a server the user has to log in to again throws. */
export const loginNeeded = (server: string): Error =>
	new Error(
		`MCP server "${server}" needs the user to log in again: /mcp_login ${server}`,
	);

/**
 * Connects to `server` with the tokens the user logged in with, if it needs
 * them; `undefined` when it needs the user to log in first.
 */
export const connectServer = async (
	server: string,
	config: ServerConfig,
	tokens: TokenStore,
): Promise<Client | undefined> => {
	if (
		config.type === "http" &&
		config.oauth &&
		!hasTokens(tokens, server, config.url)
	) {
		return undefined;
	}

	const transport =
		config.type === "stdio"
			? new StdioClientTransport({
					command: config.command,
					args: config.args,
					env: config.env,
					cwd: config.cwd,
					stderr: "inherit",
				})
			: httpTransport(
					config,
					config.oauth &&
						createOAuthProvider({
							server,
							url: config.url,
							client: config.oauth,
							store: tokens,
						}),
				);

	const client = createClient();
	try {
		await client.connect(transport);
		return client;
	} catch (error) {
		await client.close();
		// The tokens expired and could not be refreshed.
		if (error instanceof UnauthorizedError) return undefined;
		throw error;
	}
};

/** Every tool `server` offers, whoever may call it; `undefined` as above. */
export const listServerTools = async (
	server: string,
	config: ServerConfig,
	tokens: TokenStore,
): Promise<McpTool[] | undefined> => {
	const client = await connectServer(server, config, tokens);
	if (!client) return undefined;
	try {
		return (await client.listTools()).tools;
	} finally {
		await client.close();
	}
};

/** The tools of `server` in `allowed`, as `codemode` calls them. */
export const allowedTools = async (
	server: string,
	allowed: readonly string[],
	client: Client,
): Promise<CodemodeTool[]> => {
	const { tools } = await client.listTools();

	const missing = allowed.filter(
		(tool) => !tools.some((offered) => offered.name === tool),
	);
	if (missing.length > 0) {
		console.warn(
			`MCP ${server}: allowed tools not offered: ${missing.join(", ")}`,
		);
	}

	return tools
		.filter((tool) => allowed.includes(tool.name))
		.map(
			(tool): CodemodeTool => ({
				name: toolName(server, tool.name),
				description: tool.description ?? tool.title ?? tool.name,
				inputSchema: tool.inputSchema,
				outputSchema: resultSchema(tool.outputSchema),
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
						throw error instanceof UnauthorizedError
							? loginNeeded(server)
							: error;
					}
				},
			}),
		);
};

export type Connection = {
	tools: CodemodeTool[];
	close: () => Promise<void>;
};

/**
 * Connects to every server of `policy` at once, for as long as the caller
 * needs them: `close` ends every connection, and so every stdio server's
 * process. A server the user has not logged in to is left out; one that
 * cannot be reached fails it all.
 */
export const connectServers = async (
	policy: Policy,
	servers: ReadonlyMap<string, ServerConfig>,
	tokens: TokenStore,
): Promise<Connection> => {
	const clients: Client[] = [];
	const close = async () => {
		await Promise.allSettled(clients.map((client) => client.close()));
	};

	try {
		const tools = await Promise.all(
			[...policy].map(async ([server, allowed]) => {
				const config = servers.get(server);
				if (!config) throw new Error(`No MCP server "${server}"`);
				const client = await connectServer(server, config, tokens);
				if (!client) {
					console.warn(`MCP ${server}: left out until the user logs in`);
					return [];
				}
				clients.push(client);
				return allowedTools(server, allowed, client);
			}),
		);
		return { tools: tools.flat(), close };
	} catch (error) {
		await close();
		throw error;
	}
};
