// A tiny MCP server the E2E bot connects to, over stdio (`stdio`) or
// Streamable HTTP (`http`, prints `listening on <port>`). `get_word` returns
// WORD; `record_visit` appends to VISIT_FILE, so a test can tell it was called.
// Over HTTP it answers only requests with `Authorization: Bearer <API_KEY>`.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const requireEnv = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const word = requireEnv("WORD");
const visitFile = requireEnv("VISIT_FILE");

const createMcpServer = (): Server => {
	const server = new Server(
		{ name: "e2e-test-server", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: "get_word",
				description: "Returns the word of the day.",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "record_visit",
				description: "Records a visit under the given name.",
				inputSchema: {
					type: "object",
					properties: { name: { type: "string" } },
					required: ["name"],
				},
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (request.params.name === "get_word") {
			return { content: [{ type: "text", text: word }] };
		}
		if (request.params.name === "record_visit") {
			appendFileSync(visitFile, `${String(request.params.arguments?.name)}\n`);
			return { content: [{ type: "text", text: "Visit recorded." }] };
		}
		return {
			content: [{ type: "text", text: "Unknown tool" }],
			isError: true,
		};
	});

	return server;
};

const serveHttp = (apiKey: string): void => {
	const http = createServer(async (request, response) => {
		if (request.headers.authorization !== `Bearer ${apiKey}`) {
			response.writeHead(401).end();
			return;
		}
		// Stateless: every request gets its own server and transport.
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});
		await createMcpServer().connect(transport);
		await transport.handleRequest(request, response);
	});

	http.listen(0, "127.0.0.1", () => {
		const { port } = http.address() as AddressInfo;
		console.log(`listening on ${port}`);
	});
};

const mode = process.argv[2];
if (mode === "stdio") {
	await createMcpServer().connect(new StdioServerTransport());
} else if (mode === "http") {
	serveHttp(requireEnv("API_KEY"));
} else {
	throw new Error('Usage: server.ts "stdio" | "http"');
}
