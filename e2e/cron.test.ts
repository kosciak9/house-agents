// Contract: the agent can create a recurring cron schedule that wakes it up,
// list it, and delete it so it stops firing; the schedule fires every 10
// seconds, so it would fire again within the silence after deletion. A
// wake-up (wake_at, at a wall time in the user's time zone or after a delay)
// that has nothing
// to tell the user fires without a message in the chat; two notes for one
// moment wake the agent once, and a daily one waits for the next day. Its
// prompt lists its wake-ups, and each message
// opens with its time in the user's zone. The scripted model
// (`e2e/scripted-model.ts`) makes the tool calls, so this tests the
// scheduler, not a model's judgement.
// Runs its own bot process on an empty session, so no schedule outlives the
// test. A wake-up whose answer has not one letter sends nothing. Takes about
// three minutes.
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
const SECOND = 1000;

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

// Neither the process's zone nor a whole hour off UTC.
const ZONE = "Asia/Kathmandu";
// The wall time in `ZONE` of `time`, or `seconds` from now, as wake_at takes it.
const wallAt = (time: number) =>
	new Date(time).toLocaleString("sv-SE", { timeZone: ZONE });
const wallIn = (seconds: number) => wallAt(Date.now() + seconds * SECOND);

let runningBot: RunningBot;
let client: Client;
let bot: string;

before(async () => {
	runningBot = await startBot({ model: SCRIPTED_MODEL, timeZone: ZONE });
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
});

test("cron: create → fires → listed → deleted → stops; wake-ups", {
	timeout: 4 * MINUTE,
}, async (t) => {
	await t.test("creates a recurring cron", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			script(
				call("cron_create", {
					cron: "*/10 * * * * *",
					prompt: script(say(token)),
					recurring: true,
					label,
				}),
				say("{{result}}"),
			),
			{ matches: isNotTick, timeoutMs: MINUTE },
		);
	});

	await t.test("fires within 10 seconds", async () => {
		await waitForBotMessage(client, bot, {
			matches: isTick,
			timeoutMs: 30 * SECOND,
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
				call("wake_at", {
					// A delay from now, the other way to name the moment.
					at: "+5s",
					note: script(
						call("wake_at", {
							at: wallIn(3600),
							note: `${script(say("NO_REPLY"))}\n${code}`,
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
		await new Promise((resolve) => setTimeout(resolve, 5 * SECOND));
		await expectNoBotMessage(client, bot, {
			matches: () => true,
			durationMs: 20 * SECOND,
		});
	});

	await t.test("the silent wake-up did fire", async () => {
		const list = await sendAndWaitForReply(
			client,
			bot,
			script(call("cron_list", {}), say("{{result}}")),
			{ matches: isNotTick, timeoutMs: MINUTE },
		);
		assert.ok(list.includes(code), `Not listed: ${list}`);
		assert.ok(!isListed(list, label), `Still listed: ${list}`);
	});

	await t.test("a wake-up's answer without a letter is not sent", async () => {
		const quiet = `QUIET-${token}`;
		await sendAndWaitForReply(
			client,
			bot,
			script(
				call("wake_at", {
					at: wallIn(2),
					note: `${script(say("👍 …"))}\n${quiet}`,
				}),
				say("{{result}}"),
			),
			{ matches: isNotTick, timeoutMs: MINUTE },
		);
		await expectNoBotMessage(client, bot, {
			matches: (text) => text.includes("…") || text === "👍",
			durationMs: 12 * SECOND,
		});
		const list = await sendAndWaitForReply(
			client,
			bot,
			script(call("cron_list", {}), say("{{result}}")),
			{ matches: isNotTick, timeoutMs: MINUTE },
		);
		assert.ok(!list.includes(quiet), `Not fired: ${list}`);
	});

	await t.test(
		"one moment wakes once; the prompt lists it; messages carry their time",
		async () => {
			const joined = `JOINED-${token}`;
			// Far enough ahead to be listed before it fires, even on a slow turn.
			const at = wallIn(30);
			const before = wallIn(0).slice(0, 16);
			const reply = await sendAndWaitForReply(
				client,
				bot,
				script(
					call("wake_at", { at, note: script(say(joined)) }),
					call("wake_at", { at, note: `second note ${token}` }),
					say(
						"{{match:^\\[\\d\\d\\d\\d-\\d\\d-\\d\\d \\d\\d:\\d\\d\\]}} {{match:Your wake-ups[^\\n]*\\n- [^\\n]*}}",
					),
				),
				{ matches: isNotTick, timeoutMs: MINUTE },
			);
			const after = wallIn(0).slice(0, 16);
			assert.ok(
				reply.startsWith(`[${before}]`) || reply.startsWith(`[${after}]`),
				reply,
			);
			// The nearest wake-up is the joined one (Telegram renders the list
			// without its dashes).
			assert.ok(
				reply.split("\n")[1]?.includes(`${at.slice(0, 16)} `),
				JSON.stringify(reply),
			);
			const list = await sendAndWaitForReply(
				client,
				bot,
				script(call("cron_list", {}), say("{{result}}")),
				{ matches: isNotTick, timeoutMs: MINUTE },
			);
			assert.equal(
				list.split(`wakeup at ${at.slice(0, 16)}`).length - 1,
				1,
				list,
			);
			assert.ok(list.includes(`second note ${token}`), list);
			await waitForBotMessage(client, bot, {
				matches: (text) => text.includes(joined),
				timeoutMs: MINUTE,
			});
			await expectNoBotMessage(client, bot, {
				matches: (text) => text.includes(joined),
				durationMs: 8 * SECOND,
			});
		},
	);

	await t.test(
		"a daily wake-up fires, then waits for the next day",
		async () => {
			const daily = `DAILY-${token}`;
			// A whole minute, as the agent writes it, at least 5 seconds ahead.
			const base = Date.now() + 65 * SECOND;
			const at = wallAt(base).slice(0, 16);
			const next = wallAt(base + 24 * 60 * 60 * SECOND).slice(0, 16);
			await sendAndWaitForReply(
				client,
				bot,
				script(
					call("wake_at", { at, note: script(say(daily)), daily: true }),
					say("{{result}}"),
				),
				{ matches: isNotTick, timeoutMs: MINUTE },
			);
			await waitForBotMessage(client, bot, {
				matches: (text) => text.includes(daily),
				timeoutMs: 2 * MINUTE,
			});
			const list = await sendAndWaitForReply(
				client,
				bot,
				script(call("cron_list", {}), say("{{result}}")),
				{ matches: isNotTick, timeoutMs: MINUTE },
			);
			assert.ok(list.includes(`next at ${next}`), list);
		},
	);
});
