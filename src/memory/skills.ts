import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type DocumentReader,
	defineDoc,
	defineTool,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";

import { type Leaf, type MemoryReader, openMemory } from "./store.ts";

// Skills are how the agent does things the way its user wants: each one a
// compressed conclusion of the conversations that taught it. Code, not the
// agent, ties every write to the conversation it happens in, so once that
// conversation is a session of memory, memory_ask unpacks what the skill
// compressed away. Skills live beside the memory and, like it, belong to the
// main conversation alone.

type Skill = {
	description: string;
	body: string;
	/** The transcript entry each write followed, oldest first. */
	at: number[];
};

const Skills = defineDoc<{ skills: Record<string, Skill> }>({
	kind: "memory.skills",
	version: 1,
	scope: "session",
	initial: () => ({ skills: {} }),
});

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const readSkills = async (
	reader: DocumentReader,
	context: Context,
): Promise<Record<string, Skill>> =>
	(await reader.snapshot(Skills, context))?.skills ?? {};

// Where an entry stands: in a session of memory, in one waiting for its
// line, or in the conversation still going on.
const source = (
	memory: MemoryReader,
	leaves: readonly Leaf[],
	at: number,
): string => {
	const leaf = leaves.find((found) => found.from <= at && at <= found.to);
	if (leaf !== undefined) return `[${leaf.session}]`;
	if (at > memory.closedTo) return "this conversation";
	return memory.queue.some((range) => range.from <= at && at <= range.to)
		? "a conversation being remembered"
		: "a conversation left without a line";
};

/** The conversations each skill came from, newest last, without repeats. */
const sources = async (
	reader: DocumentReader,
	context: Context,
	skills: Record<string, Skill>,
): Promise<Map<string, string[]>> => {
	const memory = await openMemory(reader, context);
	const leaves = await memory.leaves(0, memory.count);
	return new Map(
		Object.entries(skills).map(([name, skill]) => [
			name,
			[...new Set(skill.at.map((at) => source(memory, leaves, at)))],
		]),
	);
};

/** One line per skill: its name, what it is for and where it came from. */
export const skillLines = async (
	reader: DocumentReader,
	context: Context,
): Promise<string[]> => {
	const skills = await readSkills(reader, context);
	const from = await sources(reader, context, skills);
	return Object.entries(skills)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(
			([name, skill]) =>
				`- ${name}: ${skill.description} (from ${from.get(name)?.join(", ")})`,
		);
};

/** A skill in full, as `skill_read` gives it; undefined when there is none. */
export const skillText = async (
	reader: DocumentReader,
	context: Context,
	name: string,
): Promise<string | undefined> => {
	const skills = await readSkills(reader, context);
	const skill = skills[name];
	if (skill === undefined) return undefined;
	const from = (await sources(reader, context, { [name]: skill })).get(name);
	return [
		`# ${name}`,
		skill.description,
		`From: ${from?.join(", ")}`,
		"",
		skill.body,
	].join("\n");
};

/** The skills as the agent reads them at the start of every context. */
export const renderSkills = async (
	reader: DocumentReader,
	context: Context,
): Promise<string> => {
	const lines = await skillLines(reader, context);
	return [
		"<skills>",
		"Your skills: how to do things the way the user wants. Each is a compressed conclusion " +
			"of the conversations it came from, listed after it. skill_read gives a skill in full; " +
			"memory_ask on one of its conversations recovers what it compressed away.",
		"skill_write keeps a skill. When a conversation teaches you how to do something, and above " +
			"all in your retrospectives, write it or correct it: the conversation you write it in is " +
			"attached to it for you.",
		...(lines.length > 0 ? ["", ...lines] : ["", "You have no skills yet."]),
		"</skills>",
	].join("\n");
};

const text = (lines: readonly string[], isError = false) => ({
	content: [{ type: "text" as const, text: lines.join("\n") }],
	isError,
});

const notKept = () => text(["Only the main conversation keeps skills."], true);

export const skillReadTool = defineTool({
	name: "skill_read",

	description:
		"Read one of your skills in full, with the conversations it came from.",

	parameters: Type.Object({
		name: Type.String({ description: "The skill, as listed: plan-the-day" }),
	}),

	replay: "safe",

	execute: async (args, api, context) => {
		if (api.conversationId !== ROOT_CONVERSATION_ID) return notKept();
		const found = await skillText(api, context, args.name);
		return found === undefined
			? text([`No skill "${args.name}".`], true)
			: text([found]);
	},
});

export const skillWriteTool = defineTool({
	name: "skill_write",

	description:
		"Write a skill, or replace it with a corrected one: how to do something the way the " +
		"user wants, compressed from what your conversations concluded. This conversation is " +
		"attached to it, beside the ones it came from before. An empty body deletes the skill.",

	parameters: Type.Object({
		name: Type.String({
			description: "Lowercase words joined by hyphens: plan-the-day",
		}),
		description: Type.String({
			description: "One line: what the skill is for and when to use it.",
		}),
		body: Type.String({
			description:
				"The skill in full, replacing the previous one: the conclusions, compressed.",
		}),
	}),

	replay: "safe",

	execute: async (args, api, context) => {
		if (api.conversationId !== ROOT_CONVERSATION_ID) return notKept();
		if (!NAME.test(args.name) || args.name.length > 64) {
			return text(
				[
					`"${args.name}" is no skill name; use lowercase words joined by hyphens.`,
				],
				true,
			);
		}

		let outcome = "";
		await api.commit(async (tx) => {
			const { skills } = await tx.doc(Skills);
			if (args.body.trim() === "") {
				outcome = skills[args.name]
					? `Deleted the skill ${args.name}.`
					: `No skill "${args.name}".`;
				delete skills[args.name];
				return;
			}
			const tail = (
				await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)
			).items[0];
			const at = [...(skills[args.name]?.at ?? [])];
			if (tail !== undefined) at.push(tail.id);
			outcome = skills[args.name]
				? `Corrected the skill ${args.name}.`
				: `Wrote the skill ${args.name}.`;
			skills[args.name] = {
				description: args.description.trim(),
				body: args.body.trim(),
				at,
			};
		}, context);
		return text([outcome]);
	},
});
