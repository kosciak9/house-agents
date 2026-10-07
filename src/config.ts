import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

// Everything the deployment decides comes in one `Config`, which it passes to
// `startAgent()` (`src/index.ts`) in code or exports as the default of
// `house-agents.config.ts`. Secrets stay in the environment; the deployment
// reads the ones the config needs from `process.env` itself.

/**
 * How to reach an MCP server; who may use which of its tools is up to an
 * `McpPolicy`. A server that needs OAuth offers nothing until the user logs
 * in to it from the chat (`/mcp_login`).
 */
export type McpServer =
	| {
			command: string;
			args?: string[];
			env?: Record<string, string>;
			cwd?: string;
	  }
	| {
			url: string;
			/** Sent with every request, e.g. `Authorization: Bearer <key>`. */
			headers?: Record<string, string>;
			/**
			 * `true` registers the client dynamically; an object may name a
			 * pre-registered client, its redirect URL and the scope to ask for.
			 */
			oauth?:
				| boolean
				| {
						clientId?: string;
						clientSecret?: string;
						scope?: string;
						redirectUrl?: string;
				  };
	  };

/**
 * The tools an agent may call, by server name from `mcpServers`; every other
 * server and tool stays hidden from it.
 */
export type McpPolicy = Record<string, string[]>;

export type Model = {
	provider: string;
	modelId: string;
	/** "off" by default. */
	thinkingLevel?: ModelThinkingLevel;
};

/**
 * An agent the agent hands tasks to in the background, one subagent per task,
 * and hears back from once they are all done.
 */
export type Subagent = {
	/** What it is for; the agent picks it by this. */
	description: string;
	/** Its system prompt; it knows nothing else of the conversation. */
	prompt: string;
	/** The agent's model by default. */
	model?: Model;
	/**
	 * Every subagent connects to its servers anew and closes them when it is
	 * done, so each one started over stdio runs only for that subagent, e.g. a
	 * browser of its own.
	 */
	mcp?: McpPolicy;
};

export type Config = {
	/** Who the agent is: the system prompt that opens its conversation. */
	prompt: string;
	/** The model the agent talks on, e.g. `openai-codex` `gpt-6.1-sol`. */
	model: Model;
	telegram: {
		/** The one chat the bot serves; it ignores every other one. */
		chatId: number;
		/** "test" is Telegram's separate test environment, used by E2E. */
		environment?: "prod" | "test";
	};
	/** Whisper's `/v1/audio/transcriptions` endpoint, e.g. whisper.cpp's. */
	whisperUrl: string;
	/** The MCP servers the agent and its subagents may use, by name. */
	mcpServers?: Record<string, McpServer>;
	/** What the agent itself may use of them. */
	mcp?: McpPolicy;
	/** The subagents the agent may start, by name. */
	subagents?: Record<string, Subagent>;
	/** Where the agent keeps its session and tokens; `state` by default. */
	stateDir?: string;
	/** Model provider logins; `<stateDir>/auth.json` by default. */
	credentialsFile?: string;
};

const CONFIG_FILE = "house-agents.config.ts";

/** The default export of `house-agents.config.ts` in the working directory. */
export const readConfigFile = async (): Promise<Config> => {
	const file = path.resolve(CONFIG_FILE);
	if (!existsSync(file)) {
		throw new Error(
			`No config: pass one to startAgent() or create ${CONFIG_FILE}`,
		);
	}
	return (await import(pathToFileURL(file).href)).default;
};

let current: Config | undefined;

/** Sets the config once, before any module that reads it is loaded. */
export const useConfig = (value: Config): void => {
	if (current) throw new Error("The config is already set");
	if (typeof value !== "object" || value === null) {
		throw new Error("The config must be an object");
	}
	if (typeof value.prompt !== "string" || !value.prompt) {
		throw new Error("config.prompt is required");
	}
	if (
		typeof value.model?.provider !== "string" ||
		typeof value.model.modelId !== "string"
	) {
		throw new Error("config.model needs a provider and a modelId");
	}
	if (!Number.isSafeInteger(value.telegram?.chatId)) {
		throw new Error("config.telegram.chatId must be an integer chat id");
	}
	const environment = value.telegram.environment ?? "prod";
	if (environment !== "prod" && environment !== "test") {
		throw new Error('config.telegram.environment must be "prod" or "test"');
	}
	if (typeof value.whisperUrl !== "string" || !value.whisperUrl) {
		throw new Error("config.whisperUrl is required");
	}
	current = value;
};

export const config = (): Config => {
	if (!current) throw new Error("The config is not set yet");
	return current;
};

export const stateFile = (name: string): string =>
	path.join(config().stateDir ?? "state", name);
