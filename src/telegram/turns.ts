import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { UserInput } from "@earendil-works/pi-durable";

import { root } from "../agent/harness.ts";
import { userSpoke } from "../memory/keeper.ts";
import { bot, chatId } from "./bot.ts";
import { startProgress, stopProgress } from "./progress.ts";
import { setReplyTarget } from "./reply-target.ts";
import { whileTyping } from "./typing.ts";

// What the chat sends within this long of the last message reaches the agent
// as one input: a thought split over a few messages gets one answer.
const DEBOUNCE_MS = 3_000;

type Incoming = {
	messageId: number;
	/** Read as soon as it comes, e.g. a voice message's transcript. */
	content: Promise<UserInput | undefined>;
};

/** The content as a list of parts, e.g. to put more parts before it. */
export const parts = (content: UserInput): Exclude<UserInput, string> =>
	typeof content === "string" ? [{ type: "text", text: content }] : content;

const submit = async (messageId: number, content: UserInput): Promise<void> => {
	setReplyTarget(messageId);
	startProgress(messageId);
	userSpoke();

	try {
		const submission = await root.submit(
			{ type: "input", content },
			BACKGROUND_CONTEXT,
		);

		const settled = await submission.wait(BACKGROUND_CONTEXT);

		// An input /compact cut short needs no word; any other one left unanswered
		// tells the chat why, e.g. that no model it can use is logged in.
		if (settled.status === "unanswered" && settled.reason !== "aborted") {
			const why =
				typeof settled.detail === "string" ? settled.detail : settled.reason;
			await bot.api.sendMessage(chatId, `⚠️ Nie udało się odpowiedzieć: ${why}`);
		}
	} finally {
		stopProgress();
	}
};

const submitBatch = async (batch: Incoming[]): Promise<void> => {
	const read: { incoming: Incoming; content: UserInput }[] = [];
	for (const incoming of batch) {
		try {
			const content = await incoming.content;
			if (content !== undefined) read.push({ incoming, content });
		} catch (error) {
			console.error(`Reading message ${incoming.messageId} failed:`, error);
		}
	}
	const last = read.at(-1);
	if (!last) return;

	// Reactions since the last input come first, as they came before these.
	const reactions = held.splice(0);
	// A single message goes as it came; the scripted model of E2E reads a
	// script from the first line of a plain text.
	const content =
		read.length === 1 && reactions.length === 0
			? last.content
			: [...reactions.flatMap(parts), ...read.flatMap((m) => parts(m.content))];
	await whileTyping(() => submit(last.incoming.messageId, content));
};

// Inputs are submitted one after another, in the background, so the bot keeps
// taking updates: a command answers at once, even while the agent is still
// busy with an earlier message.
let queue: Promise<void> = Promise.resolve();
let pending: Incoming[] = [];
const held: string[] = [];
let timer: NodeJS.Timeout | undefined;

const flush = (): void => {
	const batch = pending;
	pending = [];
	queue = queue
		.then(() => submitBatch(batch))
		.catch((error) => {
			// Only the cause: the context it comes with holds the bot's token.
			console.error("Submitting the chat's messages failed:", error);
		});
};

/** Hands what the chat sent to the agent once the chat has been quiet. */
export const receive = (incoming: Incoming): void => {
	// Its failure is logged when the batch is read.
	incoming.content.catch(() => {});
	pending.push(incoming);
	clearTimeout(timer);
	timer = setTimeout(flush, DEBOUNCE_MS);
};

/** Keeps a reaction for the agent's next input: alone it starts no turn. */
export const hold = (reaction: string): void => {
	held.push(reaction);
};
