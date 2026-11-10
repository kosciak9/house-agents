import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

/** Where each source's next read starts, by name: what its last one returned. */
export const Cursors = defineDoc<{ cursors: Record<string, JsonValue> }>({
	kind: "sources.cursors",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ cursors: {} }),
});

/** A source the agent set up: a script the harness runs on its own. */
export type OwnSource = {
	/** What it watches and why, as the agent put it. */
	about: string;
	everyMinutes: number;
	/** The MCP servers its script calls, from the worker's policy. */
	servers: string[];
	/** The body of an async function, run like a codemode script. */
	code: string;
	/** When it was set: a source set again is read again at once. */
	setAt: number;
	/** Its reads' failure since the last one that worked, if any. */
	failing: { since: number; error: string } | null;
};

export const OwnSources = defineDoc<{ sources: Record<string, OwnSource> }>({
	kind: "sources.own",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ sources: {} }),
});
