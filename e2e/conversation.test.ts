// Contract: one conversation, as the user lives it. The agent is who its
// prompt says; it hears voice messages (photos: `e2e/photo.test.ts`). While
// it works the chat shows "typing…", and only finished answers arrive; a
// message that needs no words back gets an emoji reaction instead. A
// real uploaded XLSX is edited through code mode and returned as downloadable
// bytes with typed literals and working formulas. A background general subagent
// edits its own copy of the immutable source; the parent delivers its export.
// Uploaded DOCX and PPTX likewise return real edited bytes, retaining fragmented
// Word formatting, tables and slide layout; originals return byte-for-byte intact.
// These RAM files are used before the restart (not expected to survive it). A
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { Model } from "@ironcalc/nodejs";
import type { Client } from "tdl";

import { DEFAULT_PROMPT, type RunningBot, startBot } from "./bot.ts";
import {
	createPresentationFixture,
	createWordFixture,
	inspectPresentation,
	inspectWord,
} from "./office.ts";
import {
	botCommands,
	botUsername,
	connectTestUser,
	recentMessages,
	sendAndWaitForDocument,
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

test("conversation: persona, voice, spreadsheets, general, Office documents, restart, fallback and compaction", {
	timeout: 18 * MINUTE,
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

	await t.test(
		"edits an uploaded XLSX and delivers real typed cells and formulas",
		async () => {
			const sourcePath = path.join(directory, `source-${runId}.xlsx`);
			const source = new Model("Source", "en", "UTC", "en");
			source.renameSheet(0, "Data");
			source.updateCellWithText(0, 1, 1, runId);
			source.updateCellWithNumber(0, 2, 1, 10);
			source.updateCellWithNumber(0, 2, 2, 5);
			source.updateCellWithFormula(0, 2, 3, "=SUM(A2,B2)");
			source.updateCellWithText(0, 2, 4, "00123");
			source.updateCellWithText(0, 2, 5, "2026-10-08");
			source.updateCellWithText(0, 2, 6, "=literal");
			source.updateCellWithBool(0, 2, 7, true);
			source.updateCellWithText(0, 2, 8, "clear me");
			source.evaluate();
			source.saveToXlsx(sourcePath);

			const fileName = `edited-${runId}.xlsx`;
			const completed = `XLSX-DONE-${runId}`;
			const attachment = await sendAndWaitForDocument(
				client,
				bot,
				{
					documentPath: sourcePath,
					caption:
						"Use code mode spreadsheet tools to open an editable copy of this XLSX. " +
						"On Data set A2 to numeric 20, B2 to numeric 7, C2 to the formula =SUM(A2,B2). " +
						"Write D2 as literal text 00123, E2 as literal text 2026-10-08, " +
						"F2 as literal text =literal (NOT a formula), G2 as boolean false, and clear H2. " +
						"Then insert one entire row at row 2, letting the formula references update, " +
						"and rename Data to Edited. Preserve A1 and all other cells. " +
						"Style A1 with Arial, 14-point font and bold. " +
						`Export as ${fileName} and send me the actual XLSX document through Telegram. ` +
						"Keep the original uploaded file available unchanged for my next request. " +
						`After sending the document reply with only ${completed}.`,
				},
				{
					fileName,
					matches: (text) => text.includes(completed),
					timeoutMs: 3 * MINUTE,
				},
			);
			assert.equal(attachment.fileName, fileName);
			assert.equal(
				attachment.mimeType,
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			);
			const exportedPath = path.join(directory, fileName);
			writeFileSync(exportedPath, attachment.data);
			const edited = Model.fromXlsx(exportedPath, "en", "UTC", "en");
			assert.deepEqual(
				edited.getWorksheetsProperties().map(({ name }) => name),
				["Edited"],
			);
			assert.equal(edited.getCellValue(0, 1, 1), runId);
			const headingFont = edited.getCellStyle(0, 1, 1).font;
			assert.equal(headingFont?.name, "Arial");
			assert.equal(headingFont?.sz, 14);
			assert.equal(headingFont?.b, true);
			assert.equal(edited.getCellValue(0, 2, 1), null);
			assert.equal(edited.getCellValue(0, 3, 1), 20);
			assert.equal(edited.getCellValue(0, 3, 2), 7);
			assert.equal(edited.getCellFormula(0, 3, 3), "=SUM(A3,B3)");
			edited.evaluate();
			assert.equal(edited.getCellValue(0, 3, 3), 27);
			for (const [column, value] of [
				[4, "00123"],
				[5, "2026-10-08"],
				[6, "=literal"],
			] as const) {
				assert.equal(edited.getCellValue(0, 3, column), value);
				assert.equal(edited.getCellType(0, 3, column), 2);
				assert.equal(edited.getCellFormula(0, 3, column), null);
			}
			assert.equal(edited.getCellValue(0, 3, 7), false);
			assert.equal(edited.getCellValue(0, 3, 8), null);
		},
	);

	await t.test(
		"general edits an isolated source copy in the background and parent delivers it",
		async () => {
			const fileName = `general-${runId}.xlsx`;
			const started = `GENERAL-START-${runId}`;
			const completed = `GENERAL-DONE-${runId}`;
			const attachment = await sendAndWaitForDocument(
				client,
				bot,
				{
					text:
						"Delegate this whole editing task to a general subagent in the background, " +
						"do not edit it yourself. Pass it the original uploaded " +
						`source-${runId}.xlsx fileId (not the edited export), and these complete requirements: ` +
						"Open your own editable copy using code mode spreadsheet tools. " +
						"Read Data A2 and B2 before editing and report their original numeric values. " +
						"Set A2 to numeric 40 and B2 to numeric 2; preserve the existing C2 formula. " +
						"Write D2 as literal text 00456, E2 as literal text 2027-01-02, " +
						"F2 as literal text =not a formula, G2 as boolean false, and clear H2. " +
						"Preserve A1 and all other cells, including sheet name Data. " +
						`Export as ${fileName}, return its exported fileId and the original A2/B2 values ` +
						"to the parent in text; do not send Telegram messages or file bytes. " +
						`You (the parent) should first acknowledge with only ${started}. ` +
						"When general finishes, send me its actual exported XLSX document through Telegram, " +
						`then reply with ${completed} and its reported original values in the form SOURCE=<A2>,<B2>.`,
				},
				{
					fileName,
					matches: (text) => text.includes(completed),
					timeoutMs: 3 * MINUTE,
				},
			);
			assert.ok(
				attachment.texts.some((text) => text.includes(started)),
				`Missing background acknowledgement; received: ${attachment.texts.join(" | ")}`,
			);
			assert.ok(
				attachment.texts.findIndex((text) => text.includes(started)) <
					attachment.texts.findIndex((text) => text.includes(completed)),
				"Background acknowledgement must precede completion",
			);
			assert.match(attachment.reply, /SOURCE=10,5/);
			assert.equal(
				attachment.mimeType,
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			);
			const exportedPath = path.join(directory, fileName);
			writeFileSync(exportedPath, attachment.data);
			const edited = Model.fromXlsx(exportedPath, "en", "UTC", "en");
			assert.deepEqual(
				edited.getWorksheetsProperties().map(({ name }) => name),
				["Data"],
			);
			assert.equal(edited.getCellValue(0, 1, 1), runId);
			assert.equal(edited.getCellValue(0, 2, 1), 40);
			assert.equal(edited.getCellValue(0, 2, 2), 2);
			assert.equal(edited.getCellFormula(0, 2, 3), "=SUM(A2,B2)");
			edited.evaluate();
			assert.equal(edited.getCellValue(0, 2, 3), 42);
			for (const [column, value] of [
				[4, "00456"],
				[5, "2027-01-02"],
				[6, "=not a formula"],
			] as const) {
				assert.equal(edited.getCellValue(0, 2, column), value);
				assert.equal(edited.getCellType(0, 2, column), 2);
				assert.equal(edited.getCellFormula(0, 2, column), null);
			}
			assert.equal(edited.getCellValue(0, 2, 7), false);
			assert.equal(edited.getCellValue(0, 2, 8), null);
		},
	);

	await t.test(
		"edits an uploaded DOCX across formatted runs and a table cell, preserving the original",
		async () => {
			const sourceName = `word-source-${runId}.docx`;
			const sourcePath = path.join(directory, sourceName);
			const sourceBytes = await createWordFixture(runId);
			writeFileSync(sourcePath, sourceBytes);
			const source = await inspectWord(sourceBytes);
			assert.equal(source.paragraphs[0]?.text, "Before old phrase after.");
			assert.ok(
				source.paragraphs[0]?.runs.some(
					(run) => run.text === "old " && run.format.bold,
				),
			);
			assert.ok(
				source.paragraphs[0]?.runs.some(
					(run) => run.text === "phrase" && run.format.italic,
				),
			);
			const fileName = `word-edited-${runId}.docx`;
			const completed = `DOCX-DONE-${runId}`;
			const attachment = await sendAndWaitForDocument(
				client,
				bot,
				{
					documentPath: sourcePath,
					caption:
						"Use code mode: discover the DOCX tool schemas before calling them; open this uploaded file as an editable copy. " +
						"Read its paragraphs and table. Use literal replacement to replace old phrase with new phrase " +
						"across the existing formatted runs, preserving the first matched run's bold red formatting " +
						"and the surrounding text/formatting. Do not rewrite the whole paragraph. " +
						"Set table 1 row 2 column 2 to Approved. Preserve all other paragraphs, table cells and layout. " +
						`Export as ${fileName} and send the actual DOCX through Telegram. ` +
						`Also send the unchanged original uploaded fileId as ${sourceName}, not a working-copy export. ` +
						"No preview or PDF is needed. " +
						`Only after both documents have been sent, reply with only ${completed}.`,
				},
				{
					fileName,
					additionalFileNames: [sourceName],
					matches: (text) => text.includes(completed),
					timeoutMs: 3 * MINUTE,
				},
			);
			assert.equal(attachment.fileName, fileName);
			assert.equal(
				attachment.mimeType,
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			);
			assert.equal(attachment.additionalDocuments[0]?.fileName, sourceName);
			assert.deepEqual(attachment.additionalDocuments[0]?.data, sourceBytes);
			const edited = await inspectWord(attachment.data);
			assert.equal(edited.paragraphs.length, source.paragraphs.length);
			assert.equal(edited.paragraphs[0]?.text, "Before new phrase after.");
			assert.deepEqual(edited.paragraphs.slice(1), source.paragraphs.slice(1));
			assert.deepEqual(
				edited.paragraphs[0]?.format,
				source.paragraphs[0]?.format,
			);
			const replacement = edited.paragraphs[0]?.runs.find((run) =>
				run.text.includes("new phrase"),
			);
			assert.ok(replacement, "Replacement must remain in a formatted run");
			assert.equal(replacement.format.bold, true);
			assert.equal(replacement.format.color, "AA0000");
			for (const text of ["Before ", " after."]) {
				assert.deepEqual(
					edited.paragraphs[0]?.runs.find((run) => run.text === text),
					source.paragraphs[0]?.runs.find((run) => run.text === text),
				);
			}
			assert.equal(source.tables[0]?.rows[1]?.[1]?.text, "Pending");
			const expectedTables = structuredClone(source.tables);
			const cell = expectedTables[0]?.rows[1]?.[1];
			assert.ok(cell);
			cell.text = "Approved";
			assert.deepEqual(edited.tables, expectedTables);
		},
	);

	await t.test(
		"edits an uploaded PPTX title while preserving other shapes, slides and the original",
		async () => {
			const sourceName = `slides-source-${runId}.pptx`;
			const sourcePath = path.join(directory, sourceName);
			const sourceBytes = await createPresentationFixture(runId);
			writeFileSync(sourcePath, sourceBytes);
			const source = await inspectPresentation(sourceBytes);
			assert.equal(source.slides.length, 2);
			const fileName = `slides-edited-${runId}.pptx`;
			const completed = `PPTX-DONE-${runId}`;
			const attachment = await sendAndWaitForDocument(
				client,
				bot,
				{
					documentPath: sourcePath,
					caption:
						"Use code mode: discover the PPTX tool schemas before calling them; open this uploaded presentation as an editable copy. " +
						"Inspect slides and shapes to discover their IDs; do not guess IDs or rebuild the deck. " +
						`Change only the first slide's title text Old title ${runId} to New title ${runId}. ` +
						"Preserve its formatting, bounds and layout, every other shape on that slide, " +
						"and the entire second slide including its text and decorative ellipse. Keep exactly two slides in the same order. " +
						`Export as ${fileName} and send the actual PPTX through Telegram. ` +
						`Also send the unchanged original uploaded fileId as ${sourceName}, not a working-copy export. ` +
						"No preview or PDF is needed. " +
						`Only after both documents have been sent, reply with only ${completed}.`,
				},
				{
					fileName,
					additionalFileNames: [sourceName],
					matches: (text) => text.includes(completed),
					timeoutMs: 3 * MINUTE,
				},
			);
			assert.equal(attachment.fileName, fileName);
			assert.equal(
				attachment.mimeType,
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			);
			assert.equal(attachment.additionalDocuments[0]?.fileName, sourceName);
			assert.deepEqual(attachment.additionalDocuments[0]?.data, sourceBytes);
			const edited = await inspectPresentation(attachment.data);
			const expected = structuredClone(source);
			const title = expected.slides[0]?.shapes.find(
				(shape) => shape.text === `Old title ${runId}`,
			);
			assert.ok(title, "Fixture must have an editable first-slide title");
			title.text = `New title ${runId}`;
			assert.deepEqual(edited, expected);
		},
	);

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
