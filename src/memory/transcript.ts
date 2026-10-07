import type { Message } from "@earendil-works/pi-ai";
import {
	type EntryId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
	type Tx,
} from "@earendil-works/pi-durable";

// A session of the main conversation as plain text, for the small model that
// summarizes it or answers questions about it. Entries stay in storage after
// a compaction, so a session can be read back at any time.

const TOOL_CALL_CHARS = 500;
const TOOL_RESULT_CHARS = 3_000;
const PAGE = 100;

const clip = (value: string, max: number): string =>
	value.length <= max ? value : `${value.slice(0, max)}… [cut]`;

const time = (timestamp: number): string =>
	`[${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")}] `;

const renderMessage = (message: Message): string[] => {
	switch (message.role) {
		case "user": {
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.map((part) => (part.type === "text" ? part.text : "[image]"))
							.join(" ");
			return [`${time(message.timestamp)}User: ${content}`];
		}
		case "assistant":
			return message.content.flatMap((part) => {
				if (part.type === "text") {
					return [`${time(message.timestamp)}Assistant: ${part.text}`];
				}
				if (part.type === "toolCall") {
					const args = clip(JSON.stringify(part.arguments), TOOL_CALL_CHARS);
					return [`Assistant called ${part.name} ${args}`];
				}
				return [];
			});
		case "toolResult": {
			const result = message.content
				.map((part) => (part.type === "text" ? part.text : "[image]"))
				.join(" ");
			const outcome = message.isError ? "failed" : "returned";
			return [
				`Tool ${message.toolName} ${outcome}: ${clip(result, TOOL_RESULT_CHARS)}`,
			];
		}
		default:
			return [];
	}
};

// Prompts are not part of what was said.
const renderEntry = (entry: EntryRecord): string[] =>
	entry.kind === "pi.system" ? [] : (entry.model ?? []).flatMap(renderMessage);

const dateOf = (timestamp: number): string =>
	new Date(timestamp).toLocaleDateString("sv-SE");

export type Transcript = {
	text: string;
	/** Dates of the first and last message; undefined when nothing was said. */
	start?: string;
	end?: string;
};

/** The main conversation's entries `from` to `to`, inclusive, as text. */
export const readTranscript = async (
	tx: Tx,
	from: number,
	to: number,
): Promise<Transcript> => {
	const entries: EntryRecord[] = [];
	let cursor: Parameters<Tx["scanEntries"]>[2];
	do {
		const page = await tx.scanEntries(
			{
				conversationId: ROOT_CONVERSATION_ID,
				minEntryId: from as EntryId,
				maxEntryId: to as EntryId,
			},
			PAGE,
			cursor,
		);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	entries.reverse();

	const timestamps = entries
		.flatMap((entry) => (entry.kind === "pi.system" ? [] : (entry.model ?? [])))
		.flatMap((message) =>
			message.role === "system" ? [] : [message.timestamp],
		);
	const lines = entries.flatMap(renderEntry);
	return {
		text: lines.join("\n"),
		...(lines.length > 0 && timestamps.length > 0
			? {
					start: dateOf(Math.min(...timestamps)),
					end: dateOf(Math.max(...timestamps)),
				}
			: {}),
	};
};
