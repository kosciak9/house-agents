// Contract: one conversation, as the user lives it. The agent is who its
// prompt says; it hears voice messages (photos: `e2e/photo.test.ts`). A
// full process restart keeps the conversation and its pending wake-ups: one
// that fell due while the bot was down reaches the chat once it is back.
// After /reset ends the conversation and starts a new context, the agent
// still knows what it was told, down to details its memory has no room for.
// Runs its own bot processes on one session that outlives each of them; the
// steps build on each other, so they run as one chain.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { DEFAULT_PROMPT, type RunningBot, startBot } from "./bot.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
	sendToBot,
	sendVoiceAndWaitForReply,
	waitForBotMessage,
} from "./telegram/client.ts";

const MINUTE = 60_000;
const WAKEUP_DELAY_SECONDS = 20;
const PROMPT = `Masz na imię Zefiryn. ${DEFAULT_PROMPT}`;

// Unique per run, so a message from an earlier run never satisfies this one.
const runId = Date.now().toString(36).toUpperCase();
const token = `WAKEUP-${runId}`;
const cat = `Fik${runId.slice(-4)}`;
const isTick = (text: string) =>
	new RegExp(`^[\\s"'\`*.!]*${token}[\\s"'\`*.!]*$`).test(text);
const isNotTick = (text: string) => !isTick(text);

// Too long for the one line a conversation is remembered by.
const ITEMS = [
	"skucie płytek",
	"wywóz gruzu",
	"wylewka",
	"hydroizolacja",
	"hydraulika",
	"elektryka",
	"gładzie",
	"malowanie sufitu",
	"montaż brodzika",
	"montaż wanny",
	"montaż umywalki",
	"montaż WC",
	"stelaż podtynkowy",
	"kładzenie płytek",
	"fugowanie",
	"silikonowanie",
	"listwy",
	"drzwi",
	"wentylacja",
	"sprzątanie",
];
const quote = ITEMS.map(
	(item) => [item, 100 + Math.floor(Math.random() * 3900)] as const,
);
const [asked, askedPrice] = quote[14];

// "Jaka jest stolica Francji? Odpowiedz jednym słowem po polsku.", spoken by
// espeak-ng and encoded as a Telegram voice note (mono OGG Opus).
const VOICE_FILE = path.resolve("e2e/fixtures/question.ogg");

const directory = mkdtempSync(path.join(tmpdir(), "e2e-conversation-"));

let runningBot: RunningBot | undefined;
let client: Client;
let bot: string;

const say = (text: string) =>
	sendAndWaitForReply(client, bot, text, {
		matches: isNotTick,
		timeoutMs: 2 * MINUTE,
	});

before(async () => {
	runningBot = await startBot({ stateDir: directory, prompt: PROMPT });
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("conversation: persona, voice, restart and reset", {
	timeout: 8 * MINUTE,
}, async (t) => {
	await t.test("introduces itself by its prompt's name", async () => {
		assert.match(
			await say("Jak masz na imię? Odpowiedz jednym słowem."),
			/Zefiryn/i,
		);
	});

	await t.test("answers what a voice message says", async () => {
		const reply = await sendVoiceAndWaitForReply(client, bot, VOICE_FILE, {
			matches: isNotTick,
			timeoutMs: 2 * MINUTE,
		});
		assert.match(reply, /pary/i);
	});

	await t.test("hears a fact and schedules a wake-up", async () => {
		await say(
			`Mam nowego kota, wabi się ${cat}. ` +
				`Ustaw też pobudkę za ${WAKEUP_DELAY_SECONDS} sekund z promptem: ` +
				`"Odpowiedz dokładnie tekstem: ${token}". Potwierdź jednym zdaniem.`,
		);
	});

	await t.test("stays down past the wake-up's due time", async () => {
		await runningBot?.stop();
		runningBot = undefined;
		await new Promise((resolve) =>
			setTimeout(resolve, (WAKEUP_DELAY_SECONDS + 10) * 1000),
		);
	});

	await t.test("delivers the missed wake-up after restart", async () => {
		const ticked = waitForBotMessage(client, bot, {
			matches: isTick,
			timeoutMs: 2 * MINUTE,
		});
		runningBot = await startBot({ stateDir: directory, prompt: PROMPT });
		await ticked;
	});

	await t.test("still knows the conversation after restart", async () => {
		assert.match(
			await say("Jak wabi się mój kot? Odpowiedz samym imieniem."),
			new RegExp(cat, "i"),
		);
	});

	await t.test("hears a long quote", async () => {
		await say(
			"Wycena remontu łazienki od firmy Kafelek, pozycja po pozycji: " +
				`${quote.map(([item, price]) => `${item} ${price} zł`).join(", ")}. ` +
				"Potwierdź jednym zdaniem, bez powtarzania pozycji.",
		);
	});

	await t.test("knows both in a new context", async () => {
		await sendToBot(client, bot, "/reset");
		const reply = await sendAndWaitForReply(
			client,
			bot,
			`Jak wabi się mój kot i ile Kafelek policzył za pozycję "${asked}"? ` +
				"Odpowiedz w formacie: imię, kwota.",
			{ matches: isNotTick, timeoutMs: 3 * MINUTE },
		);
		assert.match(reply, new RegExp(cat, "i"));
		assert.match(reply.replace(/\s/g, ""), new RegExp(String(askedPrice)));
	});
});
