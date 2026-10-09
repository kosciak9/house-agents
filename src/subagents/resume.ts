import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	Harness,
	Registry,
} from "@earendil-works/pi-durable";

import { config, modelSettings } from "../config.ts";
import { createGeneralRunExtension, rootExtensions } from "./extension.ts";

const isConversationId = (value: unknown): value is ConversationId =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Call after installing root tools and before enabling the harness scheduler. */
export const refreshGeneralSubagents = async (
	{ harness, registry }: { harness: Harness; registry: Registry },
	context: Context,
): Promise<void> => {
	const { tasks } = await harness.inspect(context);
	const { model, prompt } = config();
	const extensions = rootExtensions(registry);
	for (const { record } of tasks) {
		if (record.kind !== "subagent.job") continue;
		const input = record.input;
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			input.agent !== "general"
		)
			continue;
		if (record.state.status !== "running") continue;
		const checkpoint = record.state.checkpoint;
		if (
			typeof checkpoint !== "object" ||
			checkpoint === null ||
			Array.isArray(checkpoint) ||
			checkpoint.phase !== "run" ||
			!Array.isArray(checkpoint.conversations)
		)
			continue;
		for (const id of checkpoint.conversations) {
			if (!isConversationId(id)) continue;
			const conversation = await harness.conversation(id, context);
			if (!conversation) continue;
			const extension = createGeneralRunExtension(conversation.id);
			registry.install(extension);
			await conversation.configure(
				{
					...modelSettings(model),
					instructions: prompt,
					tools: null,
					extensions: [...extensions, extension],
				},
				context,
			);
		}
	}
};
