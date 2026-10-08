import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import { createClient, httpTransport } from "./client.ts";
import type { ServerConfig } from "./config.ts";
import { createOAuthProvider, type TokenStore } from "./oauth.ts";

// Logging in to a server through OAuth runs between the user and the chat,
// past the agent. Nothing listens for the way back: the user approves at
// `url` and passes the address the browser ends up on to `finish`.

export type McpLogin = {
	/** Where the user approves. */
	url: URL;
	/** Takes the address the browser ended up on and stores the tokens. */
	finish: (redirect: URL) => Promise<void>;
};

/**
 * Starts logging in to `server`; `undefined` when its tokens still work and
 * there is nothing to log in to.
 */
export const startLogin = async (
	server: string,
	config: ServerConfig,
	tokens: TokenStore,
): Promise<McpLogin | undefined> => {
	if (!config.oauth) {
		throw new Error(`MCP server "${server}" does not log in through OAuth`);
	}

	let url: URL | undefined;
	const transport = httpTransport(
		config,
		createOAuthProvider({
			server,
			url: config.url,
			client: config.oauth,
			store: tokens,
			onAuthorizationUrl: (authorizationUrl) => {
				url = authorizationUrl;
			},
		}),
	);

	const client = createClient();
	try {
		await client.connect(transport);
		await client.close();
		return undefined;
	} catch (error) {
		await client.close();
		if (!(error instanceof UnauthorizedError) || !url) throw error;
	}

	const state = url.searchParams.get("state");
	return {
		url,
		finish: async (redirect) => {
			const refused = redirect.searchParams.get("error");
			if (refused) throw new Error(`The server refused the login: ${refused}`);

			const code = redirect.searchParams.get("code");
			if (!code || redirect.searchParams.get("state") !== state) {
				throw new Error("This address belongs to another login");
			}
			await transport.finishAuth(code);
		},
	};
};
