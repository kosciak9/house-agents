import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	onAuthorizationUrl,
}: {
	server: string;
	url: URL;
	client: OAuthClient;
	store: TokenStore;
	onAuthorizationUrl: (authorizationUrl: URL) => void;
}): OAuthClientProvider => {
	const key = url.href;
	const { redirectUrl } = client;

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

		// Ties the pasted redirect to its flow, and so to this server.
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
