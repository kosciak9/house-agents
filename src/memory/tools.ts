import type { Models } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineTool,
	type ModelRef,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";

import { ask } from "./llm.ts";
import { openMemory } from "./store.ts";
import { readTranscript, type Transcript } from "./transcript.ts";
import { formatBlock, parseBlock } from "./tree.ts";
import { blockLines } from "./wake.ts";

const ASK_SYSTEM_PROMPT =
	"You answer a personal assistant's question about one of its past conversations with its user. " +
	"The assistant remembers only a one-line summary; you are given the full conversation. " +
	"Answer in the language of the question. Give everything relevant: the exact facts, numbers, " +
	"names, dates and wording, and what surrounds them: what led to it, what was decided and why, " +
	"alternatives considered, what stayed open. Say when the answer is uncertain or the conversation " +
	"does not contain it, and give what comes closest. Invent nothing.";

// The memory is the main conversation's own. A subagent cannot judge what is
// already known, so it neither reads nor writes it.
export const keepsMemory = (conversationId: ConversationId): boolean =>
	conversationId === ROOT_CONVERSATION_ID;

const text = (lines: readonly string[], isError = false) => ({
	content: [{ type: "text" as const, text: lines.join("\n") }],
	isError,
});

const notKept = () =>
	text(["Only the main conversation keeps long-term memory."], true);

export const memoryZoomTool = defineTool({
	name: "memory_zoom",

	description:
		"Open a line `#a-b` of your memory into its two halves: two finer lines, or two " +
		"past conversations `[session]`. Zoom until you reach the conversation you need.",

	parameters: Type.Object({
		block: Type.String({ description: "The line to open, as shown: #16-31" }),
	}),

	replay: "safe",

	execute: async (args, api, context) => {
		if (!keepsMemory(api.conversationId)) return notKept();

		const block = parseBlock(args.block);
		if (block === undefined) {
			return text(
				[`"${args.block}" is not a line of your memory; copy one like #16-31.`],
				true,
			);
		}
		const memory = await openMemory(api, context);
		if (block.lo >= memory.count) {
			return text(
				[`${formatBlock(block)} is beyond the ${memory.count} conversations.`],
				true,
			);
		}

		const mid = (block.lo + block.hi) / 2;
		const lines: string[] = [];
		for (const half of [
			{ lo: block.lo, hi: mid },
			{ lo: mid, hi: Math.min(block.hi, memory.count) },
		]) {
			if (half.lo < half.hi) lines.push(...(await blockLines(memory, half)));
		}
		return text(lines);
	},
});

/** memory_ask: a smaller model reads one past conversation and answers about it. */
export const createMemoryAskTool = ({
	models,
	model,
}: {
	models: Models;
	model: ModelRef;
}) =>
	defineTool({
		name: "memory_ask",

		description:
			"Ask about the details of one past conversation `[session]`: a helper reads its " +
			"full transcript and answers. Use it when the line of that conversation is relevant " +
			"but lacks what you need: exact numbers, names, wording, what was considered or decided.",

		parameters: Type.Object({
			session: Type.String({
				description: "The conversation, as shown in brackets: [3f9a2c1b]",
			}),
			question: Type.String({
				description:
					"What you want to know, specific and self-contained, with the context the helper needs.",
			}),
		}),

		replay: "safe",

		execute: async (args, api, context) => {
			if (!keepsMemory(api.conversationId)) return notKept();

			const id = args.session.replace(/[[\]\s]/g, "");
			const memory = await openMemory(api, context);
			const leaf = (await memory.leaves(0, memory.count)).find(
				(candidate) => candidate.session === id,
			);
			if (leaf === undefined) {
				return text(
					[
						`No past conversation [${id}]. Find it in your memory with memory_zoom; ` +
							"ids are not guessable.",
					],
					true,
				);
			}

			let transcript: Transcript = { text: "" };
			await api.commit(async (tx) => {
				transcript = await readTranscript(tx, leaf.from, leaf.to);
			}, context);

			const answer = await ask(models, model, {
				system: ASK_SYSTEM_PROMPT,
				prompt: [
					`Question: ${args.question}`,
					"",
					`<conversation date="${leaf.start}">`,
					transcript.text,
					"</conversation>",
				].join("\n"),
				signal: context.abortSignal,
			});
			if (!answer.ok) {
				return {
					...text([`The helper failed: ${answer.error}`], true),
					...(answer.usage && { usage: answer.usage }),
				};
			}
			return { ...text([answer.text]), usage: answer.usage };
		},
	});
