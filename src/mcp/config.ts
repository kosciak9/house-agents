import { config, stateFile } from "../config.ts";
import { openTokenStore } from "./oauth.ts";

// The MCP servers come from the deployment's `mcpServers`:
// `{ "<name>": <server>, ... }`, all remote, and what each agent may use of
// them from its policy: `{ "<server>": ["<tool>", ...], ... }`. Every other
// server and tool stays hidden from that agent. The config is checked here
// again, since nothing type-checks it before it runs.

export type OAuthClient = {
	/** Without one, the client registers itself with the server. */
	clientId: string | undefined;
	clientSecret: string | undefined;
	scope: string | undefined;
	/** Where the server sends the user back with the authorization code. */
	redirectUrl: URL;
};

export type ServerConfig = {
	/** Its Streamable HTTP endpoint. */
	url: URL;
	/** Sent with every request, e.g. `Authorization: Bearer <key>`. */
	headers: Record<string, string>;
	/** Set when the server authorizes the user through OAuth. */
	oauth: OAuthClient | undefined;
};

/** The tools an agent may call, by server. */
export type Policy = ReadonlyMap<string, readonly string[]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown, field: string): string[] => {
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
		throw new Error(`${field} must be an array of strings`);
	}
	return value;
};

const stringRecord = (
	value: unknown,
	field: string,
): Record<string, string> => {
	if (
		!isRecord(value) ||
		!Object.values(value).every((v) => typeof v === "string")
	) {
		throw new Error(`${field} must be an object of strings`);
	}
	return value as Record<string, string>;
};

const optionalString = (value: unknown, field: string): string | undefined => {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
};

// Nothing listens there: the user's browser fails to open it and the user
// pastes its address into the chat instead.
const DEFAULT_REDIRECT_URL = "http://localhost/mcp-oauth/callback";

// `"oauth": true` registers the client dynamically; an object may name a
// pre-registered client, its redirect URL and the scope to ask for.
const parseOAuth = (value: unknown, field: string): OAuthClient | undefined => {
	if (value === undefined || value === false) return undefined;
	if (value === true) {
		return {
			clientId: undefined,
			clientSecret: undefined,
			scope: undefined,
			redirectUrl: new URL(DEFAULT_REDIRECT_URL),
		};
	}
	if (!isRecord(value)) throw new Error(`${field} must be true or an object`);
	return {
		clientId: optionalString(value.clientId, `${field}.clientId`),
		clientSecret: optionalString(value.clientSecret, `${field}.clientSecret`),
		scope: optionalString(value.scope, `${field}.scope`),
		redirectUrl: new URL(
			optionalString(value.redirectUrl, `${field}.redirectUrl`) ??
				DEFAULT_REDIRECT_URL,
		),
	};
};

const parseServer = (field: string, value: unknown): ServerConfig => {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);

	if (typeof value.url !== "string" || !URL.canParse(value.url)) {
		throw new Error(`${field}.url must be the server's URL`);
	}

	return {
		url: new URL(value.url),
		headers:
			value.headers === undefined
				? {}
				: stringRecord(value.headers, `${field}.headers`),
		oauth: parseOAuth(value.oauth, `${field}.oauth`),
	};
};

const parseServers = (value: unknown): Map<string, ServerConfig> => {
	if (value === undefined) return new Map();
	if (!isRecord(value)) throw new Error("config.mcpServers must be an object");

	return new Map(
		Object.entries(value).map(([name, server]) => [
			name,
			parseServer(`config.mcpServers.${name}`, server),
		]),
	);
};

export const servers: ReadonlyMap<string, ServerConfig> = parseServers(
	config().mcpServers,
);

/** The policy at `field` of the config, over the servers it names. */
export const parsePolicy = (value: unknown, field: string): Policy => {
	if (value === undefined) return new Map();
	if (!isRecord(value)) throw new Error(`${field} must be an object`);

	return new Map(
		Object.entries(value).map(([server, tools]) => {
			if (!servers.has(server)) {
				throw new Error(`${field}.${server}: no such server in mcpServers`);
			}
			return [server, stringArray(tools, `${field}.${server}`)];
		}),
	);
};

/** What the agent itself may use. */
export const agentPolicy = parsePolicy(config().mcp, "config.mcp");

/** OAuth clients and tokens of the servers, shared by every connection. */
export const tokens = openTokenStore(stateFile("mcp-oauth.json"));
