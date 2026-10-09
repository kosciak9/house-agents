// Contract: the agent can create a recurring cron schedule that wakes it up,
// list it, and delete it so it stops firing; a recurring schedule would fire
// again within the minute after deletion. A wake-up that has nothing to tell
// the user fires without a message in the chat. The scripted model
// (`e2e/scripted-model.ts`) makes the tool calls, so this tests the scheduler,
// not a model's judgement.
// Runs its own bot process on an empty session, so no schedule outlives the
// test. Takes about 3 minutes: cron fires on full minutes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import { call, SCRIPTED_MODEL, say, script } from "./scripted-model.ts";
import {
	botUsername,
	connectTestUser,
	expectNoBotMessage,
	sendAndWaitForReply,
	waitForBotMessage,
} from "./telegram/client.ts";

const MINUTE = 60_000;

// Unique per run, so ticks of a schedule left over from an earlier run never
// count as ticks of this one.
const token = `CRON-TICK-${Date.now().toString(36).toUpperCase()}`;
const label = `e2e-${token.toLowerCase()}`;
// A tick is a message that is just the token; confirmations and listings may
// quote it among other text and must not count.
const isTick = (text: string) =>
	new RegExp(`^[\\s"'\`*.!]*${token}[\\s"'\`*.!]*$`).test(text);
const isNotTick = (text: string) => !isTick(text);
// The label of a wake-up the silent one schedules: listed once it has fired.
const code = `SILENT-${token}`;
const isListed = (list: string, name: string) => list.includes(`] ${name}:`);

let runningBot: RunningBot;
let client: Client;
let bot: string;

before(async () => {
	runningBot = await startBot({ model: SCRIPTED_MODEL });
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
});

test("cron: create → fires → listed → deleted → stops; silent wake-up", {
	timeout: 7 * MINUTE,
}, async (t) => {
	await t.test("creates a recurring cron", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			script(
				call("cron_create", {
					cron: "* * * * *",
					prompt: script(say(token)),
					recurring: true,
					label,
				}),
				say("{{result}}"),
			),
			{ matches: isNotTick, timeoutMs: MINUTE },
		);
	});

	await t.test("fires on the next minute", async () => {
		await waitForBotMessage(client, bot, {
			matches: isTick,
			timeoutMs: 2 * MINUTE,
		});
	});

	await t.test("lists the schedule", async () => {
		const list = await sendAndWaitForReply(
			client,
			bot,
			script(call("cron_list", {}), say("{{result}}")),
			{ matches: isNotTick, timeoutMs: MINUTE },
		);
		assert.ok(isListed(list, label), `Not listed: ${list}`);
	});

	await t.test("deletes the schedule, sets a silent wake-up", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			script(
				// The id the listing gave the schedule.
				call("cron_delete", { id: `{{match:\\d+(?=\\] ${label}:)}}` }),
				call("schedule_wakeup", {
					delaySeconds: 30,
					prompt: script(
						call("schedule_wakeup", {
							delaySeconds: 3600,
							prompt: script(say("NO_REPLY")),
							reason: code,
						}),
						say("NO_REPLY"),
					),
				}),
				say("{{result}}"),
			),
			{ matches: isNotTick, timeoutMs: MINUTE },
		);
	});

	await t.test("stays silent: no tick, no wake-up message", async () => {
		// A tick already queued before the deletion may still land right after
		// it; only messages after that grace period break the contract.
		await new Promise((resolve) => setTimeout(resolve, 10_000));
		await expectNoBotMessage(client, bot, {
			matches: () => true,
			durationMs: 75_000,
		});
	});

	await t.test("the silent wake-up did fire", async () => {
		const list = await sendAndWaitForReply(
			client,
			bot,
			script(call("cron_list", {}), say("{{result}}")),
			{ matches: isNotTick, timeoutMs: MINUTE },
		);
		assert.ok(isListed(list, code), `Not listed: ${list}`);
		assert.ok(!isListed(list, label), `Still listed: ${list}`);
	});
});
