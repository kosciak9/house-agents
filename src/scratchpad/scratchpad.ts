import { Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTool,
	section,
} from "@earendil-works/pi-durable";

// The agent's scratchpad: one markdown note it keeps itself and always sees
// in its prompt, for what it watches and waits for across turns and contexts.
// Only the agent's own conversation has one; its workers do not.

export const SCRATCHPAD_LIMIT = 3000;

export const Scratchpad = defineDoc<{ text: string }>({
	kind: "scratchpad",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ text: "" }),
});

const reply = (text: string) => ({
	content: [{ type: "text" as const, text }],
});

const scratchpadTool = defineTool({
	name: "scratchpad",
	description:
		"Replace your scratchpad, the markdown note you always see in <scratchpad>, " +
		"with new content: what you watch and wait for across turns. " +
		`At most ${SCRATCHPAD_LIMIT} characters.`,
	parameters: Type.Object({
		content: Type.String({
			description: "The whole new scratchpad, in markdown.",
		}),
	}),
	execute: async ({ content }, api, context) => {
		if (content.length > SCRATCHPAD_LIMIT) {
			return reply(
				`Not saved: ${content.length} characters, the limit is ${SCRATCHPAD_LIMIT}. Shorten it and save again.`,
			);
		}
		await api.commit(async (tx) => {
			(await tx.doc(Scratchpad, api.conversationId)).text = content;
		}, context);
		return reply(`Saved (${content.length}/${SCRATCHPAD_LIMIT} characters).`);
	},
});

export const ScratchpadExtension = defineExtension({
	name: "scratchpad",
	sections: [
		section("scratchpad", async (input, context) => {
			const scratchpad = await input.read.snapshot(
				Scratchpad,
				input.conversationId,
				context,
			);
			return `Your scratchpad, which you keep with the scratchpad tool:\n${scratchpad?.text || "(empty)"}`;
		}),
	],
	tools: [scratchpadTool],
});
