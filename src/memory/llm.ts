import type {
	AssistantMessage,
	Models,
	ThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

import { addUsage, emptyUsage } from "../agent/usage.ts";
import { ENTRY_BYTES, fitEntry } from "./tree.ts";

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
	request: {
		system: string;
		prompt: string;
		signal?: AbortSignal;
		reasoning?: ThinkingLevel;
	},
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
		{
			signal: request.signal,
			cacheRetention: "none",
			...(request.reasoning && { reasoning: request.reasoning }),
		},
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

export type Lines =
	| { ok: true; lines: string[]; usage: Usage }
	| { ok: false; error: string; usage?: Usage };

/** Attempts to shorten an overlong line before it is cut. */
const SHORTEN_ATTEMPTS = 3;

const SHORTEN_SYSTEM_PROMPT =
	"You keep the long-term memory of a personal assistant, in lines of limited length.";

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

// The model misjudges lengths: it is asked to remove whole parts, by a share
// with room to spare, rather than to reach a count.
const shortenPrompt = (line: string): string => {
	const share = Math.min(
		60,
		Math.ceil((100 * (byteLength(line) - ENTRY_BYTES)) / byteLength(line)) + 10,
	);
	return [
		`This line of memory is too long: rewrite it ${share}% shorter.`,
		"Remove whole clauses, the least valuable first, rather than shorten every word; keep " +
			"every topic named. Invent nothing. Write in the language of the line. Reply with the " +
			"line alone.",
		"",
		line,
	].join("\n");
};

// A line still over the limit loses its last clauses, the least valuable as
// the prompts ask, before a cut mid-word.
const dropClauses = (line: string): string => {
	let kept = line;
	while (byteLength(kept) > ENTRY_BYTES) {
		const end = Math.max(kept.lastIndexOf(". "), kept.lastIndexOf("; "));
		if (end < 0 || byteLength(kept.slice(0, end)) < ENTRY_BYTES / 2) break;
		kept = kept.slice(0, end + 1);
	}
	return kept === line ? line : `${kept} …`;
};

const cleanLine = (text: string): string =>
	text
		.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * `ask` for at most `max` lines of memory, one per line of the answer. A line
 * over `ENTRY_BYTES` is asked to be shortened, and cut only if it stays over.
 */
export const askLines = async (
	models: Models,
	model: ModelRef,
	request: { system: string; prompt: string; signal?: AbortSignal },
	max: number,
): Promise<Lines> => {
	const answer = await ask(models, model, request);
	if (!answer.ok) return answer;
	const usage = emptyUsage();
	addUsage(usage, answer.usage);

	const drafts = (max === 1 ? [answer.text] : answer.text.split("\n"))
		.map(cleanLine)
		.filter((line) => line.length > 0)
		.slice(0, max);
	const lines: string[] = [];
	for (const draft of drafts) {
		let line = draft;
		for (
			let attempt = 0;
			attempt < SHORTEN_ATTEMPTS && byteLength(line) > ENTRY_BYTES;
			attempt++
		) {
			const shorter = await ask(models, model, {
				system: SHORTEN_SYSTEM_PROMPT,
				prompt: shortenPrompt(line),
				signal: request.signal,
				// Without it the model barely shortens the line.
				reasoning: "medium",
			});
			if (shorter.usage) addUsage(usage, shorter.usage);
			if (!shorter.ok) return { ...shorter, usage };
			const candidate = cleanLine(shorter.text);
			if (byteLength(candidate) < byteLength(line)) line = candidate;
		}
		lines.push(fitEntry(dropClauses(line)));
	}
	if (lines.length === 0) return { ok: false, error: "empty answer", usage };
	return { ok: true, lines, usage };
};
