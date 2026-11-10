import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineDoc,
	defineExtension,
	section,
} from "@earendil-works/pi-durable";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { Source } from "../config.ts";
import { connectServer } from "../mcp/client.ts";
import type { ServerConfig } from "../mcp/config.ts";
import type { TokenStore } from "../mcp/oauth.ts";
import { keepWakes } from "../scheduler/wakes.ts";

// The harness reads each source on its own every few minutes, through the MCP
// servers, with no model: the source's `poll` turns what is new since its
// cursor into notes and wake-ups. Notes are written into the conversation
// without waking the agent, as <source> blocks; its wake-ups are kept among
// the agent's (`keepWakes`). The cursor advances only once the notes are
// written, so a poll cut short repeats rather than loses them. Timers live
// in this process: after a restart every source is read at once.

const DEFAULT_EVERY_MINUTES = 5;
// A poll that hangs, e.g. on a server that stopped answering, is given up.
const POLL_TIMEOUT = 2 * 60_000;

const Cursors = defineDoc<{ cursors: Record<string, JsonValue> }>({
	kind: "sources.cursors",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ cursors: {} }),
});

export const SOURCES_INSTRUCTIONS =
	"Your sources (mail, chats and the like) are read for you on their own: " +
	'what is new comes into this conversation in <source name="..."> blocks ' +
	"without waking you, and the user did not send them. Act on them when you " +
	"are awake anyway, e.g. at a review.";

export const SourcesExtension = defineExtension({
	name: "sources",
	sections: [section("sources", () => SOURCES_INSTRUCTIONS)],
});

const textOf = (content: unknown): string =>
	(Array.isArray(content) ? content : [])
		.flatMap((part: { type?: string; text?: string }) =>
			part.type === "text" && part.text ? [part.text] : [],
		)
		.join("\n");

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
		const cursor =
			(await conversation.commit(
				async (tx) => (await tx.doc(Cursors, conversation.id)).cursors[name],
				BACKGROUND_CONTEXT,
			)) ?? null;
		const update = await source.poll({
			cursor: cursor === null ? null : structuredClone(cursor),
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
	} finally {
		await Promise.allSettled(
			[...clients.values()].map((client) => client.close()),
		);
	}
};

/** Reads every source now and then every `everyMinutes`, one poll at a time. */
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
				await Promise.race([
					poll({ conversation, name, source, servers, tokens }),
					new Promise((_, reject) =>
						setTimeout(
							() => reject(new Error("timed out")),
							POLL_TIMEOUT,
						).unref(),
					),
				]);
			} catch (error) {
				console.error(`Source ${name}: reading failed:`, error);
			}
			setTimeout(next, every).unref();
		};
		void next();
	}
};
