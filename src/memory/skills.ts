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
// main conversation alone; the agent finds them with skill_search, so the
// prompt does not grow with them.

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

/** Every skill in full, without where it came from, for a model to read. */
export const skillsText = async (
	reader: DocumentReader,
	context: Context,
): Promise<string> =>
	Object.entries(await readSkills(reader, context))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, skill]) => `## ${name}\n${skill.description}\n\n${skill.body}`)
		.join("\n\n");

/** A skill in full, as diagnostics shows it; undefined when there is none. */
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

/** Where the agent learns of its skills; it finds them with skill_search. */
export const SKILLS_NOTE = [
	"<skills>",
	"You keep skills: how to do things the way the user wants, each a compressed conclusion of " +
		"the conversations it came from. They are not listed here: before a task, look for one with " +
		"skill_search. skill_read gives a skill in full with its conversations; memory_ask " +
		"on one of them recovers what the skill compressed away.",
	"When a conversation teaches you how to do something, and above all in your retrospectives, " +
		"write or correct a skill with skill_write: the conversation you write it in is attached to " +
		"it for you.",
	"</skills>",
].join("\n");

// skill_search returns this many skills a call, so a long list stays out of the context.
const PAGE = 20;

// Every conversation reads the skills; only the main conversation writes them,
// since a skill points back to the main conversation's session it came from.
const NOT_KEPT = "Only the main conversation writes skills.";

const name = Type.String({
	description: "Lowercase words joined by hyphens: plan-the-day",
});

const reply = (text: string, isError = false) => ({
	content: [{ type: "text" as const, text }],
	isError,
});

const skillSearchTool = defineTool({
	name: "skill_search",
	description:
		"Search your skills, how the user wants things done, by keywords; look before a task.\n" +
		"A skill matches when its name, description or body has a word of `query`; those with " +
		"more of the words come first, and an empty query lists them all. Each line names the " +
		"conversations a skill came from. At most 20 skills a call: `offset` gives the next ones.",
	parameters: Type.Object({
		query: Type.String(),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
	}),
	replay: "safe",
	execute: async ({ query, offset = 0 }, api, context) => {
		const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
		const found = Object.entries(await readSkills(api, context))
			.map(([name, skill]) => {
				const about =
					`${name} ${skill.description} ${skill.body}`.toLowerCase();
				return {
					name,
					skill,
					hits: words.filter((word) => about.includes(word)).length,
				};
			})
			.filter(({ hits }) => words.length === 0 || hits > 0)
			.sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
		const page = found.slice(offset, offset + PAGE);
		const from = await sources(
			api,
			context,
			Object.fromEntries(page.map(({ name, skill }) => [name, skill])),
		);
		const lines = page.map(
			({ name, skill }) =>
				`- ${name}: ${skill.description} (from ${from.get(name)?.join(", ")})`,
		);
		const more =
			offset + PAGE < found.length
				? `\nMore with offset ${offset + PAGE}, or narrow the query.`
				: "";
		return reply(
			found.length === 0
				? "No skill matches."
				: `${found.length} skill(s) match:\n${lines.join("\n")}${more}`,
		);
	},
});

const skillReadTool = defineTool({
	name: "skill_read",
	description:
		"Read one of your skills in full, with the conversations it came from; memory_ask on " +
		"one of them recovers what the skill compressed away.",
	parameters: Type.Object({ name }),
	replay: "safe",
	execute: async (args, api, context) => {
		const text = await skillText(api, context, args.name);
		return text === undefined
			? reply(`No skill "${args.name}".`, true)
			: reply(text);
	},
});

const skillWriteTool = defineTool({
	name: "skill_write",
	description:
		"Write a skill or correct one: a compressed conclusion of how the user wants something done.\n" +
		"A skill is a compression, never a copy: keep the conclusions, short, and leave out the " +
		"details, which memory_ask on the conversations it came from recovers. The conversation " +
		"you write it in is attached to it by code, beside the ones before. The body replaces the " +
		"previous one, so a correction rewrites the whole skill. Fold a skill into a near one " +
		"rather than keeping both, and delete one that no longer holds with an empty body.",
	parameters: Type.Object({
		name,
		description: Type.String({
			description: "One line: what the skill is for and when to use it.",
		}),
		body: Type.String({
			description: "The conclusions, compressed; empty deletes the skill.",
		}),
	}),
	execute: async (args, api, context) => {
		if (api.conversationId !== ROOT_CONVERSATION_ID) {
			return reply(NOT_KEPT, true);
		}
		if (!NAME.test(args.name) || args.name.length > 64) {
			return reply(
				`"${args.name}" is no skill name; use lowercase words joined by hyphens.`,
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
		return reply(outcome);
	},
});

/** The skill tools, of the main conversation and of its workers alike. */
export const skillTools = [skillSearchTool, skillReadTool, skillWriteTool];
