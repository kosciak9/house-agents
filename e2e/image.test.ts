// Contract: a photo sent to the chat reaches the model as an image, so the
// agent answers about what the photo shows.
// Runs its own bot process on an empty session.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import {
	botUsername,
	connectTestUser,
	sendPhotoAndWaitForReply,
} from "./telegram/client.ts";

const COLORS = [
	{ rgb: [220, 20, 20], answer: /czerwon/i },
	{ rgb: [20, 180, 20], answer: /zielon/i },
	{ rgb: [20, 40, 220], answer: /niebiesk/i },
] as const;

// Random per run, so the agent cannot pass by guessing the same color.
const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? COLORS[0];

const pngChunk = (type: string, data: Buffer): Buffer => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, checksum]);
};

// A square PNG of one color.
const solidPng = (rgb: readonly number[], size: number): Buffer => {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.writeUInt8(8, 8); // bit depth
	header.writeUInt8(2, 9); // truecolor RGB
	const row = Buffer.concat([
		Buffer.from([0]), // no filter
		Buffer.from(Array.from({ length: size }, () => rgb).flat()),
	]);
	const pixels = Buffer.concat(Array.from({ length: size }, () => row));

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(pixels)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
};

const imageDirectory = mkdtempSync(path.join(tmpdir(), "e2e-image-"));
const imageFile = path.join(imageDirectory, "color.png");

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
	rmSync(imageDirectory, { recursive: true, force: true });
});

test("image: the agent sees the photo it is sent", async () => {
	const reply = await sendPhotoAndWaitForReply(
		client,
		botUsername(),
		imageFile,
		"Jaki kolor ma to zdjęcie? Odpowiedz jednym słowem po polsku.",
		{ timeoutMs: 2 * 60_000 },
	);

	assert.match(reply, color.answer);
});
