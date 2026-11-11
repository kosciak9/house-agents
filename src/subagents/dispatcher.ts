import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Conversation, DocumentReader } from "@earendil-works/pi-durable";

import { agentModels } from "../agent/models.ts";
import { config } from "../config.ts";
import { skillsText } from "../memory/skills.ts";
import { openMemory } from "../memory/store.ts";
import { memoryLines } from "../memory/wake.ts";
import { transcript } from "../reviews/reviews.ts";
import { TIME_ZONE } from "../scheduler/schedules.ts";
import { toWall } from "../scheduler/wall.ts";
import { workerModels } from "./config.ts";

// The dispatcher (`config.worker.dispatcher`) stands between the agent and its
// workers: the agent says what it needs, and one call of a stronger model,
// which reads the recent conversation, the memory and the skills, picks each
// task's model and writes the brief its worker gets. The agent can talk on a
// fast model while a careful one briefs the work.
//
// Its request leads with what changes rarely (its instructions, the models,
// the memory and the skills), under a session of its own and the long cache
// retention, so the provider reads that part from its cache across calls; the
// conversation and the tasks follow. All the tasks of one call of the agent go
// in one request. It must not hold the workers up: past `TIMEOUT` the tasks run
// as the agent wrote them.

/** How far back the dispatcher reads the conversation. */
const RECENT = 6 * 60 * 60 * 1000;
const TIMEOUT = 90_000;

/** A task as the agent asked for it. */
export type Ask = { intent: string; task: string; model: string | null };

/**
 * The dispatcher's choice for a task: its worker model (null: the default) and
 * brief; undefined for a task its answer leaves out, which runs as asked.
 */
export type Dispatched = { model: string | null; brief: string } | undefined;

const textOf = (message: AssistantMessage): string =>
	message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();

// Its answer, checked: a model and brief per task, in order.
const parse = (text: string, count: number): Dispatched[] | undefined => {
	let value: unknown;
	try {
		value = JSON.parse(
			text.slice(text.indexOf("["), text.lastIndexOf("]") + 1),
		);
	} catch {
		return undefined;
	}
	if (!Array.isArray(value) || value.length !== count) return undefined;
	return value.map((item: unknown) => {
		const { model, brief } = (item ?? {}) as Record<string, unknown>;
		if (typeof brief !== "string" || !brief.trim()) return undefined;
		return {
			model:
				typeof model === "string" && workerModels.has(model) ? model : null,
			brief: brief.trim(),
		};
	});
};

/**
 * The dispatcher's model and brief for each of `asks`, or undefined without a
 * dispatcher, or when it fails: the tasks then run as the agent wrote them.
 */
export const dispatch = async (
	asks: readonly Ask[],
	root: Conversation,
	reader: DocumentReader,
	context: Context,
): Promise<Dispatched[] | undefined> => {
	const dispatcher = config().worker?.dispatcher;
	if (!dispatcher) return undefined;
	const spec = agentModels.getModel(
		dispatcher.model.provider,
		dispatcher.model.modelId,
	);
	if (!spec) return undefined;

	const names = ["default", ...workerModels.keys()];
	const system = [
		dispatcher.prompt,
		`<models>\n- default\n${[...workerModels]
			.map(([name, { description }]) => `- ${name}: ${description}`)
			.join("\n")}\n</models>`,
		// Not waiting for the latest sessions' lines, as the agent's prompt does.
		`<memory>\n${(await memoryLines(await openMemory(reader, context))).join("\n") || "(empty)"}\n</memory>`,
		`<skills>\n${(await skillsText(reader, context)) || "(none)"}\n</skills>`,
	].join("\n\n");
	const now = Date.now();
	const prompt = [
		`Now: ${toWall(now, TIME_ZONE)} (${TIME_ZONE})`,
		`<conversation>\n${(await transcript(root, now - RECENT, TIME_ZONE)) || "(empty)"}\n</conversation>`,
		`<tasks>\n${JSON.stringify(asks)}\n</tasks>`,
		`Answer with a JSON array of ${asks.length} object(s), one per task in order: ` +
			`{"model": one of ${names.join(", ")}, "brief": the brief its worker gets}. ` +
			"Keep every concrete detail a task gives (names, numbers, ids, links, paths) in its brief.",
	].join("\n\n");

	const thinking = dispatcher.model.thinkingLevel ?? "off";
	const message = await agentModels.completeSimple(
		spec,
		{
			messages: [
				{ role: "system", content: system, timestamp: now },
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: now,
				},
			],
		},
		{
			sessionId: "dispatcher",
			cacheRetention: "long",
			signal: AbortSignal.any([
				...(context.abortSignal ? [context.abortSignal] : []),
				AbortSignal.timeout(TIMEOUT),
			]),
			...(thinking !== "off" && { reasoning: thinking }),
		},
	);
	if (message.stopReason !== "stop") {
		console.error(
			`The dispatcher failed (${message.errorMessage ?? message.stopReason}); the tasks run as asked`,
		);
		return undefined;
	}
	const dispatched = parse(textOf(message), asks.length);
	const { cost, cacheRead } = message.usage ?? {};
	// The model that answered: the fallback's, when the dispatcher's failed.
	console.log(
		`Dispatcher (${message.provider}/${message.model}): ${asks.length} task(s), ` +
			`$${(cost?.total ?? 0).toFixed(4)}, ${cacheRead ?? 0} tokens from the cache` +
			(dispatched === undefined
				? "; its answer did not parse, the tasks run as asked"
				: dispatched.some((answer) => answer === undefined)
					? "; some tasks run as asked"
					: ""),
	);
	return dispatched;
};
