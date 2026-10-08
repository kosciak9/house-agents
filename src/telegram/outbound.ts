import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type ConversationId,
	type Harness,
	watchEvents,
} from "@earendil-works/pi-durable";

import { isSilentReply } from "../scheduler/silent.ts";
import { bot, chatId } from "./bot.ts";

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

export const forwardAssistantMessages = async (
	harness: Harness,
	conversationId: ConversationId,
): Promise<void> => {
	const stream = await watchEvents(harness, conversationId, BACKGROUND_CONTEXT);

	stream.start(async (events) => {
		for (const markdown of events.map(finalResponseText)) {
			if (markdown === undefined || isSilentReply(markdown)) continue;

			await bot.api.sendRichMessage(chatId, { markdown });
		}
	});
};
