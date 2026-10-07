import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
	type Conversation,
	defineExtension,
	type ModelRef,
	section,
} from "@earendil-works/pi-durable";

import { NapTask } from "./nap.ts";
import { compact, SessionTask } from "./session.ts";
import { createMemoryAskTool, keepsMemory, memoryZoomTool } from "./tools.ts";
import { renderWake } from "./wake.ts";

const SECTION = "memory";

// Long-term memory after OptMem (github.com/VictorTaelin/OptMem), kept by code
// instead of asked for in the prompt. The main conversation runs in sessions;
// each one that ends becomes one line of memory, written by `model`, and
// pairs of lines merge upwards into a binary tree. The agent reads the tree in
// its system prompt, zooms down to a past session and asks `model` about its
// full transcript. It never takes notes itself.
export const createMemory = ({
	models,
	model,
}: {
	models: Models;
	model: ModelRef;
}) => ({
	extension: defineExtension({
		name: "memory",
		sections: [
			section(
				SECTION,
				// Rendered once per context: the prompt stays stable, and every new
				// context reads the memory afresh.
				async (input, context) => {
					if (!keepsMemory(input.conversationId)) return undefined;
					return input.shown[SECTION] ?? renderWake(input.read, context);
				},
				{ tag: false },
			),
		],
		tools: [memoryZoomTool, createMemoryAskTool({ models, model })],
		tasks: [SessionTask, NapTask],
	}),

	/** Compacts the conversation: its session gets its line of memory and a new context starts. */
	compact: (conversation: Conversation, context: Context) =>
		compact(conversation, model, context),
});
