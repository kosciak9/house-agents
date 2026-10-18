import type { Context } from "@earendil-works/chord";
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import {
	type DocumentReader,
	defineDoc,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";

import { localTool } from "../codemode/local-tool.ts";
import { type Leaf, type MemoryReader, openMemory } from "./store.ts";

// Skills are how the agent does things the way its user wants: each one a
// compressed conclusion of the conversations that taught it. Code, not the
// agent, ties every write to the conversation it happens in, so once that
// conversation is a session of memory, memory_ask unpacks what the skill
// compressed away. Skills live beside the memory and, like it, belong to the
// main conversation alone; the agent reaches them only through codemode, so
// the prompt does not grow with them.

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
		"skill_search in codemode. skill_read gives a skill in full with its conversations; memory_ask " +
		"on one of them recovers what the skill compressed away.",
	"When a conversation teaches you how to do something, and above all in your retrospectives, " +
		"write or correct a skill with skill_write: the conversation you write it in is attached to " +
		"it for you.",
	"</skills>",
].join("\n");

const NOT_KEPT = "Only the main conversation keeps skills.";

const name = Type.String({
	description: "Lowercase words joined by hyphens: plan-the-day",
});

export const skillTools: readonly CodemodeTool[] = [
	localTool(
		"skill_search",
		"Search your skills, how the user wants things done, by keywords; look before a task.\n" +
			"Matches every word of `query` in a skill's name, description or body; an empty query " +
			"lists them all. Returns {matched, skills: [{name, description, from}]}: `from` names the " +
			"conversations a skill came from.",
		Type.Object({ query: Type.String() }, { additionalProperties: false }),
		async ({ query }, { api, context }) => {
			if (api.conversationId !== ROOT_CONVERSATION_ID)
				throw new Error(NOT_KEPT);
			const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
			const found = Object.fromEntries(
				Object.entries(await readSkills(api, context)).filter(
					([name, skill]) => {
						const about =
							`${name} ${skill.description} ${skill.body}`.toLowerCase();
						return words.every((word) => about.includes(word));
					},
				),
			);
			const from = await sources(api, context, found);
			return {
				matched: Object.keys(found).length,
				skills: Object.entries(found)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, skill]) => ({
						name,
						description: skill.description,
						from: from.get(name),
					})),
			};
		},
	),
	localTool(
		"skill_read",
		"Read one of your skills in full, with the conversations it came from.\n" +
			"Returns {name, description, from, body}; memory_ask on a conversation in `from` " +
			"recovers what the skill compressed away.",
		Type.Object({ name }, { additionalProperties: false }),
		async (args, { api, context }) => {
			if (api.conversationId !== ROOT_CONVERSATION_ID)
				throw new Error(NOT_KEPT);
			const skill = (await readSkills(api, context))[args.name];
			if (skill === undefined) throw new Error(`No skill "${args.name}".`);
			const from = await sources(api, context, { [args.name]: skill });
			return {
				name: args.name,
				description: skill.description,
				from: from.get(args.name),
				body: skill.body,
			};
		},
	),
	localTool(
		"skill_write",
		"Write a skill or correct one: a compressed conclusion of how the user wants something done.\n" +
			"A skill is a compression, never a copy: keep the conclusions, short, and leave out the " +
			"details, which memory_ask on the conversations it came from recovers. The conversation " +
			"you write it in is attached to it by code, beside the ones before. The body replaces the " +
			"previous one, so a correction rewrites the whole skill. Fold a skill into a near one " +
			"rather than keeping both, and delete one that no longer holds with an empty body. " +
			"Returns {outcome}.",
		Type.Object(
			{
				name,
				description: Type.String({
					description: "One line: what the skill is for and when to use it.",
				}),
				body: Type.String({
					description: "The conclusions, compressed; empty deletes the skill.",
				}),
			},
			{ additionalProperties: false },
		),
		async (args, { api, context }) => {
			if (api.conversationId !== ROOT_CONVERSATION_ID)
				throw new Error(NOT_KEPT);
			if (!NAME.test(args.name) || args.name.length > 64) {
				throw new Error(
					`"${args.name}" is no skill name; use lowercase words joined by hyphens.`,
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
			return { outcome };
		},
	),
];
