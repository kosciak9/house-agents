import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	defineTool,
	ROOT_CONVERSATION_ID,
	section,
} from "@earendil-works/pi-durable";

import { config, type SourceUpdate } from "../config.ts";
import { connectServers } from "../mcp/client.ts";
import { servers, tokens, workerPolicy } from "../mcp/config.ts";
import { formatTime, Schedules } from "../scheduler/schedules.ts";
import { keepWakesIn } from "../scheduler/wakes.ts";
import { Cursors, type OwnSource, OwnSources } from "./docs.ts";

// Sources the agent sets up itself, to watch something for the user it has
// no source for: a script the harness runs on its own every few minutes,
// with no model, like the deployment's sources. Its notes reach the
// conversation without waking the agent; its wake-ups wake it. Each read
// connects to the servers it names and runs in a codemode sandbox of their
// tools, with no other capability.

/** A read that hangs, e.g. on a server that stopped answering, is given up. */
export const READ_TIMEOUT = 2 * 60_000;
const MAX_SOURCES = 20;
const MIN_MINUTES = 5;
const MAX_MINUTES = 24 * 60;
const MAX_CODE = 20_000;
const MEMORY_LIMIT = 64 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CLIP = 200;

const clip = (text: string, length = CLIP): string =>
	text.length > length ? `${text.slice(0, length)}…` : text;

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

// What a script returned, checked: the harness writes its notes and keeps
// its wake-ups.
const updateOf = (value: unknown): SourceUpdate => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("It must return { cursor, notes?, wakes? }.");
	}
	const { cursor, notes, wakes } = value as Record<string, unknown>;
	if (cursor === undefined) {
		throw new Error(
			"It returned no cursor: return { cursor } with what its next read starts from.",
		);
	}
	if (
		notes !== undefined &&
		!(Array.isArray(notes) && notes.every((note) => typeof note === "string"))
	) {
		throw new Error("notes must be an array of strings.");
	}
	if (
		wakes !== undefined &&
		!(
			Array.isArray(wakes) &&
			wakes.every(
				(wake) =>
					typeof wake?.key === "string" &&
					Number.isFinite(wake?.at) &&
					typeof wake?.prompt === "string",
			)
		)
	) {
		throw new Error(
			"wakes must be [{ key, at, prompt }] with at in milliseconds since the epoch.",
		);
	}
	return { cursor: cursor as JsonValue, notes, wakes };
};

/** One read of `source` from `cursor`: what it found, or why it failed. */
export const readOwn = async (
	source: Pick<OwnSource, "servers" | "code">,
	cursor: JsonValue | null,
	now: number,
): Promise<SourceUpdate> => {
	const policy = new Map(
		source.servers.map((server) => {
			const allowed = workerPolicy.get(server);
			if (!allowed) throw new Error(`No MCP server "${server}" to read.`);
			return [server, allowed] as const;
		}),
	);
	const connection = await connectServers(policy, servers, tokens);
	const sandbox = new CodemodeSandbox({
		tools: connection.tools,
		timeoutMs: READ_TIMEOUT,
		// It runs unwatched: a runaway script fails rather than the process.
		memoryLimitBytes: MEMORY_LIMIT,
	});
	try {
		const result = await sandbox.execute(source.code, {
			store: { cursor, now },
		});
		if (!result.ok) {
			const output = result.output
				.flatMap((item) => (item.type === "text" ? [item.text] : []))
				.join("\n");
			throw new Error(
				`${result.error.message}${output ? `\nIts output: ${clip(output, 1000)}` : ""}`,
			);
		}
		return updateOf(result.value);
	} finally {
		await sandbox.close();
		await connection.close();
	}
};

const reply = (text: string, isError = false) => ({
	content: [{ type: "text" as const, text }],
	isError,
});

const sourceSetTool = defineTool({
	name: "source_set",
	description:
		"Set up a source, or replace yours of that name, to watch something " +
		"for the user that no source brings (a feed, a page, a search, a " +
		"mailbox or chat query): a script the harness runs on its own every " +
		"everyMinutes, with no model, instead of a recurring schedule. The " +
		"script is the body of an async function, run like codemode's: it calls " +
		"the MCP tools of `servers` as `await tools.<server>__<tool>(args)`, " +
		"which return MCP results ({content: [{type: 'text', text}]}); there " +
		"is no fetch, timers or modules (a sandbox server can fetch). " +
		"`load('cursor')` is the cursor its last read returned (null at " +
		"first), `load('now')` the time in milliseconds. It returns { cursor, " +
		"notes?, wakes? }: notes, strings, are what is new since the cursor, " +
		"written into the user's conversation in <source> blocks without " +
		"waking anyone; wakes, [{ key, at, prompt }] with at in milliseconds " +
		"since the epoch, are every wake-up it wants from now on (the harness " +
		"keeps exactly these), e.g. a day before each match. It runs once " +
		"now: a failure comes back here and nothing is set; otherwise its " +
		"notes of this first read come back here, not to the conversation.",
	parameters: Type.Object({
		name: Type.String({ description: "Lowercase letters, digits and -." }),
		about: Type.String({
			description: "What it watches and why, in a sentence.",
		}),
		everyMinutes: Type.Number({
			description: `How often it is read, ${MIN_MINUTES}-${MAX_MINUTES}.`,
		}),
		servers: Type.Array(Type.String(), {
			description: "The MCP servers its script calls.",
		}),
		code: Type.String({ description: "The script." }),
	}),
	execute: async (args, api, context) => {
		const name = args.name.trim();
		const configured = Object.keys(config().sources ?? {});
		if (!NAME.test(name) || configured.includes(name) || name === "guard") {
			return reply(
				`Not set: name it with lowercase letters, digits and -, other than ${["guard", ...configured].join(", ")}.`,
				true,
			);
		}
		if (
			!(args.everyMinutes >= MIN_MINUTES && args.everyMinutes <= MAX_MINUTES)
		) {
			return reply(
				`Not set: everyMinutes must be ${MIN_MINUTES}-${MAX_MINUTES}.`,
				true,
			);
		}
		if (args.code.length > MAX_CODE) {
			return reply(`Not set: the script is over ${MAX_CODE} characters.`, true);
		}
		const known = await api.commit(
			async (tx) =>
				Object.keys((await tx.doc(OwnSources, ROOT_CONVERSATION_ID)).sources),
			context,
		);
		if (!known.includes(name) && known.length >= MAX_SOURCES) {
			return reply(
				`Not set: you have ${MAX_SOURCES} sources; delete one you no longer need (source_delete) first.`,
				true,
			);
		}

		const now = Date.now();
		let update: SourceUpdate;
		try {
			update = await readOwn(args, null, now);
		} catch (error) {
			return reply(
				`Not set: its first read failed: ${errorMessage(error)}`,
				true,
			);
		}
		await api.commit(async (tx) => {
			(await tx.doc(OwnSources, ROOT_CONVERSATION_ID)).sources[name] = {
				about: args.about,
				everyMinutes: args.everyMinutes,
				servers: args.servers,
				code: args.code,
				setAt: now,
				failing: null,
			};
			(await tx.doc(Cursors, ROOT_CONVERSATION_ID)).cursors[name] =
				update.cursor;
			await keepWakesIn(tx, ROOT_CONVERSATION_ID, name, update.wakes ?? []);
		}, context);
		const notes = update.notes ?? [];
		const wakes = (update.wakes ?? []).filter((wake) => wake.at > now);
		return reply(
			[
				`Source "${name}" set: read every ${args.everyMinutes} minutes from now on, its wake-ups set.`,
				`Its first read: ${notes.length} note(s), ${wakes.length} wake-up(s) to come.`,
				...notes
					.slice(0, 5)
					.map((note) => `<note>\n${clip(note, 600)}\n</note>`),
				...wakes
					.slice(0, 5)
					.map((wake) => `- ${formatTime(wake.at)}: ${clip(wake.prompt)}`),
			].join("\n"),
		);
	},
});

const sourceDeleteTool = defineTool({
	name: "source_delete",
	description:
		"Delete a source you set up (source_set), with the wake-ups it set.",
	parameters: Type.Object({ name: Type.String() }),
	replay: "safe",
	execute: async ({ name }, api, context) => {
		const deleted = await api.commit(async (tx) => {
			const { sources } = await tx.doc(OwnSources, ROOT_CONVERSATION_ID);
			if (sources[name] === undefined) return false;
			delete sources[name];
			delete (await tx.doc(Cursors, ROOT_CONVERSATION_ID)).cursors[name];
			// Their tasks notice and abort themselves.
			const { schedules } = await tx.doc(Schedules, ROOT_CONVERSATION_ID);
			for (const [id, schedule] of Object.entries(schedules)) {
				if (schedule.type === "wakeup" && schedule.origin === name) {
					delete schedules[id];
				}
			}
			return true;
		}, context);
		return reply(
			deleted
				? `Source "${name}" deleted.`
				: `No source "${name}" of yours; your prompt lists them.`,
			!deleted,
		);
	},
});

export const ownSourceTools = [sourceSetTool, sourceDeleteTool];

/** The sources the agent set up, for its prompt and its workers'. */
export const ownSourcesSection = section(
	"own-sources",
	async (input, context) => {
		const own = await input.read.snapshot(
			OwnSources,
			ROOT_CONVERSATION_ID,
			context,
		);
		const lines = Object.entries(own?.sources ?? {}).map(
			([name, source]) =>
				`- ${name}, every ${source.everyMinutes} min (${source.servers.join(", ")}): ${clip(source.about)}` +
				(source.failing
					? ` FAILING since ${formatTime(source.failing.since)}: ${clip(source.failing.error)}`
					: ""),
		);
		return `The sources you set up (source_set, source_delete):\n${lines.join("\n") || "(none)"}`;
	},
);
