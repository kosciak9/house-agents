import type { NextFunction } from "grammy";

import { bot, chatId } from "./bot.ts";

// Telegram shows "typing…" for five seconds, or until the bot sends a message.
const TYPING_REFRESH_MS = 4_000;

const sendTyping = async (): Promise<void> => {
	try {
		await bot.api.sendChatAction(chatId, "typing");
	} catch (error) {
		console.error("Could not show typing:", error);
	}
};

/** Shows "typing…" in the chat until the handlers after it are done. */
export const showTyping = async (
	_ctx: unknown,
	next: NextFunction,
): Promise<void> => {
	void sendTyping();
	const refresh = setInterval(sendTyping, TYPING_REFRESH_MS);
	try {
		await next();
	} finally {
		clearInterval(refresh);
	}
};
