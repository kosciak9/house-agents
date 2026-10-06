import type { AssistantMessage, Models, Usage } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

import { fitEntry } from "./tree.ts";

export type Answer =
	| { ok: true; text: string; usage: Usage }
	| { ok: false; error: string; usage?: Usage };

const replyText = (message: AssistantMessage): string =>
	message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();

/** One request to the memory's model; a failure is returned, not thrown. */
export const ask = async (
	models: Models,
	model: ModelRef,
	request: { system: string; prompt: string; signal?: AbortSignal },
): Promise<Answer> => {
	const found = models.getModel(model.provider, model.modelId);
	if (!found) {
		return { ok: false, error: `model ${model.modelId} is not available` };
	}
	const now = Date.now();
	const message = await models.completeSimple(
		found,
		{
			messages: [
				{ role: "system", content: request.system, timestamp: now },
				{
					role: "user",
					content: [{ type: "text", text: request.prompt }],
					timestamp: now,
				},
			],
		},
		{ signal: request.signal, cacheRetention: "none" },
	);
	const text = replyText(message);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return {
			ok: false,
			error: message.errorMessage ?? message.stopReason,
			usage: message.usage,
		};
	}
	if (text.length === 0) {
		return { ok: false, error: "empty answer", usage: message.usage };
	}
	return { ok: true, text, usage: message.usage };
};

/** `ask` for one line of memory. */
export const askLine = async (
	models: Models,
	model: ModelRef,
	request: { system: string; prompt: string; signal?: AbortSignal },
): Promise<Answer> => {
	const answer = await ask(models, model, request);
	return answer.ok ? { ...answer, text: fitEntry(answer.text) } : answer;
};
