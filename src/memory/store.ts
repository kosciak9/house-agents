import { createHash } from "node:crypto";

import type { Context } from "@earendil-works/chord";
import {
	type DocumentReader,
	defineDoc,
	defineDocFamily,
	type Tx,
} from "@earendil-works/pi-durable";

import { type Block, formatBlock, type Levels } from "./tree.ts";

// The memory belongs to the agent, not to a conversation, so it lives in
// Session documents. Leaves and summaries are stored in fixed-size pages, so
// adding one never rewrites the whole log.

/** One topic of a past session of the main conversation, in one line. */
type StoredLeaf = {
	/**
	 * Shared by the lines of one session. Hard to guess, so the agent reaches
	 * a session only by zooming to it.
	 */
	session: string;
	/** Its transcript entries, inclusive. */
	from: number;
	to: number;
	/** Dates of its first and last message. */
	start: string;
	end: string;
	text: string;
};

export type Leaf = StoredLeaf & { id: number };

/** Transcript entries handed to the summarizer, oldest first. */
export type SessionRange = { from: number; to: number };

const PAGE_SIZE = 256;

/**
 * How sessions become lines. A memory written the older way is written again
 * from its transcripts (`rewriteOutdated`).
 */
export const MEMORY_FORMAT = 3;

export type MemoryIndexState = {
	/** `MEMORY_FORMAT` the leaves were written in; absent before the first. */
	format?: number;
	/** Leaves so far; the next one gets this id. */
	count: number;
	/** Summaries written per block size; each level is a dense prefix. */
	levels: Record<string, number>;
	/** Last transcript entry already handed to a session. */
	closedTo: number;
	/** Ended sessions waiting for their leaf, oldest first. */
	queue: SessionRange[];
	/** The task writing leaves, while one may still be live. */
	sessionTaskId: number | null;
	/** The task writing summaries, while one may still be live. */
	napTaskId: number | null;
};

export const MemoryIndex = defineDoc<MemoryIndexState>({
	kind: "memory.index",
	version: 1,
	scope: "session",
	initial: () => ({
		format: MEMORY_FORMAT,
		count: 0,
		levels: {},
		closedTo: 0,
		queue: [],
		sessionTaskId: null,
		napTaskId: null,
	}),
});

const LeafPages = defineDocFamily<{ leaves: StoredLeaf[] }, null>({
	kind: "memory.leaves",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ leaves: [] }),
});

const SummaryPages = defineDocFamily<{ summaries: string[] }, null>({
	kind: "memory.tree",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ summaries: [] }),
});

const leafPage = (id: number) => String(Math.floor(id / PAGE_SIZE));

// The k-th summary of blocks sized `size`.
const summaryAddress = (block: Block) => {
	const size = block.hi - block.lo;
	const k = block.lo / size;
	return {
		key: `${size}:${Math.floor(k / PAGE_SIZE)}`,
		offset: k % PAGE_SIZE,
	};
};

const dates = (start: string, end: string): string =>
	start === end ? start : `${start}…${end}`;

export const formatLeaf = (leaf: Leaf): string =>
	`[${leaf.session}] ${dates(leaf.start, leaf.end)} ${leaf.text}`;

export const formatSummary = (
	block: Block,
	span: { start: string; end: string },
	summary: string,
): string => `${formatBlock(block)} ${dates(span.start, span.end)} ${summary}`;

export type MemoryReader = {
	/** `MEMORY_FORMAT` of what was read; work from an older one is not stored. */
	readonly format: number;
	readonly count: number;
	readonly levels: Levels;
	readonly queue: readonly SessionRange[];
	/** Last transcript entry already handed to a session. */
	readonly closedTo: number;
	leaves(lo: number, hi: number): Promise<Leaf[]>;
	summary(block: Block): Promise<string | undefined>;
	/** First and last date a block covers. */
	span(block: Block): Promise<{ start: string; end: string }>;
};

/** Reads the committed memory; pages are read once per reader. */
export const openMemory = async (
	reader: DocumentReader,
	context: Context,
): Promise<MemoryReader> => {
	const index =
		(await reader.snapshot(MemoryIndex, context)) ??
		MemoryIndex.definition.initial();
	const pages = new Map<string, Promise<readonly StoredLeaf[]>>();
	const summaryPages = new Map<string, Promise<readonly string[]>>();

	const page = (key: string) => {
		let found = pages.get(key);
		if (!found) {
			found = reader
				.snapshot(LeafPages, key, context)
				.then((doc) => doc?.leaves ?? []);
			pages.set(key, found);
		}
		return found;
	};

	const summaryPage = (key: string) => {
		let found = summaryPages.get(key);
		if (!found) {
			found = reader
				.snapshot(SummaryPages, key, context)
				.then((doc) => doc?.summaries ?? []);
			summaryPages.set(key, found);
		}
		return found;
	};

	const leaves = async (lo: number, hi: number) => {
		const out: Leaf[] = [];
		for (let id = lo; id < Math.min(hi, index.count); id++) {
			const stored = (await page(leafPage(id)))[id % PAGE_SIZE];
			if (stored) out.push({ id, ...stored });
		}
		return out;
	};

	return {
		format: index.format ?? 1,
		count: index.count,
		levels: index.levels,
		queue: index.queue,
		closedTo: index.closedTo,
		leaves,

		summary: async (block) => {
			const { key, offset } = summaryAddress(block);
			return (await summaryPage(key))[offset];
		},

		span: async (block) => {
			const [first] = await leaves(block.lo, block.lo + 1);
			const [last] = await leaves(block.hi - 1, block.hi);
			return { start: first?.start ?? "", end: last?.end ?? "" };
		},
	};
};

/** Appends the lines of one session in `tx`, one leaf each, under one id. */
export const appendLeaves = async (
	tx: Tx,
	session: Omit<StoredLeaf, "session" | "text">,
	lines: readonly string[],
): Promise<void> => {
	const index = await tx.doc(MemoryIndex);
	const id = createHash("sha256")
		.update(`${index.count}:${session.from}:${session.to}`)
		.digest("hex")
		.slice(0, 8);
	for (const text of lines) {
		(await tx.doc(LeafPages, leafPage(index.count), null)).leaves.push({
			session: id,
			...session,
			text,
		});
		index.count += 1;
	}
};

/**
 * Empties the memory in `tx` and queues every session it held, to be written
 * again in `MEMORY_FORMAT`. Skills follow, as they point at transcript
 * entries, not at lines.
 */
export const clearMemory = async (tx: Tx): Promise<void> => {
	const index = await tx.doc(MemoryIndex);
	const sessions: SessionRange[] = [];
	for (let page = 0; page * PAGE_SIZE < index.count; page++) {
		const doc = await tx.doc(LeafPages, String(page), null);
		for (const { from, to } of doc.leaves) {
			const last = sessions.at(-1);
			if (last?.from !== from || last.to !== to) sessions.push({ from, to });
		}
		doc.leaves = [];
	}
	for (const [size, done] of Object.entries(index.levels)) {
		for (let page = 0; page * PAGE_SIZE < done; page++) {
			(await tx.doc(SummaryPages, `${size}:${page}`, null)).summaries = [];
		}
	}
	index.format = MEMORY_FORMAT;
	index.count = 0;
	index.levels = {};
	index.queue = [...sessions, ...index.queue];
};

/**
 * Stores the summary of `block` in `tx`, unless it is no longer the next of
 * its level: blocks are summarized in order.
 */
export const putSummary = async (
	tx: Tx,
	block: Block,
	summary: string,
): Promise<boolean> => {
	const index = await tx.doc(MemoryIndex);
	const size = block.hi - block.lo;
	const done = index.levels[size] ?? 0;
	if (block.lo / size !== done) return false;

	const { key } = summaryAddress(block);
	(await tx.doc(SummaryPages, key, null)).summaries.push(summary);
	index.levels[size] = done + 1;
	return true;
};
