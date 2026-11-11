import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import type { ModelThinkingLevel, Provider } from "@earendil-works/pi-ai";
import { Cron } from "croner";

// Everything the deployment decides comes in one `Config`, which it passes to
// `startAgent()` (`src/index.ts`) in code or exports as the default of
// `house-agents.config.ts`. Secrets stay in the environment; the deployment
// reads the ones the config needs from `process.env` itself.

/**
 * Where to reach a remote MCP server (Streamable HTTP); who may use which of
 * its tools is up to an `McpPolicy`. A server that needs OAuth offers nothing
 * until the user logs in to it from the chat (`/mcp_login`).
 */
export type McpServer = {
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
	/** Every subagent connects to its servers anew and closes them when done. */
	mcp?: McpPolicy;
	/**
	 * Gives it Lightpanda, the headless browser in the image, to search the web
	 * and read pages: a browser of its own, started for it and closed once it
	 * answers.
	 */
	lightpanda?: boolean;
};

/**
 * Moments at which the harness wakes the agent to review its sources and the
 * matters still open, e.g. at 9:00, 13:00 and 18:00.
 */
export type Reviews = {
	/** 5-field cron, or 6 with a leading second. */
	cron: string;
	/** IANA time zone of `cron` and of the guard's times; `timeZone` by default. */
	timeZone?: string;
	/** The prompt that wakes the agent for a review. */
	prompt: string;
	/**
	 * The guard: before each review, a separate model call (`smallModel`) reads
	 * the last day of the conversation and lists the matters still open, one
	 * per line, each opening with the time worth coming back to it,
	 * `YYYY-MM-DD HH:MM | ` in `timeZone`. The review prompt carries its list,
	 * and each timed matter becomes a wake-up of the agent, replacing those of
	 * the review before.
	 */
	guard?: {
		/** Its system prompt; it must ask for the line format above. */
		prompt: string;
		/** The model it runs on; `smallModel` by default. */
		model?: Model;
		/** Introduces its list in the review prompt. */
		heading: string;
		/** Opens the prompt of each wake-up it sets, before the matter. */
		wake: string;
	};
};

/**
 * A nightly retro: the harness gives the agent the last day of its
 * conversation to learn from, e.g. to write its skills.
 */
export type Retro = {
	/** 5-field cron, or 6 with a leading second. */
	cron: string;
	/** IANA time zone of `cron`; `timeZone` by default. */
	timeZone?: string;
	/**
	 * The prompt, which the day follows in a <day> block, and the tasks its
	 * subagents did (intent, model, status, cost, MCP tools) in <jobs>.
	 */
	prompt: string;
};

/** What a source's `poll` gets. */
export type SourceRead = {
	/**
	 * Calls a tool of one of `mcpServers` and returns its text; throws when
	 * the tool reports an error.
	 */
	call: (
		server: string,
		tool: string,
		args: Record<string, unknown>,
	) => Promise<string>;
	/** What the last poll returned as its `cursor`; `null` at first. */
	cursor: JsonValue | null;
	now: number;
};

/** What a source's `poll` found. */
export type SourceUpdate = {
	/** Kept for the next poll. */
	cursor: JsonValue;
	/** New items, written into the conversation without waking the agent. */
	notes?: string[];
	/**
	 * Every wake-up the source wants from now on, by key: the harness keeps
	 * exactly these, replacing one whose time or prompt changed.
	 */
	wakes?: { key: string; at: number; prompt: string }[];
};

/** Something the harness reads on its own every few minutes, e.g. a calendar. */
export type Source = {
	/** 5 by default. */
	everyMinutes?: number;
	poll: (read: SourceRead) => Promise<SourceUpdate>;
};

export type Config = {
	/** Who the agent is: the system prompt that opens its conversation. */
	prompt: string;
	/** The model the agent talks on, e.g. `openai-codex` `gpt-6.1-sol`. */
	model: Model;
	/**
	 * Answers in its place whenever a request to `model` fails, e.g. `xai`
	 * `grok-4.7`; the next request tries `model` again. The chat hears when
	 * the agent turns to it and when `model` answers again.
	 */
	fallbackModel?: Model;
	/**
	 * Model providers besides the subscriptions logged in to from the chat
	 * (`/login`), e.g. E2E's scripted model (`e2e/scripted-model.ts`).
	 */
	providers?: Provider[];
	/**
	 * The user's IANA time zone, e.g. `Europe/Warsaw`: every time the agent
	 * reads (each message opens with its time) and sets (wake-ups, cron
	 * schedules) is in it, as are the reviews and the retro by default. The
	 * process's by default.
	 */
	timeZone?: string;
	telegram: {
		/** The one chat the bot serves; it ignores every other one. */
		chatId: number;
		/** "test" is Telegram's separate test environment, used by E2E. */
		environment?: "prod" | "test";
	};
	/** Whisper's `/v1/audio/transcriptions` endpoint, e.g. whisper.cpp's. */
	whisperUrl: string;
	/**
	 * Gotenberg, e.g. `http://localhost:3000`, which converts files sent in
	 * the chat to PDF when the model cannot read them as they are. Without it,
	 * only images, PDFs and text files are read.
	 */
	gotenbergUrl?: string;
	/** The MCP servers the agent and its subagents may use, by name. */
	mcpServers?: Record<string, McpServer>;
	/** What the agent itself may use of them. */
	mcp?: McpPolicy;
	/**
	 * The general subagent, the agent's worker. By default it shares the
	 * agent's prompt, model and MCP tools; giving it its own lets the agent
	 * only talk and delegate while its workers reach the servers.
	 */
	worker?: {
		/** Its system prompt; the agent's `prompt` by default. */
		prompt?: string;
		/** The agent's `model` by default. */
		model?: Model;
		/**
		 * Other models the agent may pick for a task, by name, e.g. a stronger
		 * one for harder work; `model` answers a task that names none. The
		 * retro learns which fits which kind of task from the day's tasks.
		 */
		models?: Record<string, { model: Model; description: string }>;
		/** What it may use of the MCP servers; the agent's `mcp` by default. */
		mcp?: McpPolicy;
		/**
		 * A dispatcher between the agent and its workers: before the agent's
		 * general tasks start, one call of `model` reads what the agent asked,
		 * the recent conversation, the memory and the skills, and picks each
		 * task's model and writes its brief. The agent can then talk on a fast
		 * model while a stronger one briefs its workers. Without it, a task runs
		 * as the agent wrote it.
		 */
		dispatcher?: {
			model: Model;
			/** Its system prompt; the default model's description belongs here. */
			prompt: string;
		};
	};
	/**
	 * A cheap model for helper work that would waste the agent's own turns,
	 * such as reading its memory; `openai-codex` `gpt-6-luna` by default.
	 */
	smallModel?: Model;
	/** The subagents the agent may start, by name. */
	subagents?: Record<string, Subagent>;
	/** When the harness wakes the agent to review, with the guard's list. */
	reviews?: Reviews;
	/** When the harness gives the agent its day for a retro. */
	retro?: Retro;
	/**
	 * What the harness reads on its own, by name: new items reach the
	 * conversation without waking the agent, and the source's wake-ups wake it.
	 */
	sources?: Record<string, Source>;
	/**
	 * When to compact the conversation on a schedule as well, e.g. `0 5 * * *`
	 * after the agent's own night routine: each firing waits for the run in
	 * progress to end. The agent never sees it.
	 */
	compaction?: { cron: string; timeZone?: string };
	/** Where the agent keeps its session and tokens; `state` by default. */
	stateDir?: string;
	/** Model provider logins; `<stateDir>/auth.json` by default. */
	credentialsFile?: string;
};

/** A conversation's settings for running on `model`. */
export const modelSettings = (model: Model) => ({
	model: { provider: model.provider, modelId: model.modelId },
	thinkingLevel: model.thinkingLevel ?? null,
});

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

const isValidCompaction = ({
	cron,
	timeZone,
}: {
	cron: string;
	timeZone?: string;
}) => {
	try {
		new Cron(cron, { timezone: timeZone, paused: true }).nextRun();
		return true;
	} catch {
		return false;
	}
};

const isValidZone = (timeZone: unknown): boolean => {
	if (typeof timeZone !== "string") return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
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
	if (
		value.fallbackModel !== undefined &&
		(typeof value.fallbackModel?.provider !== "string" ||
			typeof value.fallbackModel.modelId !== "string")
	) {
		throw new Error("config.fallbackModel needs a provider and a modelId");
	}
	for (const [field, model] of [
		["config.worker.model", value.worker?.model],
		["config.worker.dispatcher.model", value.worker?.dispatcher?.model],
		["config.reviews.guard.model", value.reviews?.guard?.model],
		["config.smallModel", value.smallModel],
	] as const) {
		if (
			model !== undefined &&
			(typeof model?.provider !== "string" || typeof model.modelId !== "string")
		) {
			throw new Error(`${field} needs a provider and a modelId`);
		}
	}
	if (
		value.worker !== undefined &&
		(typeof value.worker !== "object" ||
			value.worker === null ||
			(value.worker.prompt !== undefined &&
				(typeof value.worker.prompt !== "string" || !value.worker.prompt)))
	) {
		throw new Error("config.worker must be an object with a non-empty prompt");
	}
	const dispatcher = value.worker?.dispatcher;
	if (
		dispatcher !== undefined &&
		(typeof dispatcher?.model?.provider !== "string" ||
			typeof dispatcher.prompt !== "string" ||
			!dispatcher.prompt)
	) {
		throw new Error("config.worker.dispatcher needs a model and a prompt");
	}
	if (value.providers !== undefined && !Array.isArray(value.providers)) {
		throw new Error("config.providers must be an array");
	}
	if (value.timeZone !== undefined && !isValidZone(value.timeZone)) {
		throw new Error("config.timeZone must be an IANA time zone");
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
	if (
		value.gotenbergUrl !== undefined &&
		(typeof value.gotenbergUrl !== "string" ||
			!URL.canParse(value.gotenbergUrl))
	) {
		throw new Error("config.gotenbergUrl must be a URL");
	}
	if (
		value.compaction !== undefined &&
		(typeof value.compaction?.cron !== "string" ||
			!isValidCompaction(value.compaction))
	) {
		throw new Error(
			"config.compaction needs a valid cron and, if given, an IANA timeZone",
		);
	}
	const { reviews, retro, sources } = value;
	if (
		retro !== undefined &&
		(typeof retro?.cron !== "string" ||
			!isValidCompaction(retro) ||
			typeof retro.prompt !== "string" ||
			!retro.prompt)
	) {
		throw new Error(
			"config.retro needs a valid cron and timeZone, and a prompt",
		);
	}
	if (
		reviews !== undefined &&
		(typeof reviews?.cron !== "string" ||
			!isValidCompaction(reviews) ||
			typeof reviews.prompt !== "string" ||
			!reviews.prompt ||
			(reviews.guard !== undefined &&
				!["prompt", "heading", "wake"].every(
					(field) =>
						typeof reviews.guard?.[field as "prompt"] === "string" &&
						reviews.guard[field as "prompt"],
				)))
	) {
		throw new Error(
			"config.reviews needs a valid cron and timeZone, a prompt, and a guard with prompt, heading and wake",
		);
	}
	for (const [name, source] of Object.entries(sources ?? {})) {
		if (
			typeof source?.poll !== "function" ||
			(source.everyMinutes !== undefined &&
				!(
					typeof source.everyMinutes === "number" &&
					source.everyMinutes > 0 &&
					// setTimeout's limit, about 24 days.
					source.everyMinutes * 60_000 <= 2 ** 31 - 1
				))
		) {
			throw new Error(
				`config.sources.${name} needs a poll function and a positive everyMinutes`,
			);
		}
	}
	current = value;
};

export const config = (): Config => {
	if (!current) throw new Error("The config is not set yet");
	return current;
};

export const stateFile = (name: string): string =>
	path.join(config().stateDir ?? "state", name);
