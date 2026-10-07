import type { Context } from "@earendil-works/chord";
import type { DocumentReader } from "@earendil-works/pi-durable";

import {
	formatLeaf,
	formatSummary,
	type MemoryReader,
	openMemory,
} from "./store.ts";
import { type Block, cover, isSummarized } from "./tree.ts";

/** Lines of memory the agent reads at the start of every context (~8k tokens). */
const WAKE_LINES = 96;

/** How long a new context waits for the leaves of the sessions just ended. */
const LEAF_WAIT_MS = 2 * 60 * 1000;
const LEAF_POLL_MS = 500;

// A block whose summary is not written yet is shown as its halves, down to
// the leaves themselves: reading the memory never waits for merging.
export const blockLines = async (
	memory: MemoryReader,
	block: Block,
): Promise<string[]> => {
	if (block.hi - block.lo === 1) {
		return (await memory.leaves(block.lo, block.hi)).map(formatLeaf);
	}
	const summary = isSummarized(block, memory.levels)
		? await memory.summary(block)
		: undefined;
	if (summary !== undefined) {
		return [formatSummary(block, await memory.span(block), summary)];
	}

	const mid = (block.lo + block.hi) / 2;
	return [
		...(await blockLines(memory, { lo: block.lo, hi: mid })),
		...(await blockLines(memory, { lo: mid, hi: block.hi })),
	];
};

// A new context starts once the sessions before it have their leaves, so it
// remembers all of them.
const settledMemory = async (
	reader: DocumentReader,
	context: Context,
): Promise<MemoryReader> => {
	const deadline = Date.now() + LEAF_WAIT_MS;
	for (;;) {
		const memory = await openMemory(reader, context);
		if (memory.queue.length === 0 || Date.now() >= deadline) return memory;
		await new Promise((resolve) => setTimeout(resolve, LEAF_POLL_MS));
	}
};

/** The memory as the agent reads it: recent sessions one by one, older ones merged. */
export const renderWake = async (
	reader: DocumentReader,
	context: Context,
): Promise<string> => {
	const memory = await settledMemory(reader, context);
	const lines: string[] = [];
	for (const block of cover(memory.count, WAKE_LINES)) {
		lines.push(...(await blockLines(memory, block)));
	}

	return [
		"<memory>",
		memory.count === 0
			? "Your long-term memory is empty: this is your first conversation with the user."
			: `Your long-term memory: one line per past conversation with the user, oldest first, ${memory.count} so far.`,
		"Each conversation ended with a compaction, which is why you do not see it; this one will be remembered the same way.",
		"`[session] dates text` is one past conversation. `#a-b dates text` merges conversations a to b; " +
			"memory_zoom opens it into its two halves. Zoom down to the conversation you need, then " +
			"memory_ask answers questions about it from its full transcript.",
		...(lines.length > 0 ? ["", ...lines] : []),
		"</memory>",
	].join("\n");
};
