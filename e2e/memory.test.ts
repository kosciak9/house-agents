// Contract: what the user tells the agent outlives the conversation's
// context. After /reset ends the conversation and starts a new context, the
// agent still knows it, down to details its memory has no room for.
// Runs its own bot process on an empty session.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
	sendToBot,
} from "./telegram/client.ts";

const MINUTE = 60_000;

// Unique per run, so an answer from an earlier run never satisfies this one.
const name = `Fik${Date.now().toString(36).slice(-4).toUpperCase()}`;
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

test("memory: a fact outlives a context reset", {
	timeout: 5 * MINUTE,
}, async (t) => {
	await t.test("hears the fact", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			`Mam nowego kota, wabi się ${name}. Potwierdź jednym zdaniem.`,
			{ timeoutMs: 2 * MINUTE },
		);
	});

	await t.test("knows it in a new context", async () => {
		await sendToBot(client, bot, "/reset");
		const reply = await sendAndWaitForReply(
			client,
			bot,
			"Jak wabi się mój kot? Odpowiedz samym imieniem.",
			{ timeoutMs: 2 * MINUTE },
		);
		assert.match(reply, new RegExp(name, "i"));
	});
});

// A conversation is remembered as one short line, which cannot hold a long
// list; the conversation behind it still has every item.
test("memory: a detail too small for the memory line outlives a context reset", {
	timeout: 5 * MINUTE,
}, async (t) => {
	await t.test("hears the details", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			"Wycena remontu łazienki od firmy Kafelek, pozycja po pozycji: " +
				`${quote.map(([item, price]) => `${item} ${price} zł`).join(", ")}. ` +
				"Potwierdź jednym zdaniem, bez powtarzania pozycji.",
			{ timeoutMs: 2 * MINUTE },
		);
	});

	await t.test("recalls one of them in a new context", async () => {
		await sendToBot(client, bot, "/reset");
		const reply = await sendAndWaitForReply(
			client,
			bot,
			`Ile Kafelek policzył za pozycję "${asked}"? Odpowiedz samą kwotą.`,
			{ timeoutMs: 3 * MINUTE },
		);
		assert.match(reply.replace(/\s/g, ""), new RegExp(String(askedPrice)));
	});
});
