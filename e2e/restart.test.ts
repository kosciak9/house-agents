// Contract: a full process restart keeps the conversation and its pending
// wake-ups. A wake-up that fell due while the bot was down still reaches the
// chat once the bot is back, and the agent still remembers the earlier chat.
// Runs its own bot processes on one session that outlives each of them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
	waitForBotMessage,
} from "./telegram/client.ts";

const MINUTE = 60_000;
const WAKEUP_DELAY_SECONDS = 30;

const runId = Date.now().toString(36).toUpperCase();
// Unique per run, so a message from an earlier run never satisfies this one.
const token = `WAKEUP-${runId}`;
const word = `SLOWO-${runId}`;
const isTick = (text: string) =>
	new RegExp(`^[\\s"'\`*.!]*${token}[\\s"'\`*.!]*$`).test(text);
const isNotTick = (text: string) => !isTick(text);

const sessionDirectory = mkdtempSync(path.join(tmpdir(), "e2e-restart-"));
const sessionFile = path.join(sessionDirectory, "session.sqlite");

let runningBot: RunningBot | undefined;
let client: Client;
let bot: string;

before(async () => {
	runningBot = await startBot({ sessionFile });
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	rmSync(sessionDirectory, { recursive: true, force: true });
});

test("restart: conversation and due wake-up survive a full restart", {
	timeout: 6 * MINUTE,
}, async (t) => {
	await t.test("remembers a word and schedules a wake-up", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			`Zapamiętaj słowo: ${word}. ` +
				`Ustaw też pobudkę za ${WAKEUP_DELAY_SECONDS} sekund z promptem: ` +
				`"Odpowiedz dokładnie tekstem: ${token}". ` +
				"Potwierdź jednym zdaniem.",
			{ matches: isNotTick, timeoutMs: 2 * MINUTE },
		);
	});

	await t.test("stays down past the wake-up's due time", async () => {
		await runningBot?.stop();
		runningBot = undefined;
		await new Promise((resolve) =>
			setTimeout(resolve, (WAKEUP_DELAY_SECONDS + 15) * 1000),
		);
	});

	await t.test("delivers the missed wake-up after restart", async () => {
		const ticked = waitForBotMessage(client, bot, {
			matches: isTick,
			timeoutMs: 2 * MINUTE,
		});
		runningBot = await startBot({ sessionFile });
		await ticked;
	});

	await t.test("still remembers the conversation", async () => {
		const reply = await sendAndWaitForReply(
			client,
			bot,
			"Jakie słowo kazałem Ci zapamiętać? Odpowiedz samym słowem.",
			{ matches: isNotTick, timeoutMs: 2 * MINUTE },
		);
		assert.match(reply, new RegExp(word));
	});
});
