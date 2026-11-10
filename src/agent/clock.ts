import type { Message } from "@earendil-works/pi-ai";
import {
	defineExtension,
	GenerationTask,
	hook,
	section,
} from "@earendil-works/pi-durable";

import { TIME_ZONE } from "../scheduler/schedules.ts";
import { toWall } from "../scheduler/wall.ts";

// The model has no clock: each message to it opens with the time it came, in
// the user's time zone. Only the request carries it, and a message's time
// never changes, so the provider's prompt cache stays warm.

const withTime = (message: Message): Message => {
	if (message.role !== "user") return message;
	const time = `[${toWall(message.timestamp, TIME_ZONE)}]`;
	return {
		...message,
		content:
			typeof message.content === "string"
				? `${time} ${message.content}`
				: [{ type: "text", text: time }, ...message.content],
	};
};

export const ClockExtension = defineExtension({
	name: "clock",
	sections: [
		section(
			"clock",
			() =>
				`Each message to you opens with the time it came, [YYYY-MM-DD HH:MM] in ${TIME_ZONE}, the user's time zone; the latest one tells you what time it is now.`,
		),
	],
	hooks: [
		hook(GenerationTask, {
			beforeRequest: ({ messages }) => ({ messages: messages.map(withTime) }),
		}),
	],
});
