import type { CodemodeTool } from "@earendil-works/pi-codemode";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	CallToolResult,
	Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import type { HttpServer, ServerConfig } from "./config.ts";

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

export const httpTransport = (
	config: HttpServer,
	authProvider?: OAuthClientProvider,
) =>
	new StreamableHTTPClientTransport(config.url, {
		requestInit: { headers: config.headers },
		authProvider,
	});

export const createTransport = (config: ServerConfig) =>
	config.type === "stdio"
		? new StdioClientTransport({
				command: config.command,
				args: config.args,
				env: config.env,
				cwd: config.cwd,
				stderr: "inherit",
			})
		: httpTransport(config);

export const createClient = (): Client =>
	new Client({ name: "house-agents", version: "1.0.0" });

/**
 * The tools of `server` the config allows, as `codemode` calls them;
 * `failure` gives the error a failed call throws.
 */
export const allowedTools = async (
	server: string,
	config: ServerConfig,
	client: Client,
	failure: (error: unknown) => Promise<unknown> = async (error) => error,
): Promise<CodemodeTool[]> => {
	const { tools } = await client.listTools();

	const missing = config.tools.filter(
		(tool) => !tools.some((offered) => offered.name === tool),
	);
	if (missing.length > 0) {
		console.warn(
			`MCP ${server}: allowed tools not offered: ${missing.join(", ")}`,
		);
	}

	return tools
		.filter((tool) => config.tools.includes(tool.name))
		.map(
			(tool: McpTool): CodemodeTool => ({
				name: toolName(server, tool.name),
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
						throw await failure(error);
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
 * Connects to every server at once, for as long as the caller needs them:
 * `close` ends every connection, and so every stdio server's process. A server
 * that cannot be reached fails it all.
 */
export const connectServers = async (
	servers: ReadonlyMap<string, ServerConfig>,
): Promise<Connection> => {
	const clients: Client[] = [];
	const close = async () => {
		await Promise.allSettled(clients.map((client) => client.close()));
	};

	try {
		const tools = await Promise.all(
			[...servers].map(async ([name, config]) => {
				const client = createClient();
				clients.push(client);
				await client.connect(createTransport(config));
				return allowedTools(name, config, client);
			}),
		);
		return { tools: tools.flat(), close };
	} catch (error) {
		await close();
		throw error;
	}
};
