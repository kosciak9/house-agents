// Contract: the agent can create a recurring cron schedule that wakes it up,
// list it, and delete it so it stops firing; a recurring schedule would fire
// again within the minute after deletion. A wake-up that has nothing to tell
// the user fires without a message in the chat.
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
// Only the silent wake-up's prompt carries it: the agent knows it once that
// wake-up has fired.
const code = `SILENT-${token}`;

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

test("cron: create → fires → listed → deleted → stops; silent wake-up", {
	timeout: 7 * MINUTE,
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

	await t.test("deletes the schedule, sets a silent wake-up", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			`Usuń crona "${label}". Ustaw też pobudkę za 30 sekund z promptem: ` +
				`"Kontrola w tle, kod ${code}. Wszystko w porządku, nie ma nic ` +
				'do przekazania użytkownikowi." Potwierdź jednym zdaniem.',
			{ matches: isNotTick, timeoutMs: 2 * MINUTE },
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
		const reply = await sendAndWaitForReply(
			client,
			bot,
			"Jaki kod był w ostatniej pobudce? Odpowiedz samym kodem.",
			{ matches: isNotTick, timeoutMs: 2 * MINUTE },
		);
		assert.match(reply, new RegExp(code, "i"));
	});
});
