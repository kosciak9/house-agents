import type { Message } from "@earendil-works/pi-ai";
import {
	defineExtension,
	GenerationTask,
	hook,
} from "@earendil-works/pi-durable";

// pi-durable writes a context's first system prompt when it first answers,
// after the input that started the context, while pi-ai treats only a leading
// system message as the prompt: one later in the context goes to the model as
// an update after a default prompt. Moved to the front, it is the prompt
// again; any later system message still goes as an update.

/** `messages` with the first system message moved to the front. */
const withPromptFirst = (messages: readonly Message[]): readonly Message[] => {
	const index = messages.findIndex((message) => message.role === "system");
	if (index <= 0) return messages;
	return [
		messages[index] as Message,
		...messages.slice(0, index),
		...messages.slice(index + 1),
	];
};

export const PromptFirstExtension = defineExtension({
	name: "prompt-first",
	hooks: [
		hook(GenerationTask, {
			beforeRequest: ({ messages }) => ({
				messages: withPromptFirst(messages),
			}),
		}),
	],
});
