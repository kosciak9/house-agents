// The MCP servers the agent may use come from its deployment as JSON in
// MCP_SERVERS: `{ "<name>": <server>, ... }`. Each server lists the `tools` the
// agent may call; every other tool of that server stays hidden.

export type StdioServer = {
	type: "stdio";
	command: string;
	args: string[];
	env: Record<string, string> | undefined;
	cwd: string | undefined;
	tools: string[];
};

export type OAuthClient = {
	/** Without one, the client registers itself with the server. */
	clientId: string | undefined;
	clientSecret: string | undefined;
	scope: string | undefined;
	/** Where the server sends the user back with the authorization code. */
	redirectUrl: URL;
};

export type HttpServer = {
	type: "http";
	url: URL;
	/** Sent with every request, e.g. `Authorization: Bearer <key>`. */
	headers: Record<string, string>;
	/** Set when the server authorizes the user through OAuth. */
	oauth: OAuthClient | undefined;
	tools: string[];
};

export type ServerConfig = StdioServer | HttpServer;

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

const parseServer = (name: string, value: unknown): ServerConfig => {
	const field = `MCP_SERVERS.${name}`;
	if (!isRecord(value)) throw new Error(`${field} must be an object`);

	const tools = stringArray(value.tools, `${field}.tools`);

	if (typeof value.url === "string") {
		return {
			type: "http",
			url: new URL(value.url),
			headers:
				value.headers === undefined
					? {}
					: stringRecord(value.headers, `${field}.headers`),
			oauth: parseOAuth(value.oauth, `${field}.oauth`),
			tools,
		};
	}

	if (typeof value.command === "string") {
		return {
			type: "stdio",
			command: value.command,
			args:
				value.args === undefined
					? []
					: stringArray(value.args, `${field}.args`),
			env:
				value.env === undefined
					? undefined
					: stringRecord(value.env, `${field}.env`),
			cwd: optionalString(value.cwd, `${field}.cwd`),
			tools,
		};
	}

	throw new Error(`${field} needs a "url" or a "command"`);
};

const parseServers = (json: string | undefined): Map<string, ServerConfig> => {
	if (!json) return new Map();

	const value: unknown = JSON.parse(json);
	if (!isRecord(value)) throw new Error("MCP_SERVERS must be a JSON object");

	return new Map(
		Object.entries(value).map(([name, server]) => [
			name,
			parseServer(name, server),
		]),
	);
};

export const servers = parseServers(process.env.MCP_SERVERS);

/** Where OAuth clients and tokens of the servers are kept. */
export const oauthFile = process.env.MCP_OAUTH_FILE ?? "state/mcp-oauth.json";
