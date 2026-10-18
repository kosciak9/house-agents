import { onLeaf } from "../memory/announce.ts";
import { bot, chatId } from "./bot.ts";

const dates = (start: string, end: string): string =>
	start === end ? start : `${start}–${end}`;

/** The chat hears every line of memory a session leaves, as the agent will read it. */
export const announceMemory = (): void =>
	onLeaf((leaf) => {
		bot.api
			.sendMessage(chatId, `🧠 ${dates(leaf.start, leaf.end)}: ${leaf.text}`)
			.catch((error) => console.error("Could not announce memory:", error));
	});
