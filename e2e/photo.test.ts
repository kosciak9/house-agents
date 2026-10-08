// Contract: the agent sees the photos it is sent, and the pages of a PDF sent
// as a file. The photo opens the conversation: after an earlier exchange
// gpt-6-luna, with tools on offer, often misreads an image it is sent.
// Converting other files with Gotenberg is left to the deployment's use.
// Runs its own bot process on an empty session.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import { COLORS, solidPng } from "./image.ts";
import { textPdf } from "./pdf.ts";
import {
	botUsername,
	connectTestUser,
	sendDocumentAndWaitForReply,
	sendPhotoAndWaitForReply,
} from "./telegram/client.ts";

// Random per run, so the agent cannot pass by guessing the same answer.
const pick = <T>(values: readonly T[]): T =>
	values[Math.floor(Math.random() * values.length)] as T;
const color = pick(COLORS);
const word = pick(["MARCHEWKA", "PARASOL", "LATARNIA", "KOMPAS"]);

const directory = mkdtempSync(path.join(tmpdir(), "e2e-photo-"));
const imageFile = path.join(directory, "color.png");
const pdfFile = path.join(directory, "haslo.pdf");

let runningBot: RunningBot;
let client: Client;

before(async () => {
	writeFileSync(imageFile, solidPng(color.rgb, 256));
	writeFileSync(pdfFile, textPdf(`Haslo: ${word}`));
	runningBot = await startBot();
	client = await connectTestUser();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("photo and PDF", async (t) => {
	await t.test("sees the photo it is sent", async () => {
		const reply = await sendPhotoAndWaitForReply(
			client,
			botUsername(),
			imageFile,
			"Jaki kolor ma to zdjęcie? Odpowiedz jednym słowem po polsku.",
		);

		assert.match(reply, color.answer);
	});

	await t.test("reads a PDF sent as a file", async () => {
		const reply = await sendDocumentAndWaitForReply(
			client,
			botUsername(),
			pdfFile,
			"Jakie hasło jest w tym pliku? Odpowiedz samym hasłem.",
		);

		assert.match(reply, new RegExp(word, "i"));
	});
});
