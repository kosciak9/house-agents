import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type ConversationId,
	type Harness,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { ReactionTypeEmoji } from "grammy/types";

import { type Ending, endingOf } from "../endings/endings.ts";
import { bot, chatId } from "./bot.ts";
import { takeReplyTarget } from "./reply-target.ts";

const assistantText = (message: AssistantMessage): string =>
	message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();

// Assistant messages containing tool calls are intermediate turns, not final
// user-facing responses.
const isFinalResponse = (message: AssistantMessage): boolean =>
	!message.content.some((part) => part.type === "toolCall");

const finalResponseText = (event: AgentEvent): string | undefined => {
	if (event.type !== "message_end") return undefined;
	if (event.entry.kind !== "pi.assistant") return undefined;

	const message = event.entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	if (!isFinalResponse(message)) return undefined;

	return assistantText(message) || undefined;
};

// Telegram's reaction emoji carry no variation selector ("❤", not "❤️").
const reactionEmoji = (emoji: string) =>
	emoji.replaceAll("️", "") as ReactionTypeEmoji["emoji"];

/** Whether the reaction landed on the user's message. */
const react = async (messageId: number, emoji: string): Promise<boolean> => {
	try {
		await bot.api.setMessageReaction(chatId, messageId, [
			{ type: "emoji", emoji: reactionEmoji(emoji) },
		]);
		return true;
	} catch (error) {
		// Bots may react only with Telegram's own set of emoji.
		console.error(`Could not react with ${emoji}:`, error);
		return false;
	}
};

const deliver = async (ending: Ending): Promise<void> => {
	const target = takeReplyTarget();
	if (ending.kind === "silent") return;

	// With no message to react to, or an emoji Telegram refuses, the emoji
	// goes as a message.
	if (ending.kind === "reaction") {
		if (target !== undefined && (await react(target, ending.emoji))) return;
		await bot.api.sendMessage(chatId, ending.emoji);
		return;
	}

	await bot.api.sendRichMessage(chatId, { markdown: ending.markdown });
};

export const forwardAssistantMessages = async (
	harness: Harness,
	conversationId: ConversationId,
): Promise<void> => {
	const stream = await watchEvents(harness, conversationId, BACKGROUND_CONTEXT);

	stream.start(async (events) => {
		for (const text of events.map(finalResponseText)) {
			if (text !== undefined) await deliver(endingOf(text));
		}
	});
};
