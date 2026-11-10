import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineExtension,
	section,
} from "@earendil-works/pi-durable";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { Source, SourceUpdate } from "../config.ts";
import { connectServer } from "../mcp/client.ts";
import type { ServerConfig } from "../mcp/config.ts";
import type { TokenStore } from "../mcp/oauth.ts";
import { keepWakes } from "../scheduler/wakes.ts";
import { Cursors, type OwnSource, OwnSources } from "./docs.ts";
import {
	ownSourcesSection,
	ownSourceTools,
	READ_TIMEOUT,
	readOwn,
} from "./own.ts";

// The harness reads each source on its own every few minutes, through the MCP
// servers, with no model: the deployment's sources (`config.sources`) by
// their `poll`, the agent's own (`source_set`) by their script. Each turns
// what is new since its cursor into notes and wake-ups. Notes are written into
// the conversation without waking the agent, as <source> blocks; its
// wake-ups are kept among the agent's (`keepWakes`). The cursor advances only
// once the notes are written, so a read cut short repeats rather than loses
// them. Timers live in this process: after a restart every source is read at
// once.

const DEFAULT_EVERY_MINUTES = 5;
// How often the agent's own sources are looked over for one due: reading
// their document is cheap, and one set is read again soon after.
const OWN_TICK = 15_000;

export const SOURCES_INSTRUCTIONS =
	"Your sources (mail, chats and the like) are read for you on their own: " +
	'what is new comes into this conversation in <source name="..."> blocks ' +
	"without waking you, and the user did not send them. Act on them when you " +
	"are awake anyway, e.g. at a review. To watch something new for the user, " +
	"set up a source of your own (source_set), not a recurring schedule.";

export const SourcesExtension = defineExtension({
	name: "sources",
	sections: [section("sources", () => SOURCES_INSTRUCTIONS), ownSourcesSection],
	tools: ownSourceTools,
});

const textOf = (content: unknown): string =>
	(Array.isArray(content) ? content : [])
		.flatMap((part: { type?: string; text?: string }) =>
			part.type === "text" && part.text ? [part.text] : [],
		)
		.join("\n");

// A plain copy: the document's value does not outlive its commit.
const cursorOf = (
	conversation: Conversation,
	name: string,
): Promise<JsonValue | null> =>
	conversation.commit(async (tx) => {
		const value = (await tx.doc(Cursors, conversation.id)).cursors[name];
		return value === undefined
			? null
			: (JSON.parse(JSON.stringify(value)) as JsonValue);
	}, BACKGROUND_CONTEXT);

// Writes what a read of source `name` found: its notes, its wake-ups, then
// its cursor.
const record = async (
	conversation: Conversation,
	name: string,
	now: number,
	update: SourceUpdate,
): Promise<void> => {
	const notes = (update.notes ?? []).filter((note) => note.trim());
	if (notes.length > 0) {
		await conversation.submit(
			{
				type: "write",
				entry: {
					kind: "sources.note",
					model: [
						{
							role: "user",
							content: notes
								.map(
									// A note cannot close its block and pass for the user.
									(note) =>
										`<source name="${name}">\n${note.replace(/<(\/?source)/gi, "‹$1")}\n</source>`,
								)
								.join("\n"),
							timestamp: now,
						},
					],
				},
			},
			BACKGROUND_CONTEXT,
		);
	}
	if (update.wakes) {
		await keepWakes(conversation, name, update.wakes, BACKGROUND_CONTEXT);
	}
	await conversation.commit(async (tx) => {
		(await tx.doc(Cursors, conversation.id)).cursors[name] = update.cursor;
	}, BACKGROUND_CONTEXT);
};

const poll = async ({
	conversation,
	name,
	source,
	servers,
	tokens,
}: {
	conversation: Conversation;
	name: string;
	source: Source;
	servers: ReadonlyMap<string, ServerConfig>;
	tokens: TokenStore;
}): Promise<void> => {
	const clients = new Map<string, Client>();
	const connect = async (server: string): Promise<Client> => {
		const known = clients.get(server);
		if (known) return known;
		const config = servers.get(server);
		if (!config) throw new Error(`No MCP server "${server}"`);
		const client = await connectServer(server, config, tokens);
		if (!client) throw new Error(`MCP ${server}: waits for the user to log in`);
		clients.set(server, client);
		return client;
	};
	try {
		const now = Date.now();
		const update = await source.poll({
			cursor: await cursorOf(conversation, name),
			now,
			call: async (server, tool, args) => {
				const result = await (await connect(server)).callTool({
					name: tool,
					arguments: args,
				});
				const text = textOf(result.content);
				if (result.isError) {
					throw new Error(`${server} ${tool}: ${text.slice(0, 300)}`);
				}
				return text;
			},
		});
		await record(conversation, name, now, update);
	} finally {
		await Promise.allSettled(
			[...clients.values()].map((client) => client.close()),
		);
	}
};

const withTimeout = <T>(work: Promise<T>): Promise<T> =>
	Promise.race([
		work,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("timed out")), READ_TIMEOUT).unref(),
		),
	]);

// One read of the agent's source `name`, as it was set at `setAt`; how it
// went is kept on the source, for the agent's prompt.
const readOwnSource = async (
	conversation: Conversation,
	name: string,
	source: OwnSource,
): Promise<void> => {
	const now = Date.now();
	const isCurrent = async () =>
		(await conversation.commit(
			async (tx) =>
				(
					await tx.doc(OwnSources, conversation.id)
				).sources[name]?.setAt,
			BACKGROUND_CONTEXT,
		)) === source.setAt;
	let failure: string | null = null;
	try {
		const update = await withTimeout(
			readOwn(source, await cursorOf(conversation, name), now),
		);
		// Deleted or set again meanwhile: this read is not its own any more.
		if (!(await isCurrent())) return;
		await record(conversation, name, now, update);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		console.error(`Source ${name}: reading failed:`, error);
	}
	await conversation.commit(async (tx) => {
		const current = (await tx.doc(OwnSources, conversation.id)).sources[name];
		if (current?.setAt !== source.setAt) return;
		current.failing =
			failure === null
				? null
				: { since: current.failing?.since ?? now, error: failure };
	}, BACKGROUND_CONTEXT);
};

// Looks over the agent's own sources every `OWN_TICK` and reads each one
// due, one read of a source at a time; one set or set again is due at once.
const startOwnSources = (conversation: Conversation): void => {
	const due = new Map<string, { setAt: number; at: number }>();
	const reading = new Set<string>();
	const tick = async () => {
		const own = await conversation.commit(
			async (tx) =>
				JSON.parse(
					JSON.stringify((await tx.doc(OwnSources, conversation.id)).sources),
				) as Record<string, OwnSource>,
			BACKGROUND_CONTEXT,
		);
		const now = Date.now();
		for (const name of due.keys()) if (!own[name]) due.delete(name);
		for (const [name, source] of Object.entries(own)) {
			const next = due.get(name);
			if (reading.has(name)) continue;
			if (next?.setAt === source.setAt && next.at > now) continue;
			due.set(name, {
				setAt: source.setAt,
				at: now + source.everyMinutes * 60_000,
			});
			reading.add(name);
			void readOwnSource(conversation, name, source).finally(() =>
				reading.delete(name),
			);
		}
	};
	const next = () =>
		tick()
			.catch((error) => console.error("Own sources:", error))
			.finally(() => setTimeout(next, OWN_TICK).unref());
	void next();
};

/**
 * Reads every source now and then every `everyMinutes`, one poll of a source
 * at a time: the deployment's `sources` and those the agent set up.
 */
export const startSources = ({
	conversation,
	sources,
	servers,
	tokens,
}: {
	conversation: Conversation;
	sources: Record<string, Source>;
	servers: ReadonlyMap<string, ServerConfig>;
	tokens: TokenStore;
}): void => {
	for (const [name, source] of Object.entries(sources)) {
		const every = (source.everyMinutes ?? DEFAULT_EVERY_MINUTES) * 60_000;
		const next = async () => {
			try {
				await withTimeout(
					poll({ conversation, name, source, servers, tokens }),
				);
			} catch (error) {
				console.error(`Source ${name}: reading failed:`, error);
			}
			setTimeout(next, every).unref();
		};
		void next();
	}
	startOwnSources(conversation);
};
