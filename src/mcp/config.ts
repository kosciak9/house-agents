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

export type HttpServer = {
	type: "http";
	url: URL;
	/** Sent with every request, e.g. `Authorization: Bearer <key>`. */
	headers: Record<string, string>;
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
