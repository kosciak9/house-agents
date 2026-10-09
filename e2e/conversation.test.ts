// Contract: one conversation, as the user lives it. The agent is who its
// prompt says; it hears voice messages (photos: `e2e/photo.test.ts`). While
// it works the chat shows "typing…", and only finished answers arrive; a
// message that needs no words back gets an emoji reaction instead. A
// full process restart keeps the conversation and its pending wake-ups: one
// that fell due while the bot was down reaches the chat once it is back.
// It comes back on a model that fails, xAI's, which E2E never logs in to:
// the chat hears so, and the fallback model answers in its place from then
// on. The chat's menu offers /compact, which says when it starts and when it
// is done. After it ends the conversation and starts a new context, the agent
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
	botCommands,
	botUsername,
	connectTestUser,
	recentMessages,
	sendAndWaitForReaction,
	sendAndWaitForReply,
	sendVoiceAndWaitForReply,
	waitForBotMessage,
	watchBotActivity,
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
let initialUsage = 0;

const usedTokens = (text: string): number => {
	const match = /Razem: ([\d\s]+) tokenów/.exec(text);
	assert.ok(match, `Missing token total in: ${text}`);
	return Number(match[1].replace(/\s/g, ""));
};

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

test("conversation: persona, voice, restart, fallback and compaction", {
	timeout: 12 * MINUTE,
}, async (t) => {
	await t.test("introduces itself by its prompt's name", async () => {
		assert.match(
			await say("Jak masz na imię? Odpowiedz jednym słowem."),
			/Zefiryn/i,
		);
	});

	await t.test(
		"diagnostics report tokens and estimated USD without calling the model",
		async () => {
			const usage = await say("/diagnostics usage");
			for (const label of [
				"Input:",
				"Output:",
				"Cache read:",
				"Cache write:",
				"Koszt szacunkowy (USD): $",
			])
				assert.ok(usage.includes(label), `Missing ${label}`);
			initialUsage = usedTokens(usage);
			assert.ok(initialUsage > 0);
			assert.match(usage, /Koszt szacunkowy \(USD\): \$(?!0\.000000)\d+\.\d+/);
			const current = await say("/diagnostics current");
			assert.equal(
				current.split("\n").slice(1).join("\n"),
				usage.split("\n").slice(1).join("\n"),
			);
			assert.match(await say("/diagnostics memory"), /Pamięć jest pusta/);
			assert.equal(await say("/diagnostics usage"), usage);
		},
	);

	await t.test("answers what a voice message says", async () => {
		const reply = await sendVoiceAndWaitForReply(client, bot, VOICE_FILE, {
			matches: isNotTick,
			timeoutMs: 2 * MINUTE,
		});
		assert.match(reply, /pary/i);
	});

	await t.test("hears a fact and schedules a wake-up, typing", async () => {
		const activity = await watchBotActivity(client, bot);
		await say(
			`Mam nowego kota, wabi się ${cat}. ` +
				`Ustaw też pobudkę za ${WAKEUP_DELAY_SECONDS} sekund z promptem: ` +
				`"Odpowiedz dokładnie tekstem: ${token}". Potwierdź jednym zdaniem.`,
		);
		// While it works, even through tool calls, the chat sees "typing…" and
		// only the finished answer: nothing streams.
		assert.deepEqual(activity.stop(), { typing: true, drafts: false });
	});

	await t.test("stays down past the wake-up's due time", async () => {
		await runningBot?.stop();
		runningBot = undefined;
		await new Promise((resolve) =>
			setTimeout(resolve, (WAKEUP_DELAY_SECONDS + 10) * 1000),
		);
	});

	await t.test(
		"delivers the missed wake-up after restart, on the fallback",
		async () => {
			const ticked = waitForBotMessage(client, bot, {
				matches: isTick,
				timeoutMs: 2 * MINUTE,
			});
			const warned = waitForBotMessage(client, bot, {
				matches: (text) => /xai\/grok-4\.7.*gpt-6-luna/is.test(text),
				timeoutMs: 2 * MINUTE,
			});
			runningBot = await startBot({
				stateDir: directory,
				prompt: PROMPT,
				model: { provider: "xai", modelId: "grok-4.7" },
				fallbackModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
			});
			await Promise.all([ticked, warned]);
		},
	);

	await t.test("still knows the conversation after restart", async () => {
		assert.match(
			await say("Jak wabi się mój kot? Odpowiedz samym imieniem."),
			new RegExp(cat, "i"),
		);
		assert.ok(usedTokens(await say("/diagnostics usage")) > initialUsage);
	});

	await t.test("answers thanks with a reaction alone", async () => {
		const thanks = "Dzięki! Wystarczy sama reakcja 👍, bez słów.";
		const emoji = await sendAndWaitForReaction(client, bot, thanks, {
			timeoutMs: 2 * MINUTE,
		});
		assert.equal(emoji, "👍");
		assert.deepEqual(await recentMessages(client, bot, 1), [thanks]);
	});

	await t.test("hears a long quote", async () => {
		await say(
			"Wycena remontu łazienki od firmy Kafelek, pozycja po pozycji: " +
				`${quote.map(([item, price]) => `${item} ${price} zł`).join(", ")}. ` +
				"Potwierdź jednym zdaniem, bez powtarzania pozycji.",
		);
	});

	await t.test("offers /compact in the chat's menu", async () => {
		assert.ok((await botCommands(client, bot)).includes("compact"));
	});

	await t.test("knows both in a new context", async () => {
		await sendAndWaitForReply(client, bot, "/compact", {
			matches: (text) => /skompaktowana/i.test(text),
			timeoutMs: MINUTE,
		});
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

	await t.test(
		"diagnostics current resets at compaction, memory is read-only and zoomable",
		async () => {
			const usage = await say("/diagnostics usage");
			const current = await say("/diagnostics current");
			assert.ok(usedTokens(current) > 0);
			assert.ok(usedTokens(current) < usedTokens(usage));
			const memory = await say("/diagnostics memory");
			assert.match(memory, /Pamięć — 1 zakończonych sesji/);
			const leaf = /\[[0-9a-f]{8}\] [^\n]+/.exec(memory)?.[0];
			assert.ok(leaf, `Missing saved memory in: ${memory}`);
			assert.ok((await say("/diagnostics memory #0-1")).includes(leaf));
			assert.match(await say("/diagnostics memory #1-2"), /Użycie:/);
			assert.equal(await say("/diagnostics memory"), memory);
			assert.equal(await say("/diagnostics usage"), usage);
		},
	);
});
