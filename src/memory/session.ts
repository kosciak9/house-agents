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

import { askLine } from "./llm.ts";
import { backoffMs, ensureNapTask } from "./nap.ts";
import { appendLeaf, MemoryIndex, type SessionRange } from "./store.ts";
import { readTranscript, type Transcript } from "./transcript.ts";
import { ENTRY_BYTES } from "./tree.ts";

// A session is one context of the main conversation, from one compaction
// to the next. When it ends, the small model reads it whole and writes its leaf: the
// one line of memory the agent keeps of it. Nothing depends on the agent
// remembering to take notes.

/** The most of a session the model reads (~750k tokens); the middle is cut first. */
const MAX_TRANSCRIPT_CHARS = 2_500_000;

type SessionInput = { model: ModelRef };

type SessionState =
	| { phase: "write"; written: number; attempt: number }
	| { phase: "backoff"; written: number; attempt: number; until: number };

const SYSTEM_PROMPT =
	"You keep the long-term memory of a personal assistant: one line per past " +
	"conversation with its user.";

const sessionPrompt = (transcript: string): string =>
	[
		`Summarize this conversation of the assistant with its user in one line of at most ${ENTRY_BYTES} bytes, ` +
			"for the assistant to recall it months later.",
		"Keep what has lasting effect: facts about the user and their life (people, places, plans, " +
			"preferences, possessions), what they asked to remember, decisions, tasks done and their results. " +
			"Name the specifics that identify each topic (names, places, numbers), so the line leads back to " +
			"the conversation, which keeps the full detail. Drop small talk. Invent nothing. Leave out dates; " +
			"they are added for you. Write in the language of the conversation. Reply with the line alone.",
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

/** Starts writing leaves in `tx` when sessions wait and no task does it yet. */
const ensureSessionTask = async (tx: Tx, model: ModelRef): Promise<void> => {
	const index = await tx.doc(MemoryIndex);
	if (index.queue.length === 0) return;
	if (index.sessionTaskId !== null) {
		const task = await tx.task(index.sessionTaskId as TaskId);
		if (task !== undefined && task.state.status !== "terminal") return;
	}
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
	if (!(await hasInput(tx, index.closedTo))) return false;
	const tail = (
		await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)
	).items[0];
	if (tail === undefined) return false;
	index.queue.push({ from: index.closedTo + 1, to: tail.id });
	index.closedTo = tail.id;
	await ensureSessionTask(tx, model);
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
			const next: SessionState = {
				phase: "write",
				written: written + 1,
				attempt: 1,
			};
			const index = await runtime.snapshot(MemoryIndex, context);
			const range = index?.queue[0];
			if (range === undefined) {
				await runtime.commit(
					(tx) => continueOrFinish(tx, task.id, next),
					context,
				);
				return;
			}

			let transcript: Transcript = { text: "" };
			await runtime.commit(async (tx) => {
				transcript = await readTranscript(tx, range.from, range.to);
				return undefined;
			}, context);

			// A session where nothing was said leaves no line.
			const answer =
				transcript.text.length === 0
					? undefined
					: await askLine(runtime.models, task.input.model, {
							system: SYSTEM_PROMPT,
							prompt: sessionPrompt(fit(transcript.text)),
							signal: runtime.signal,
						});
			runtime.signal.throwIfAborted();
			if (answer?.ok === false) {
				runtime.report(new Error(`Session summary failed: ${answer.error}`));
			}

			await runtime.commit(async (tx) => {
				if (answer?.ok === false) {
					return {
						status: "running",
						checkpoint: {
							phase: "backoff",
							written,
							attempt,
							until: runtime.now() + backoffMs(attempt),
						},
					};
				}
				const current = await tx.doc(MemoryIndex);
				if (sameRange(current.queue[0], range)) {
					if (answer?.ok) {
						await appendLeaf(tx, {
							from: range.from,
							to: range.to,
							start: transcript.start ?? "",
							end: transcript.end ?? "",
							text: answer.text,
						});
						await ensureNapTask(tx, task.input.model);
					}
					current.queue.shift();
				}
				return continueOrFinish(tx, task.id, next);
			}, context);
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
