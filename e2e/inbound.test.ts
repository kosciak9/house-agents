// Contract: the harness wakes the agent for a review at every firing of its
// cron, with the guard's list of the matters still open, and keeps one
// wake-up per timed matter of the latest list, labelled "guard". A source the
// harness reads on its own writes its new items into the conversation
// without waking the agent, and keeps exactly the wake-ups it asks for,
// replacing one that changed. The scripted model (`e2e/scripted-model.ts`)
// answers as the agent and as the guard, so this tests the harness, not a
// model's judgement; the source is a tool of a test MCP server
// (`e2e/mcp/server.ts`) whose answer the test rewrites; its cursor is an
// object, as real sources' are. The guard also reads
// the agent's scratchpad, and the nightly retro carries the day and the
// tasks its subagents did, each with the worker model it picked. A source the
// agent's worker sets up (a script) shows its first read, wakes the agent, is
// then read on its own like the others, and goes with its wake-ups once
// deleted.
// Runs its own bot process on an empty session. Takes about three minutes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import { type RunningMcpServer, startHttpMcpServer } from "./mcp/http.ts";
import { call, SCRIPTED_MODEL, say, script } from "./scripted-model.ts";
import {
	botUsername,
	connectTestUser,
	expectNoBotMessage,
	sendAndWaitForReply,
	waitForBotMessage,
} from "./telegram/client.ts";

const MINUTE = 60_000;
const SECOND = 1000;

const runId = Date.now().toString(36).toUpperCase();
const review = `REVIEW-${runId}`;
const retro = `RETRO-${runId}`;
const pad = `PAD-${runId}`;
const matter = `GUARD-${runId}`;
const note = `NOTE-${runId}`;
// The intent of the test's task: `e2e.<run>`, as the log lowercases it.
const job = "e2e";
const intent = `${job}.${runId.toLowerCase()}`;
const apiKey = `key-${runId}`;
// Far ahead, so no wake-up of this test ever fires.
const FAR = Date.parse("2099-06-01T10:00:00Z");

const directory = mkdtempSync(path.join(tmpdir(), "e2e-inbound-"));
const updatesFile = path.join(directory, "updates.json");
const setUpdates = (update: unknown) =>
	writeFileSync(updatesFile, JSON.stringify(update));

let server: RunningMcpServer;
let runningBot: RunningBot;
let client: Client;
let bot: string;

// What answers the test's own message, not a review or retro of the harness.
const isAnswer = (text: string) =>
	!text.startsWith(review) && !text.startsWith(retro);

// The agent's schedules, as cron_list lists them.
const schedules = () =>
	sendAndWaitForReply(
		client,
		bot,
		script(call("cron_list", {}), say("{{result}}")),
		{ matches: isAnswer, timeoutMs: MINUTE },
	);
const count = (text: string, part: string) => text.split(part).length - 1;

before(async () => {
	setUpdates({ cursor: { n: 0 }, wakes: [] });
	server = await startHttpMcpServer({
		WORD: "unused",
		VISIT_FILE: path.join(directory, "visits.txt"),
		UPDATES_FILE: updatesFile,
		API_KEY: apiKey,
	});
	runningBot = await startBot({
		stateDir: directory,
		model: SCRIPTED_MODEL,
		smallModel: SCRIPTED_MODEL,
		mcpServers: {
			updates: {
				url: server.url,
				headers: { Authorization: `Bearer ${apiKey}` },
			},
		},
		reviews: {
			cron: "*/20 * * * * *",
			timeZone: "Europe/Warsaw",
			// The guard's line; the lookahead keeps it off this script's own text.
			prompt: script(say(`${review} {{match:${matter}(?= still)[^\\n]*}}`)),
			guard: {
				prompt: script(
					say(
						`2099-06-01 12:00 | ${matter} still open {{match:PAD-[A-Z0-9]+}}`,
					),
				),
				heading: "Open matters:",
				wake: "Back to:",
			},
		},
		retro: {
			// Apart from the reviews: one firing would hide the other.
			cron: "15 * * * * *",
			timeZone: "Europe/Warsaw",
			// A line of the day, which only the retro's <day> holds, and the
			// test's task, which only its <jobs> has as a line.
			prompt: script(
				say(
					`${retro}{{match:\\] user: }} {{match:${job}\\.[a-z0-9]+ \\| strong \\| done}}`,
				),
			),
		},
		sources: {
			updates: { server: "updates", tool: "get_updates", everyMinutes: 0.05 },
		},
		worker: {
			// A model the agent may pick for a task, logged by its name.
			models: {
				strong: { model: SCRIPTED_MODEL, description: "For hard tasks." },
			},
			// What a source the agent sets up may read.
			mcp: { updates: ["get_updates"] },
		},
	});
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	server?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("inbound: reviews with the guard's matters; sources", {
	timeout: 4 * MINUTE,
}, async (t) => {
	await t.test("a review wakes the agent with the guard's list", async () => {
		const text = await waitForBotMessage(client, bot, {
			matches: (text) => text.startsWith(review),
			timeoutMs: MINUTE,
		});
		assert.equal(text, `${review} ${matter} still open`);
	});

	await t.test(
		"the guard's matter is one wake-up, also after the next review",
		async () => {
			await waitForBotMessage(client, bot, {
				matches: (text) => text.startsWith(review),
				timeoutMs: MINUTE,
			});
			const list = await schedules();
			assert.equal(count(list, `Back to: ${matter} still open`), 1, list);
			assert.match(list, /\] guard: wakeup at /);
		},
	);

	await t.test("the guard reads the scratchpad", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			script(call("scratchpad", { content: pad }), say("{{result}}")),
			{ matches: (text) => text.startsWith("Saved"), timeoutMs: MINUTE },
		);
		await waitForBotMessage(client, bot, {
			matches: (text) => text.startsWith(review) && text.includes(pad),
			timeoutMs: MINUTE,
		});
	});

	await t.test("the retro carries the day and its tasks", async () => {
		const reported = `JOB-DONE-${runId}`;
		await sendAndWaitForReply(
			client,
			bot,
			script(
				call("subagent", {
					agent: "general",
					tasks: [
						{ intent, task: script(say("Status: done")), model: "strong" },
					],
				}),
				say(`JOB-STARTED-${runId}`),
				// Once it has reported.
				say(reported),
			),
			{ matches: (text) => text === reported, timeoutMs: MINUTE },
		);
		await waitForBotMessage(client, bot, {
			matches: (text) =>
				text.startsWith(`${retro}] user:`) &&
				text.includes(`${intent} | strong | done`),
			timeoutMs: 2 * MINUTE,
		});
	});

	await t.test("a source's notes reach the agent without a reply", async () => {
		setUpdates({ cursor: { n: 1 }, notes: [note], wakes: [] });
		await expectNoBotMessage(client, bot, {
			matches: (text) => text.includes(note),
			durationMs: 10 * SECOND,
		});
		const reply = await sendAndWaitForReply(
			client,
			bot,
			// Only the note has it at a line's start, not this script.
			script(say(`{{match:(?<=\\n)${note}}}`)),
			{ matches: isAnswer, timeoutMs: MINUTE },
		);
		assert.equal(reply, note);
	});

	await t.test(
		"a source keeps exactly its wake-ups, replacing a changed one",
		async () => {
			setUpdates({
				cursor: { n: 2 },
				wakes: [{ key: "a", at: FAR, prompt: `FIRST-${runId}` }],
			});
			await new Promise((resolve) => setTimeout(resolve, 8 * SECOND));
			assert.equal(count(await schedules(), `FIRST-${runId}`), 1);

			setUpdates({
				cursor: { n: 3 },
				wakes: [{ key: "a", at: FAR, prompt: `SECOND-${runId}` }],
			});
			await new Promise((resolve) => setTimeout(resolve, 8 * SECOND));
			const list = await schedules();
			assert.equal(count(list, `SECOND-${runId}`), 1, list);
			assert.equal(count(list, `FIRST-${runId}`), 0, list);
			assert.match(list, /\] updates: wakeup at /);
		},
	);

	await t.test(
		"a source a worker sets up wakes the agent and is read on its own until deleted",
		async () => {
			const mark = `OWN-${runId}-`;
			const fired = `OWN-FIRED-${runId}`;
			const wake = `OWN-WAKE-${runId}`;
			// Notes the test's cursor on every read but the first, the one
			// source_set makes (no message but such a note has the mark and a
			// digit); wakes the agent soon, at the time its first read set, and
			// keeps one far ahead.
			const code = [
				"const text = (await tools.updates__get_updates({})).content[0].text;",
				"const { n } = JSON.parse(text).cursor;",
				'const last = load("cursor");',
				'const soon = last === null ? load("now") + 10000 : last.soon;',
				"return {",
				"  cursor: { soon },",
				`  notes: last === null ? [] : [${JSON.stringify(mark)} + n],`,
				"  wakes: [",
				`    { key: "soon", at: soon, prompt: ${JSON.stringify(script(say(fired)))} },`,
				`    { key: "far", at: ${FAR}, prompt: ${JSON.stringify(wake)} },`,
				"  ],",
				"};",
			].join("\n");
			const setUp = script(
				call("source_set", {
					name: "watch",
					about: "The test's cursor.",
					everyMinutes: 5,
					servers: ["updates"],
					code,
				}),
				say("{{result}}"),
			);
			const preview = "0 note(s), 2 wake-up(s)";
			await sendAndWaitForReply(
				client,
				bot,
				script(
					call("subagent", {
						agent: "general",
						tasks: [{ intent: "e2e.source", task: setUp }],
					}),
					say(`SOURCE-STARTED-${runId}`),
					// Once the worker has reported what its source_set said.
					say("{{match:0 note\\(s\\), 2 wake-up\\(s\\)}}"),
				),
				{ matches: (text) => text === preview, timeoutMs: MINUTE },
			);
			// The agent's own wake-up, though a worker set the source.
			await waitForBotMessage(client, bot, {
				matches: (text) => text === fired,
				timeoutMs: 30 * SECOND,
			});

			// Its next look over the sources (every 15 seconds) has read it.
			await new Promise((resolve) => setTimeout(resolve, 10 * SECOND));
			const reply = await sendAndWaitForReply(
				client,
				bot,
				script(say(`{{match:${mark}\\d+}}`)),
				{ matches: isAnswer, timeoutMs: MINUTE },
			);
			assert.equal(reply, `${mark}3`);

			assert.equal(count(await schedules(), wake), 1);
			await sendAndWaitForReply(
				client,
				bot,
				script(call("source_delete", { name: "watch" }), say("{{result}}")),
				{ matches: isAnswer, timeoutMs: MINUTE },
			);
			assert.equal(count(await schedules(), wake), 0);
		},
	);
});
