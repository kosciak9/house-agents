import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import { Cron } from "croner";

import { agentModels, SMALL_MODEL } from "../agent/models.ts";
import type { Reviews } from "../config.ts";
import { ask } from "../memory/llm.ts";
import { scheduledInput } from "../scheduler/scheduled.ts";
import { keepWakes, type Wake } from "../scheduler/wakes.ts";
import { fromWall, toWall } from "./wall.ts";

// At every review moment the harness wakes the agent with the review prompt.
// Before it, the guard reads the last day of the conversation, across
// compactions, and lists the matters still open with a time to come back to
// each; the prompt carries the list, and the timed matters become wake-ups
// labelled "guard", which replace those of the review before. Timers live in
// this process: a review missed while it was down still runs within
// `CATCH_UP`, once (the request id), and is lost after.

const DAY = 24 * 60 * 60 * 1000;
const CATCH_UP = 30 * 60 * 1000;
const GUARD = "guard";
// Each thing said, clipped, so that a day fits the guard's request.
const CLIP = 400;
// The guard's wake-ups come in the day, and at most this many.
const MORNING = "08:00";
const NIGHT_HOUR = 22;
const MAX_WAKES = 10;

const REPORT = /^Every ".+" subagent you started has answered/;
const MATTER = /^[\s*-]*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*\|\s*(.+)$/gm;

const textOf = (message: Message): string =>
	typeof message.content === "string"
		? message.content
		: message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n");

const clip = (text: string): string =>
	text.replace(/\s+/g, " ").trim().slice(0, CLIP);

// What was said: the user's and scheduled inputs and the agent's answers,
// not the sources' notes nor bookkeeping entries.
const SAID = new Set(["pi.user", "pi.assistant"]);

// Who said what, one line each; tool calls other than delegations are left out.
const linesOf = (message: Message, timeZone: string): string[] => {
	const at = `[${toWall(message.timestamp, timeZone)}]`;
	if (message.role === "user") {
		const text = textOf(message);
		const who = text.startsWith("<scheduled>")
			? "scheduled"
			: REPORT.test(text)
				? "report"
				: "user";
		const body = text.replace(/<\/?scheduled>/g, "");
		return [`${at} ${who}: ${clip(body)}`];
	}
	if (message.role !== "assistant") return [];
	const said = clip(textOf(message));
	return [
		...message.content.flatMap((part) =>
			part.type === "toolCall" && part.name === "subagent"
				? [
						`${at} agent delegated: ${clip(
							[part.arguments.tasks ?? []].flat().join(" | "),
						)}`,
					]
				: [],
		),
		...(said && said !== "NO_REPLY" ? [`${at} agent: ${said}`] : []),
	];
};

// The conversation since `since`, oldest first, whatever context it was in.
const transcript = async (
	conversation: Conversation,
	since: number,
	timeZone: string,
): Promise<string> => {
	const lines: string[][] = [];
	let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
	for (;;) {
		const page = await conversation.entries(
			{},
			100,
			cursor,
			BACKGROUND_CONTEXT,
		);
		for (const entry of page.items) {
			if (!SAID.has(entry.kind)) continue;
			const messages = (entry.model ?? []).filter(
				(message) => message.timestamp >= since,
			);
			if (messages.length < (entry.model ?? []).length) {
				lines.push(messages.flatMap((m) => linesOf(m, timeZone)));
				return lines.reverse().flat().join("\n");
			}
			lines.push(messages.flatMap((m) => linesOf(m, timeZone)));
		}
		if (page.next === undefined) return lines.reverse().flat().join("\n");
		cursor = page.next;
	}
};

// The guard's matters, with a time to come back in the day.
const wakesOf = (
	matters: string,
	guard: NonNullable<Reviews["guard"]>,
	now: number,
	timeZone: string,
): Wake[] =>
	[...matters.matchAll(MATTER)]
		.flatMap(([, wall, note]) => {
			let at = fromWall(wall as string, timeZone);
			if (!(at > now)) return [];
			const day = toWall(at, timeZone).slice(0, 10);
			const hour = Number(toWall(at, timeZone).slice(11, 13));
			if (hour >= NIGHT_HOUR) {
				at = fromWall(
					`${toWall(at + DAY, timeZone).slice(0, 10)} ${MORNING}`,
					timeZone,
				);
			} else if (toWall(at, timeZone).slice(11) < MORNING) {
				at = fromWall(`${day} ${MORNING}`, timeZone);
			}
			const matter = (note as string).trim();
			return [{ key: matter, at, prompt: `${guard.wake} ${matter}` }];
		})
		// The nearest first, each matter once.
		.sort((a, b) => a.at - b.at)
		.filter((wake, i, all) => all.findIndex((w) => w.key === wake.key) === i)
		.slice(0, MAX_WAKES);

const review = async (
	conversation: Conversation,
	reviews: Reviews,
	timeZone: string,
	scheduledFor: number,
): Promise<void> => {
	let prompt = reviews.prompt;
	const { guard } = reviews;
	// The review comes even when the guard fails.
	if (guard) {
		try {
			prompt += await guardList(conversation, guard, timeZone);
		} catch (error) {
			console.error("The guard failed:", error);
		}
	}
	await conversation.submit(
		{
			type: "input",
			content: scheduledInput(prompt),
			whenBusy: "followUp",
			requestId: `review:${scheduledFor}`,
		},
		BACKGROUND_CONTEXT,
	);
};

// The guard's list, after setting its wake-ups; empty when it has none.
const guardList = async (
	conversation: Conversation,
	guard: NonNullable<Reviews["guard"]>,
	timeZone: string,
): Promise<string> => {
	const now = Date.now();
	const lines = await transcript(conversation, now - DAY, timeZone);
	const answer = await ask(agentModels, SMALL_MODEL, {
		system: guard.prompt,
		prompt: `Now: ${toWall(now, timeZone)} (${timeZone})\n<conversation>\n${lines || "(empty)"}\n</conversation>`,
	});
	if (!answer.ok) throw new Error(answer.error);
	await keepWakes(
		conversation,
		GUARD,
		wakesOf(answer.text, guard, now, timeZone),
		BACKGROUND_CONTEXT,
	);
	return `\n\n${guard.heading}\n${answer.text}`;
};

/** Wakes `conversation` for a review at every firing of `reviews.cron`. */
export const startReviews = (
	conversation: Conversation,
	reviews: Reviews,
): void => {
	const timeZone =
		reviews.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const run = (scheduledFor: number) =>
		review(conversation, reviews, timeZone, scheduledFor).catch((error) =>
			console.error("The review failed:", error),
		);
	const schedule = new Cron(reviews.cron, {
		timezone: reviews.timeZone,
		unref: true,
	});
	const missed = schedule.nextRun(new Date(Date.now() - CATCH_UP))?.getTime();
	if (missed !== undefined && missed <= Date.now()) void run(missed);
	schedule.schedule((self: Cron) => {
		void run(self.currentRun()?.getTime() ?? Date.now());
	});
};
