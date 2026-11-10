// The agent as E2E runs it: in Telegram's test environment, configured by the
// JSON in its first argument on top of these defaults. Its scripted model
// (`SCRIPTED_MODEL`) is always there for tests to pick.
import type { JsonValue } from "@earendil-works/chord";

import { type Config, type Source, startAgent } from "../src/index.ts";
import { DEFAULT_PROMPT } from "./bot.ts";
import { scriptedProvider } from "./scripted-model.ts";

/**
 * A source as JSON: it reads one tool whose text is the update itself
 * (`SourceUpdate` as JSON), with its notes once per cursor.
 */
export type E2eSource = { server: string; tool: string; everyMinutes?: number };

const {
	sources,
	...overrides
}: Partial<Config> & {
	sources?: Record<string, E2eSource>;
} = JSON.parse(process.argv[2] ?? "{}");

const sourceOf = ({ server, tool, everyMinutes }: E2eSource): Source => ({
	everyMinutes,
	poll: async ({ call, cursor }) => {
		const update = JSON.parse(await call(server, tool, {}));
		const seen =
			JSON.stringify(update.cursor as JsonValue) === JSON.stringify(cursor);
		return seen ? { ...update, notes: [] } : update;
	},
});

await startAgent({
	prompt: DEFAULT_PROMPT,
	// Cheaper and faster than what the deployment talks on.
	model: { provider: "openai-codex", modelId: "gpt-6-luna" },
	providers: [scriptedProvider()],
	telegram: {
		chatId: Number(process.env.TELEGRAM_CHAT_ID),
		environment: "test",
	},
	whisperUrl: process.env.WHISPER_API_URL ?? "",
	...overrides,
	...(sources && {
		sources: Object.fromEntries(
			Object.entries(sources).map(([name, source]) => [name, sourceOf(source)]),
		),
	}),
});
