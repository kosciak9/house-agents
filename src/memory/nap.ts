import type { Context } from "@earendil-works/chord";
import {
	defineTask,
	type ModelRef,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";

import { askLine } from "./llm.ts";
import {
	formatLeaf,
	formatSummary,
	MemoryIndex,
	type MemoryReader,
	openMemory,
	putSummary,
} from "./store.ts";
import { type Block, ENTRY_BYTES, nextPending } from "./tree.ts";

// Merging runs in the background, in code: whenever two lines of a level
// exist, they are merged into one line of the level above. One task at a time
// works through every pending block, smallest first, and ends once none is
// left.

type NapInput = { model: ModelRef };

type NapState =
	| { phase: "merge"; merged: number; attempt: number }
	| { phase: "backoff"; merged: number; attempt: number; until: number };

const SYSTEM_PROMPT =
	"You keep the long-term memory of a personal assistant: one line per past " +
	"conversation with its user, and lines merging two neighbouring lines into one.";

export const backoffMs = (attempt: number): number =>
	Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (attempt - 1));

/** Starts merging in `tx` when something is pending and no task does it yet. */
export const ensureNapTask = async (tx: Tx, model: ModelRef): Promise<void> => {
	const index = await tx.doc(MemoryIndex);
	if (nextPending(index.count, index.levels) === undefined) return;
	if (index.napTaskId !== null) {
		const task = await tx.task(index.napTaskId as TaskId);
		if (task !== undefined && task.state.status !== "terminal") return;
	}
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
		`Merge these two lines of memory into one line of at most ${ENTRY_BYTES} bytes.`,
		"Keep what has lasting effect: facts about the user and their life, decisions, " +
			"results, plans. Drop what does not. Invent nothing. Leave out ids and dates; " +
			"they are added for you. Write in the language of the lines. Reply with the line alone.",
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
			const next: NapState = { phase: "merge", merged: merged + 1, attempt: 1 };
			const memory = await openMemory(runtime, context);
			const block = nextPending(memory.count, memory.levels);
			if (block === undefined) {
				await runtime.commit(
					(tx) => continueOrFinish(tx, task.id, next),
					context,
				);
				return;
			}

			const answer = await askLine(runtime.models, task.input.model, {
				system: SYSTEM_PROMPT,
				prompt: mergePrompt(await halves(memory, block)),
				signal: runtime.signal,
			});
			runtime.signal.throwIfAborted();
			if (!answer.ok) {
				runtime.report(new Error(`Memory merge failed: ${answer.error}`));
			}

			await runtime.commit(async (tx) => {
				if (!answer.ok) {
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
				await putSummary(tx, block, answer.text);
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
