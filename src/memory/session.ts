import type { Context } from "@earendil-works/chord";
import {
	type Conversation,
	defineTask,
	type EntryId,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type TaskId,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";

import { recordModelUsage } from "../agent/usage.ts";
import { announceSession } from "./announce.ts";
import { askLines, type Lines, PARALLEL_CALLS } from "./llm.ts";
import { backoffMs, ensureNapTask, isLive, napTaskLive } from "./nap.ts";
import {
	appendLeaves,
	clearMemory,
	type Leaf,
	MEMORY_FORMAT,
	MemoryIndex,
	type SessionRange,
} from "./store.ts";
import { readTranscript, type Transcript } from "./transcript.ts";
import { ENTRY_CHARS } from "./tree.ts";

// A session is one context of the main conversation, from one compaction
// to the next. When it ends, the small model reads it whole and writes its
// leaves: one line of memory per topic, all leading back to it. Nothing
// depends on the agent remembering to take notes.

/** The most of a session the model reads (~750k tokens); the middle is cut first. */
const MAX_TRANSCRIPT_CHARS = 2_500_000;

/** Lines one session may leave: a busy day holds many topics. */
const MAX_SESSION_LINES = 16;

type SessionInput = { model: ModelRef };

type SessionState =
	| { phase: "write"; written: number; attempt: number }
	| { phase: "backoff"; written: number; attempt: number; until: number };

const SYSTEM_PROMPT =
	"You keep the long-term memory of a personal assistant: one line per topic of " +
	"each past conversation with its user.";

const sessionPrompt = (transcript: string): string =>
	[
		`Write the long-term memory of this conversation of the assistant with its user: one line per topic, ` +
			`at most ${MAX_SESSION_LINES} lines of at most ${ENTRY_CHARS} characters each, for the assistant to recall it months later.`,
		"The assistant finds a past conversation only through these lines: what they leave out is lost " +
			"for good, while a topic named even in a few words leads back to the conversation, which keeps " +
			"the full detail. So give every topic with lasting effect a line, a minor one included, rather " +
			"than drop it; join small related topics when there are more than lines.",
		"Keep, most valuable first, also within a line: what the user asked for, decided or wants remembered, close to their " +
			"words; facts about the user and their life (people, places, plans, preferences, possessions); " +
			"work the assistant took on and where it stands (monitoring, schedules, follow-ups, open " +
			"questions); results. Copy the specifics that identify each topic exactly: names, places, " +
			"numbers, dates of plans. Never make anything look further along than it was.",
		"Of recurring work (monitoring, scheduled checks) keep the latest result, numbers included, " +
			"even when the user was not told of it: it is where that work stands. Drop small talk and " +
			"runs that read nothing. Invent nothing. Leave out when the " +
			"conversation took place; it is added for you. Write in the language of the conversation. " +
			"Reply with the lines alone, one per line, without bullets or numbers.",
		"",
		"<conversation>",
		transcript,
		"</conversation>",
	].join("\n");

const fit = (text: string): string => {
	if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
	const half = MAX_TRANSCRIPT_CHARS / 2;
	return `${text.slice(0, half)}\n[… middle of the conversation cut …]\n${text.slice(-half)}`;
};

/**
 * Starts writing leaves in `tx` when sessions wait and no task does it yet:
 * `live` is read before the transaction's first write (`isLive`).
 */
const ensureSessionTask = async (
	tx: Tx,
	model: ModelRef,
	live: boolean,
): Promise<void> => {
	const index = await tx.doc(MemoryIndex);
	if (index.queue.length === 0) return;
	if (live) return;
	index.sessionTaskId = await tx.createTask(
		SessionTask,
		{ model },
		{
			ownership: { kind: "conversation" },
			conversationId: ROOT_CONVERSATION_ID,
			background: true,
		},
	);
};

// Whether the user said anything after entry `after`: a session needs input.
const hasInput = async (tx: Tx, after: number): Promise<boolean> => {
	let cursor: Parameters<Tx["scanEntries"]>[2];
	do {
		const page = await tx.scanEntries(
			{
				conversationId: ROOT_CONVERSATION_ID,
				minEntryId: (after + 1) as EntryId,
			},
			100,
			cursor,
		);
		if (page.items.some((entry) => entry.kind === UserEntry.kind)) return true;
		cursor = page.next;
	} while (cursor !== undefined);
	return false;
};

/**
 * Ends the current session in `tx`: everything since the last one is queued
 * for its leaf. False when nothing was said, so there is no session to end.
 */
const closeSession = async (tx: Tx, model: ModelRef): Promise<boolean> => {
	const index = await tx.doc(MemoryIndex);
	const live = await isLive(tx, index.sessionTaskId);
	if (!(await hasInput(tx, index.closedTo))) return false;
	const tail = (
		await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)
	).items[0];
	if (tail === undefined) return false;
	index.queue.push({ from: index.closedTo + 1, to: tail.id });
	index.closedTo = tail.id;
	await ensureSessionTask(tx, model, live);
	return true;
};

/**
 * Compacts the conversation: ends the session and starts a new context, which
 * reads the memory afresh.
 */
export const compact = async (
	conversation: Conversation,
	model: ModelRef,
	context: Context,
): Promise<void> => {
	if (await conversation.commit((tx) => closeSession(tx, model), context)) {
		await conversation.reset(undefined, context);
	}
};

/**
 * Writes a memory kept in an older `MEMORY_FORMAT` again, from its sessions'
 * transcripts. Put off to a later start while a writer is live, so none
 * mixes the two formats.
 */
export const rewriteOutdated = async (
	conversation: Conversation,
	model: ModelRef,
	context: Context,
): Promise<void> => {
	await conversation.commit(async (tx) => {
		const index = await tx.doc(MemoryIndex);
		if ((index.format ?? 1) >= MEMORY_FORMAT) return;
		const live =
			(await isLive(tx, index.sessionTaskId)) || (await napTaskLive(tx));
		if (live) return;
		await clearMemory(tx);
		await ensureSessionTask(tx, model, false);
	}, context);
};

const sameRange = (a: SessionRange | undefined, b: SessionRange) =>
	a !== undefined && a.from === b.from && a.to === b.to;

const continueOrFinish = async (tx: Tx, taskId: TaskId, next: SessionState) => {
	const index = await tx.doc(MemoryIndex);
	if (index.queue.length > 0) {
		return { status: "running", checkpoint: next } as const;
	}
	if (index.sessionTaskId === taskId) index.sessionTaskId = null;
	return {
		status: "terminal",
		outcome: { status: "completed", result: null },
	} as const;
};

export const SessionTask = defineTask<SessionInput, SessionState, null>({
	name: "memory.session",
	version: 1,

	initial: () => ({ phase: "write", written: 0, attempt: 1 }),

	phases: {
		write: async (task, runtime, context) => {
			const { written, attempt } = task.state.checkpoint;
			const index = await runtime.snapshot(MemoryIndex, context);
			const batch = index?.queue.slice(0, PARALLEL_CALLS) ?? [];
			if (batch.length === 0) {
				await runtime.commit(
					(tx) =>
						continueOrFinish(tx, task.id, { phase: "write", written, attempt }),
					context,
				);
				return;
			}

			const transcripts: Transcript[] = [];
			await runtime.commit(async (tx) => {
				transcripts.length = 0;
				for (const range of batch) {
					transcripts.push(await readTranscript(tx, range.from, range.to));
				}
				return undefined;
			}, context);

			// Sessions are written side by side and kept in order. A session where
			// nothing was said leaves no line.
			const answers: (Lines | undefined)[] = await Promise.all(
				transcripts.map((transcript) =>
					transcript.text.length === 0
						? undefined
						: askLines(
								runtime.models,
								task.input.model,
								{
									system: SYSTEM_PROMPT,
									prompt: sessionPrompt(fit(transcript.text)),
									signal: runtime.signal,
								},
								MAX_SESSION_LINES,
							),
				),
			);
			runtime.signal.throwIfAborted();
			for (const answer of answers) {
				if (answer?.ok === false) {
					runtime.report(new Error(`Session summary failed: ${answer.error}`));
				}
			}
			// A failed session and the ones after it wait for the retry.
			const failed = answers.findIndex((answer) => answer?.ok === false);
			const done = failed < 0 ? batch.length : failed;

			let added: Leaf[][] = [];
			await runtime.commit(async (tx) => {
				added = [];
				const napLive = await napTaskLive(tx);
				for (const answer of answers) {
					await recordModelUsage(
						tx,
						`${task.input.model.provider}/${task.input.model.modelId}`,
						answer?.usage,
					);
				}
				const current = await tx.doc(MemoryIndex);
				for (let i = 0; i < done; i++) {
					const range = batch[i];
					if (!sameRange(current.queue[0], range)) break;
					const answer = answers[i];
					if (answer?.ok) {
						added.push(
							await appendLeaves(
								tx,
								{
									from: range.from,
									to: range.to,
									start: transcripts[i].start ?? "",
									end: transcripts[i].end ?? "",
								},
								answer.lines,
							),
						);
					}
					current.queue.shift();
				}
				if (added.length > 0) {
					await ensureNapTask(tx, task.input.model, napLive);
				}
				if (failed >= 0) {
					return {
						status: "running",
						checkpoint: {
							phase: "backoff",
							written: written + done,
							attempt,
							until: runtime.now() + backoffMs(attempt),
						},
					};
				}
				return continueOrFinish(tx, task.id, {
					phase: "write",
					written: written + done,
					attempt: 1,
				});
			}, context);
			// A session written again was announced when it ended.
			for (const leaves of added) {
				if (leaves[0].to > (index?.rewrittenTo ?? 0)) announceSession(leaves);
			}
		},

		backoff: async (task, runtime, context) => {
			const { written, attempt, until } = task.state.checkpoint;
			await runtime.sleep(until, context);
			await runtime.commit(
				() => ({
					status: "running",
					checkpoint: { phase: "write", written, attempt: attempt + 1 },
				}),
				context,
			);
		},
	},

	abort: (task, runtime, context) =>
		runtime.commit(async (tx) => {
			const index = await tx.doc(MemoryIndex);
			if (index.sessionTaskId === task.id) index.sessionTaskId = null;
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context),
});
