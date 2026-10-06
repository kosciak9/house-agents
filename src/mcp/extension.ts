import type { TSchema } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	CallToolResult,
	Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import type { ServerConfig } from "./config.ts";

const CALL_TIMEOUT_MS = 5 * 60_000;

const connect = async (config: ServerConfig): Promise<Client> => {
	const client = new Client({ name: "house-agents", version: "1.0.0" });

	await client.connect(
		config.type === "stdio"
			? new StdioClientTransport({
					command: config.command,
					args: config.args,
					env: config.env,
					cwd: config.cwd,
					stderr: "inherit",
				})
			: new StreamableHTTPClientTransport(config.url, {
					requestInit: { headers: config.headers },
				}),
	);

	return client;
};

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

const defineMcpTool = (server: string, client: Client, tool: McpTool) =>
	defineTool({
		name: toolName(server, tool.name),
		description: tool.description ?? tool.title ?? tool.name,
		// MCP tools describe their input as JSON Schema, which TypeBox validates.
		parameters: tool.inputSchema as TSchema,
		execute: async (args) =>
			toResult(
				(await client.callTool(
					{ name: tool.name, arguments: args as Record<string, unknown> },
					undefined,
					{ timeout: CALL_TIMEOUT_MS },
				)) as CallToolResult,
			),
	});

// Only the allowed tools of a server ever reach the agent.
const serverTools = async (name: string, config: ServerConfig) => {
	const client = await connect(config);
	const { tools } = await client.listTools();

	const allowed = tools.filter((tool) => config.tools.includes(tool.name));
	const missing = config.tools.filter(
		(tool) => !tools.some((offered) => offered.name === tool),
	);
	if (missing.length > 0) {
		console.warn(
			`MCP ${name}: allowed tools not offered: ${missing.join(", ")}`,
		);
	}

	return allowed.map((tool) => defineMcpTool(name, client, tool));
};

/**
 * Connects to every server at startup and offers its allowed tools. A server
 * that cannot be reached is left out, so the agent still runs without it.
 */
export const createMcpExtension = async (
	servers: ReadonlyMap<string, ServerConfig>,
) => {
	const tools = await Promise.all(
		[...servers].map(async ([name, config]) => {
			try {
				return await serverTools(name, config);
			} catch (error) {
				console.error(`MCP ${name}: not connected:`, error);
				return [];
			}
		}),
	);

	return defineExtension({ name: "mcp", tools: tools.flat() });
};
