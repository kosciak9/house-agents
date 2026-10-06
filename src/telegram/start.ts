import { harness, root } from "../agent/harness.ts";
import { bot, chatId, environment } from "./bot.ts";
import { handlePhotoMessage, handleTextMessage } from "./inbound.ts";
import { forwardAssistantMessages } from "./outbound.ts";

export const startTelegram = async (): Promise<void> => {
	await forwardAssistantMessages(harness, root.id);
	// Resume only once forwarding is attached, so answers of runs interrupted by
	// the last shutdown still reach the chat.
	harness.resume();

	const chat = bot.filter((ctx) => ctx.chat?.id === chatId);
	chat.on("message:text", handleTextMessage);
	chat.on("message:photo", handlePhotoMessage);
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
