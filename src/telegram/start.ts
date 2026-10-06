import { harness, root } from "../agent/harness.ts";
import type { Mcp } from "../mcp/start.ts";
import { bot, chatId, environment } from "./bot.ts";
import {
	handlePhotoMessage,
	handleTextMessage,
	handleVoiceMessage,
} from "./inbound.ts";
import {
	handleCancelCommand,
	handleLoginCommand,
	handleLogoutCommand,
	takeLoginAnswer,
} from "./login.ts";
import { AUTH_COMMAND, createAuthCommand } from "./mcp-auth.ts";
import { forwardAssistantMessages } from "./outbound.ts";

/** Sends every answer of the conversation to the chat. */
export const forwardToTelegram = (): Promise<void> =>
	forwardAssistantMessages(harness, root.id);

/** Starts taking messages from the chat. */
export const startTelegram = async ({ mcp }: { mcp: Mcp }): Promise<void> => {
	const chat = bot.filter((ctx) => ctx.chat?.id === chatId);
	// Commands are for the bot itself; they never reach the agent.
	chat.command(AUTH_COMMAND, createAuthCommand(mcp));
	chat.command("login", handleLoginCommand);
	chat.command("logout", handleLogoutCommand);
	chat.command("cancel", handleCancelCommand);
	chat.on("message:text", takeLoginAnswer, handleTextMessage);
	chat.on("message:photo", handlePhotoMessage);
	chat.on("message:voice", handleVoiceMessage);
	bot.catch((error) => {
		console.error("Telegram error:", error);
	});

	await bot.start({
		// In the test environment, messages sent while no bot was running belong
		// to an earlier test and must not leak into the next one.
		drop_pending_updates: environment === "test",
		// E2E waits for this line to know the bot is ready.
		onStart: (me) => console.log(`Bot @${me.username} started`),
	});
};
