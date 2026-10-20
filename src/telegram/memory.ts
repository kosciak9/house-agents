import { onSession } from "../memory/announce.ts";
import { bot, chatId } from "./bot.ts";

const dates = (start: string, end: string): string =>
	start === end ? start : `${start}–${end}`;

/** Telegram's limit is 4096 characters; leave room for the header. */
const MESSAGE_CHARS = 3800;

// One message after another, so sessions and their parts arrive in order.
let sending: Promise<unknown> = Promise.resolve();

/** The chat hears the lines of memory each session leaves, as the agent will read them. */
export const announceMemory = (): void =>
	onSession((leaves) => {
		const [first] = leaves;
		const messages = [`🧠 ${dates(first.start, first.end)}:`];
		for (const leaf of leaves) {
			const line = `• ${leaf.text}`;
			if (
				messages[messages.length - 1].length + line.length + 1 >
				MESSAGE_CHARS
			) {
				messages.push(line);
			} else {
				messages[messages.length - 1] += `\n${line}`;
			}
		}
		for (const text of messages) {
			sending = sending
				.then(() => bot.api.sendMessage(chatId, text))
				.catch((error) => console.error("Could not announce memory:", error));
		}
	});
