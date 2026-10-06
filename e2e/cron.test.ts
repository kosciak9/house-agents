// Contract: the agent can create a recurring cron schedule that wakes it up,
// list it, and delete it so it stops firing; a recurring schedule would fire
// again within the minute after deletion.
// Runs its own bot process on an empty session, so no schedule outlives the
// test. Takes about 2 minutes: cron fires on full minutes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
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

let runningBot: RunningBot;
let client: Client;
let bot: string;

before(async () => {
	runningBot = await startBot();
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
});

test("cron: create → fires → listed → deleted → stops", {
	timeout: 6 * MINUTE,
}, async (t) => {
	await t.test("creates a recurring cron", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			`Utwórz crona "* * * * *" (co minutę, cyklicznie) z etykietą "${label}". ` +
				`Prompt crona: "Odpowiedz dokładnie tekstem: ${token}". ` +
				"Potwierdź jednym zdaniem.",
			{ matches: isNotTick, timeoutMs: 2 * MINUTE },
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
			"Wywołaj cron_list i wypisz etykiety wszystkich zaplanowanych zadań.",
			{ matches: isNotTick, timeoutMs: 2 * MINUTE },
		);
		assert.match(list, new RegExp(label, "i"));
	});

	await t.test("deletes the schedule", async () => {
		await sendAndWaitForReply(client, bot, `Usuń crona "${label}".`, {
			matches: isNotTick,
			timeoutMs: 2 * MINUTE,
		});
	});

	await t.test("does not fire after deletion", async () => {
		// A tick already queued before the deletion may still land right after
		// it; only ticks after that grace period break the contract.
		await new Promise((resolve) => setTimeout(resolve, 10_000));
		await expectNoBotMessage(client, bot, {
			matches: isTick,
			durationMs: 75_000,
		});
	});
});
