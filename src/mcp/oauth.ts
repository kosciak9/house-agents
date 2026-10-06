import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { OAuthClient } from "./config.ts";

type ServerAuth = {
	/** The server these credentials belong to; another URL starts over. */
	url: string;
	client?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
};

export type TokenStore = {
	get: (server: string, url: string) => ServerAuth;
	update: (server: string, url: string, change: Partial<ServerAuth>) => void;
};

const isMissingFile = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ENOENT";

/** Keeps each server's OAuth client and tokens in one private JSON file. */
export const openTokenStore = (file: string): TokenStore => {
	let all: Record<string, ServerAuth> = {};
	try {
		all = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}

	const get = (server: string, url: string): ServerAuth => {
		const auth = all[server];
		return auth?.url === url ? auth : { url };
	};

	return {
		get,
		update: (server, url, change) => {
			all[server] = { ...get(server, url), ...change };
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
		},
	};
};

/**
 * The OAuth client of one server: credentials live in `store`, and sending the
 * user to `authorizationUrl` is left to `onAuthorizationUrl`.
 */
export const createOAuthProvider = ({
	server,
	url,
	client,
	store,
	redirectUrl,
	onAuthorizationUrl,
}: {
	server: string;
	url: URL;
	client: OAuthClient;
	store: TokenStore;
	redirectUrl: URL;
	onAuthorizationUrl: (authorizationUrl: URL) => void;
}): OAuthClientProvider => {
	const key = url.href;

	return {
		get redirectUrl() {
			return redirectUrl;
		},

		get clientMetadata() {
			return {
				client_name: "house-agents",
				redirect_uris: [redirectUrl.href],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: client.clientSecret
					? "client_secret_post"
					: "none",
				scope: client.scope,
			};
		},

		clientInformation: () =>
			client.clientId
				? { client_id: client.clientId, client_secret: client.clientSecret }
				: store.get(server, key).client,

		saveClientInformation: (information) =>
			store.update(server, key, { client: information }),

		tokens: () => store.get(server, key).tokens,

		saveTokens: (tokens) => store.update(server, key, { tokens }),

		// Ties the callback to the flow, and so to this server.
		state: () => randomUUID(),

		redirectToAuthorization: onAuthorizationUrl,

		saveCodeVerifier: (codeVerifier) =>
			store.update(server, key, { codeVerifier }),

		codeVerifier: () => {
			const { codeVerifier } = store.get(server, key);
			if (!codeVerifier) throw new Error(`No OAuth flow started for ${server}`);
			return codeVerifier;
		},
	};
};

export const CALLBACK_PATH = "/mcp-oauth/callback";
export const startPath = (server: string): string =>
	`/mcp-oauth/start/${encodeURIComponent(server)}`;

const page = (text: string): string =>
	`<!doctype html><meta charset="utf-8"><title>MCP</title><p>${text}</p>`;

/**
 * Serves the two pages of an authorization: a short start link per server that
 * redirects to the server's authorization URL, and the callback it returns to.
 */
export const startCallbackServer = ({
	port,
	authorizationUrl,
	finish,
}: {
	port: number;
	authorizationUrl: (server: string) => URL | undefined;
	finish: (state: string, code: string) => Promise<string>;
}): Promise<Server> => {
	const http = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const reply = (status: number, text: string) =>
			response
				.writeHead(status, { "content-type": "text/html; charset=utf-8" })
				.end(page(text));

		if (url.pathname.startsWith("/mcp-oauth/start/")) {
			const server = decodeURIComponent(url.pathname.split("/").pop() ?? "");
			const target = authorizationUrl(server);
			if (!target) {
				reply(404, "Nothing to authorize.");
				return;
			}
			response.writeHead(302, { location: target.href }).end();
			return;
		}

		if (url.pathname === CALLBACK_PATH) {
			const state = url.searchParams.get("state");
			const code = url.searchParams.get("code");
			if (!state || !code) {
				reply(400, "Authorization failed.");
				return;
			}
			try {
				const server = await finish(state, code);
				reply(200, `Authorized ${server}. You can close this page.`);
			} catch (error) {
				console.error("MCP OAuth callback failed:", error);
				reply(400, "Authorization failed.");
			}
			return;
		}

		reply(404, "Not found.");
	});

	return new Promise((resolve) => {
		http.listen(port, () => resolve(http));
	});
};
