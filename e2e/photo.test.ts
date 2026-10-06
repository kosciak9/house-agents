// Contract: the agent sees the photos it is sent.
// Its own file, so the photo opens the conversation: after an earlier exchange
// gpt-6-luna, with tools on offer, often misreads an image it is sent.
// Runs its own bot process on an empty session.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import { COLORS, solidPng } from "./image.ts";
import {
	botUsername,
	connectTestUser,
	sendPhotoAndWaitForReply,
} from "./telegram/client.ts";

// Random per run, so the agent cannot pass by guessing the same color.
const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? COLORS[0];

const directory = mkdtempSync(path.join(tmpdir(), "e2e-photo-"));
const imageFile = path.join(directory, "color.png");

let runningBot: RunningBot;
let client: Client;

before(async () => {
	writeFileSync(imageFile, solidPng(color.rgb, 256));
	runningBot = await startBot();
	client = await connectTestUser();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("sees the photo it is sent", async () => {
	const reply = await sendPhotoAndWaitForReply(
		client,
		botUsername(),
		imageFile,
		"Jaki kolor ma to zdjęcie? Odpowiedz jednym słowem po polsku.",
	);

	assert.match(reply, color.answer);
});
