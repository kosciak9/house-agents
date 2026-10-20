import { onSession } from "../memory/announce.ts";
import { bot, chatId } from "./bot.ts";

const dates = (start: string, end: string): string =>
	start === end ? start : `${start}–${end}`;

/** The chat hears the lines of memory each session leaves, as the agent will read them. */
export const announceMemory = (): void =>
	onSession((leaves) => {
		const [first] = leaves;
		bot.api
			.sendMessage(
				chatId,
				[
					`🧠 ${dates(first.start, first.end)}:`,
					...leaves.map((leaf) => `• ${leaf.text}`),
				].join("\n"),
			)
			.catch((error) => console.error("Could not announce memory:", error));
	});
