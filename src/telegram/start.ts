import { harness, root } from "../agent/harness.ts";
import type { Mcp } from "../mcp/start.ts";
import { bot, chatId, environment } from "./bot.ts";
import { createDiagnosticsCommand } from "./diagnostics.ts";
import { announceModelSwitches } from "./fallback.ts";
import {
	handleCompactCommand,
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
import {
	cancelMcpLogin,
	createLoginAnswer,
	createLoginCommand,
	createMcpCommand,
	LOGIN_COMMAND,
} from "./mcp.ts";
import { forwardAssistantMessages } from "./outbound.ts";

/**
 * Sends every answer of the conversation to the chat, and a word whenever the
 * agent turns to its fallback model or back.
 */
export const forwardToTelegram = (): Promise<void> => {
	announceModelSwitches();
	return forwardAssistantMessages(harness, root.id);
};

/** Starts taking messages from the chat. */
export const startTelegram = async ({ mcp }: { mcp: Mcp }): Promise<void> => {
	const chat = bot.filter((ctx) => ctx.chat?.id === chatId);
	// Commands are for the bot itself; they never reach the agent.
	chat.command("mcp", createMcpCommand(mcp));
	chat.command("diagnostics", createDiagnosticsCommand(mcp));
	chat.command(LOGIN_COMMAND, createLoginCommand(mcp));
	chat.command("login", handleLoginCommand);
	chat.command("logout", handleLogoutCommand);
	chat.command("cancel", cancelMcpLogin, handleCancelCommand);
	chat.command("compact", handleCompactCommand);
	chat.on(
		"message:text",
		createLoginAnswer(mcp),
		takeLoginAnswer,
		handleTextMessage,
	);
	chat.on("message:photo", handlePhotoMessage);
	chat.on("message:voice", handleVoiceMessage);
	// Only the cause: the context it comes with holds the bot's token.
	bot.catch(({ error, ctx }) => {
		console.error(`Telegram error in update ${ctx.update.update_id}:`, error);
	});

	await bot.start({
		// In the test environment, messages sent while no bot was running belong
		// to an earlier test and must not leak into the next one.
		drop_pending_updates: environment === "test",
		// E2E waits for this line to know the bot is ready.
		onStart: (me) => console.log(`Bot @${me.username} started`),
	});
};
