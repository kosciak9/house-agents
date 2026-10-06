// A tiny MCP server the E2E bot connects to, over stdio (`stdio`) or
// Streamable HTTP (`http`, prints `listening on <port>`). `get_word` returns
// WORD; `record_visit` appends to VISIT_FILE, so a test can tell it was called.
// Over HTTP it answers only requests with `Authorization: Bearer <API_KEY>`,
// or, with OAUTH=1, with a token it issued as its own OAuth authorization
// server, which approves every authorization at once.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
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

const sendJson = (response: ServerResponse, status: number, body: unknown) =>
	response
		.writeHead(status, { "content-type": "application/json" })
		.end(JSON.stringify(body));

const readBody = async (request: IncomingMessage): Promise<string> => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString();
};

const s256 = (verifier: string): string =>
	createHash("sha256").update(verifier).digest("base64url");

// Just enough of an OAuth authorization server for the MCP client: metadata,
// dynamic client registration, instant approval and PKCE code exchange.
// `handle` returns whether the request was one of its own.
const createAuthorizationServer = (base: () => string) => {
	const challenges = new Map<string, string>(); // code → PKCE challenge
	const tokens = new Set<string>();

	const handle = async (
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
	): Promise<boolean> => {
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			sendJson(response, 200, {
				resource: `${base()}/mcp`,
				authorization_servers: [base()],
			});
		} else if (url.pathname === "/.well-known/oauth-authorization-server") {
			sendJson(response, 200, {
				issuer: base(),
				authorization_endpoint: `${base()}/authorize`,
				token_endpoint: `${base()}/token`,
				registration_endpoint: `${base()}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		} else if (url.pathname === "/register") {
			const metadata = JSON.parse(await readBody(request));
			sendJson(response, 201, {
				...metadata,
				client_id: randomUUID(),
				client_id_issued_at: Math.floor(Date.now() / 1000),
			});
		} else if (url.pathname === "/authorize") {
			const code = randomUUID();
			challenges.set(code, url.searchParams.get("code_challenge") ?? "");
			const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", code);
			redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
			response.writeHead(302, { location: redirect.href }).end();
		} else if (url.pathname === "/token") {
			const form = new URLSearchParams(await readBody(request));
			const code = form.get("code") ?? "";
			const challenge = challenges.get(code);
			challenges.delete(code);
			if (!challenge || s256(form.get("code_verifier") ?? "") !== challenge) {
				sendJson(response, 400, { error: "invalid_grant" });
				return true;
			}
			const token = randomUUID();
			tokens.add(token);
			sendJson(response, 200, {
				access_token: token,
				token_type: "Bearer",
				expires_in: 3600,
			});
		} else {
			return false;
		}
		return true;
	};

	return { handle, isValid: (token: string) => tokens.has(token) };
};

const serveHttp = ({
	apiKey,
	oauth,
}: {
	apiKey: string | undefined;
	oauth: boolean;
}): void => {
	let base = "";
	const authorization = createAuthorizationServer(() => base);

	const isAuthorized = (header: string | undefined): boolean => {
		const token = header?.replace(/^Bearer /, "") ?? "";
		if (apiKey !== undefined && token !== apiKey) return false;
		return !oauth || authorization.isValid(token);
	};

	const http = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", base);
		if (oauth && (await authorization.handle(request, response, url))) return;

		if (!isAuthorized(request.headers.authorization)) {
			response
				.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
				})
				.end();
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
		base = `http://127.0.0.1:${port}`;
		console.log(`listening on ${port}`);
	});
};

const mode = process.argv[2];
if (mode === "stdio") {
	await createMcpServer().connect(new StdioServerTransport());
} else if (mode === "http") {
	serveHttp({
		apiKey: process.env.API_KEY,
		oauth: process.env.OAUTH === "1",
	});
} else {
	throw new Error('Usage: server.ts "stdio" | "http"');
}
