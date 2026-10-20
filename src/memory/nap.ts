import type { Context } from "@earendil-works/chord";
import {
	defineTask,
	type ModelRef,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";

import { recordModelUsage } from "../agent/usage.ts";
import { askLines, PARALLEL_CALLS } from "./llm.ts";
import {
	formatLeaf,
	formatSummary,
	MemoryIndex,
	type MemoryReader,
	openMemory,
	putSummary,
} from "./store.ts";
import { type Block, ENTRY_CHARS, nextPending, readyBlocks } from "./tree.ts";

// Merging runs in the background, in code: whenever two lines of a level
// exist, they are merged into one line of the level above. One task at a time
// works through every pending block, smallest first, merging the ready ones
// side by side, and ends once none is left.

type NapInput = { model: ModelRef };

type NapState =
	| { phase: "merge"; merged: number; attempt: number }
	| { phase: "backoff"; merged: number; attempt: number; until: number };

const SYSTEM_PROMPT =
	"You keep the long-term memory of a personal assistant: one line per topic of " +
	"each past conversation with its user, and lines merging two neighbouring lines into one.";

export const backoffMs = (attempt: number): number =>
	Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (attempt - 1));

/**
 * Whether task `id` may still run. A transaction reads tasks only before its
 * first write, so callers ask this up front.
 */
export const isLive = async (tx: Tx, id: number | null): Promise<boolean> => {
	if (id === null) return false;
	const task = await tx.task(id as TaskId);
	return task !== undefined && task.state.status !== "terminal";
};

/** Whether the task writing summaries may still run; see `isLive`. */
export const napTaskLive = async (tx: Tx): Promise<boolean> =>
	isLive(tx, (await tx.doc(MemoryIndex)).napTaskId);

/**
 * Starts merging in `tx` when something is pending and no task does it yet:
 * `live` is `napTaskLive` read before the transaction's first write.
 */
export const ensureNapTask = async (
	tx: Tx,
	model: ModelRef,
	live: boolean,
): Promise<void> => {
	const index = await tx.doc(MemoryIndex);
	if (nextPending(index.count, index.levels) === undefined) return;
	if (live) return;
	index.napTaskId = await tx.createTask(
		NapTask,
		{ model },
		{ ownership: { kind: "conversation" }, background: true },
	);
};

// Ends the task, unless a leaf added meanwhile made more work.
const continueOrFinish = async (tx: Tx, taskId: TaskId, next: NapState) => {
	const index = await tx.doc(MemoryIndex);
	if (nextPending(index.count, index.levels) !== undefined) {
		return { status: "running", checkpoint: next } as const;
	}
	if (index.napTaskId === taskId) index.napTaskId = null;
	return {
		status: "terminal",
		outcome: { status: "completed", result: null },
	} as const;
};

// The two lines a block merges: two leaves, or two summaries.
const halves = async (
	memory: MemoryReader,
	block: Block,
): Promise<string[]> => {
	if (block.hi - block.lo === 2) {
		return (await memory.leaves(block.lo, block.hi)).map(formatLeaf);
	}
	const mid = (block.lo + block.hi) / 2;
	const lines: string[] = [];
	for (const half of [
		{ lo: block.lo, hi: mid },
		{ lo: mid, hi: block.hi },
	]) {
		const summary = await memory.summary(half);
		if (summary === undefined) {
			throw new Error(`The summary of ${half.lo}-${half.hi - 1} is missing`);
		}
		lines.push(formatSummary(half, await memory.span(half), summary));
	}
	return lines;
};

const mergePrompt = (lines: readonly string[]): string =>
	[
		`Merge these two lines of memory into one line of at most ${ENTRY_CHARS} characters.`,
		"The assistant finds a past conversation only by zooming through such lines: a topic " +
			"the merged line leaves out cannot be found again, while one named in a word or two " +
			"still leads to it. So name more topics briefly rather than fewer in detail. Keep what " +
			"has lasting effect: facts about the user and their life, decisions, plans and work " +
			"still open; drop first what is finished or routine. Invent nothing. Leave out ids and " +
			"when the conversations took place; they are added for you. Write in the language of " +
			"the lines. Reply with the line alone.",
		"",
		...lines,
	].join("\n");

export const NapTask = defineTask<NapInput, NapState, null>({
	name: "memory.nap",
	version: 1,

	initial: () => ({ phase: "merge", merged: 0, attempt: 1 }),

	phases: {
		merge: async (task, runtime, context: Context) => {
			const { merged, attempt } = task.state.checkpoint;
			const memory = await openMemory(runtime, context);
			const blocks = readyBlocks(memory.count, memory.levels, PARALLEL_CALLS);
			const next: NapState = {
				phase: "merge",
				merged: merged + blocks.length,
				attempt: 1,
			};
			if (blocks.length === 0) {
				await runtime.commit(
					(tx) => continueOrFinish(tx, task.id, next),
					context,
				);
				return;
			}

			const answers = await Promise.all(
				blocks.map(async (block) =>
					askLines(
						runtime.models,
						task.input.model,
						{
							system: SYSTEM_PROMPT,
							prompt: mergePrompt(await halves(memory, block)),
							signal: runtime.signal,
						},
						1,
					),
				),
			);
			runtime.signal.throwIfAborted();
			for (const answer of answers) {
				if (!answer.ok) {
					runtime.report(new Error(`Memory merge failed: ${answer.error}`));
				}
			}

			await runtime.commit(async (tx) => {
				// Merged from a memory since rewritten: start over from the new one.
				if (((await tx.doc(MemoryIndex)).format ?? 1) !== memory.format) {
					return continueOrFinish(tx, task.id, { ...next, merged });
				}
				for (const answer of answers) {
					await recordModelUsage(
						tx,
						`${task.input.model.provider}/${task.input.model.modelId}`,
						answer.usage,
					);
				}
				// In order: a level's block after a failed one is not stored.
				for (const [i, block] of blocks.entries()) {
					const answer = answers[i];
					if (answer.ok) await putSummary(tx, block, answer.lines[0]);
				}
				if (answers.some((answer) => !answer.ok)) {
					return {
						status: "running",
						checkpoint: {
							phase: "backoff",
							merged,
							attempt,
							until: runtime.now() + backoffMs(attempt),
						},
					};
				}
				return continueOrFinish(tx, task.id, next);
			}, context);
		},

		backoff: async (task, runtime, context) => {
			const { merged, attempt, until } = task.state.checkpoint;
			await runtime.sleep(until, context);
			await runtime.commit(
				() => ({
					status: "running",
					checkpoint: { phase: "merge", merged, attempt: attempt + 1 },
				}),
				context,
			);
		},
	},

	abort: (task, runtime, context) =>
		runtime.commit(async (tx) => {
			const index = await tx.doc(MemoryIndex);
			if (index.napTaskId === task.id) index.napTaskId = null;
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context),
});
