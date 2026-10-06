// The agent as E2E runs it: in Telegram's test environment, configured by the
// JSON in its first argument on top of these defaults.
import { type Config, startAgent } from "../src/index.ts";
import { DEFAULT_PROMPT } from "./bot.ts";

const overrides: Partial<Config> = JSON.parse(process.argv[2] ?? "{}");

await startAgent({
	prompt: DEFAULT_PROMPT,
	telegram: {
		chatId: Number(process.env.TELEGRAM_CHAT_ID),
		environment: "test",
	},
	whisperUrl: process.env.WHISPER_API_URL ?? "",
	...overrides,
});
