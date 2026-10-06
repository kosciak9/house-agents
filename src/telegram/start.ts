import { harness, root } from "../agent/harness.ts";
import { bot, chatId } from "./bot.ts";
import { handleTextMessage } from "./inbound.ts";
import { forwardAssistantMessages } from "./outbound.ts";

export const startTelegram = async (): Promise<void> => {
	await forwardAssistantMessages(harness, root.id);
	// Resume only once forwarding is attached, so answers of runs interrupted by
	// the last shutdown still reach the chat.
	harness.resume();

	bot
		.filter((ctx) => ctx.chat?.id === chatId)
		.on("message:text", handleTextMessage);
	bot.catch((error) => {
		console.error("Telegram error:", error);
	});

	await bot.start();
};
