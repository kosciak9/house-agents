import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { defineExtension, type Registry } from "@earendil-works/pi-durable";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
	allowedTools,
	createClient,
	createTransport,
	httpTransport,
} from "./client.ts";
import { createCodemodeTool } from "./codemode.ts";
import type { ServerConfig } from "./config.ts";
import { createOAuthProvider, openTokenStore } from "./oauth.ts";

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

	const serverTransport = (name: string, config: ServerConfig) => {
		if (config.type === "stdio" || !config.oauth) {
			return createTransport(config);
		}

		const transport = httpTransport(
			config,
			createOAuthProvider({
				server: name,
				url: config.url,
				client: config.oauth,
				store,
				onAuthorizationUrl: (url) => {
					authorizationUrls.set(name, url);
					const state = url.searchParams.get("state");
					if (state) states.set(state, name);
				},
			}),
		);
		transports.set(name, transport);
		return transport;
	};

	// A call whose tokens expired and could not be refreshed asks the user
	// again.
	const callFailure = (name: string) => async (error: unknown) => {
		if (!(error instanceof UnauthorizedError && authorizationUrls.has(name))) {
			return error;
		}
		await askForAuthorization(name);
		return new Error(
			`MCP server "${name}" needs the user's authorization again; ` +
				"the user has been sent the link.",
		);
	};

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

	const connectServer = async (
		name: string,
		config: ServerConfig,
	): Promise<void> => {
		const client = createClient();
		try {
			await client.connect(serverTransport(name, config));
		} catch (error) {
			if (error instanceof UnauthorizedError && authorizationUrls.has(name)) {
				await askForAuthorization(name);
				return;
			}
			throw error;
		}

		serverTools.set(
			name,
			await allowedTools(name, config, client, callFailure(name)),
		);
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
