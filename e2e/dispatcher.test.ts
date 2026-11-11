// Contract: with a dispatcher (`config.worker.dispatcher`), the agent's general
// task reaches its worker as the dispatcher wrote it, not as the agent asked;
// an answer the harness cannot read leaves the task as the agent wrote it. The
// scripted model (`e2e/scripted-model.ts`) answers as the agent, as the
// dispatcher (its prompt is a script) and as the worker (each brief is one),
// so this tests the harness, not a model's judgement.
// Runs its own bot process on an empty session. Takes about a minute.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import { call, SCRIPTED_MODEL, say, script } from "./scripted-model.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
} from "./telegram/client.ts";

const MINUTE = 60_000;

const runId = Date.now().toString(36).toUpperCase();
// What the worker says when it gets the dispatcher's brief, and its own task.
const briefed = `BRIEFED-${runId}`;
const asked = `ASKED-${runId}`;

const directory = mkdtempSync(path.join(tmpdir(), "e2e-dispatcher-"));

let runningBot: RunningBot;
let client: Client;
let bot: string;

before(async () => {
	runningBot = await startBot({
		stateDir: directory,
		model: SCRIPTED_MODEL,
		smallModel: SCRIPTED_MODEL,
		worker: {
			models: {
				strong: { model: SCRIPTED_MODEL, description: "For hard tasks." },
			},
			dispatcher: {
				model: SCRIPTED_MODEL,
				// One task's model and brief; the brief is the worker's script.
				prompt: script(
					say(
						JSON.stringify([
							{
								model: "strong",
								brief: script(say(`Status: done\n${briefed}`)),
							},
						]),
					),
				),
			},
		},
	});
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	rmSync(directory, { recursive: true, force: true });
});

// The agent's report once its tasks have answered: the marker, when a worker
// answered it (the report repeats the agent's tasks too, so the match must sit
// in an answer).
const delegate = (tasks: { intent: string; task: string }[], marker: string) =>
	sendAndWaitForReply(
		client,
		bot,
		script(
			call("subagent", { agent: "general", tasks }),
			say(`STARTED-${runId}`),
			say(`{{match:(?<=<answer>\\nStatus: done\\n)${marker}}}`),
		),
		{ matches: (text) => text === marker, timeoutMs: MINUTE },
	);

test("dispatcher: briefs the workers", { timeout: 3 * MINUTE }, async (t) => {
	await t.test("the worker gets the dispatcher's brief", async () => {
		await delegate(
			[
				{
					intent: "e2e.dispatch",
					task: script(say(`Status: done\n${asked}`)),
				},
			],
			briefed,
		);
	});

	await t.test(
		"tasks the dispatcher's answer does not cover run as asked",
		async () => {
			// Two tasks against its one answer: the harness keeps the agent's.
			await delegate(
				[
					{
						intent: "e2e.dispatch",
						task: script(say(`Status: done\n${asked}`)),
					},
					{ intent: "e2e.dispatch", task: script(say("Status: done")) },
				],
				asked,
			);
		},
	);
});
