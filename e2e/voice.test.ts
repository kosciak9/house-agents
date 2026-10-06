// Contract: a voice message is transcribed (Whisper, WHISPER_API_URL) and the
// agent answers what was said.
// Runs its own bot process on an empty session. Needs espeak-ng and ffmpeg
// (devenv) to speak the question.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import {
	botUsername,
	connectTestUser,
	sendVoiceAndWaitForReply,
} from "./telegram/client.ts";

const QUESTION =
	"Jaka jest stolica Francji? Odpowiedz jednym słowem po polsku.";

// Speaks `text` in Polish into a Telegram voice note (mono OGG Opus).
const speak = (text: string, file: string): void => {
	const wav = `${file}.wav`;
	execFileSync("espeak-ng", ["-v", "pl", "-s", "140", "-w", wav, text]);
	execFileSync("ffmpeg", [
		...["-loglevel", "error", "-y", "-i", wav],
		...["-ac", "1", "-c:a", "libopus", "-b:a", "32k", file],
	]);
};

const voiceDirectory = mkdtempSync(path.join(tmpdir(), "e2e-voice-"));
const voiceFile = path.join(voiceDirectory, "question.ogg");

let runningBot: RunningBot;
let client: Client;

before(async () => {
	speak(QUESTION, voiceFile);
	runningBot = await startBot();
	client = await connectTestUser();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	rmSync(voiceDirectory, { recursive: true, force: true });
});

test("voice: the agent answers what was said", async () => {
	const reply = await sendVoiceAndWaitForReply(
		client,
		botUsername(),
		voiceFile,
		{ timeoutMs: 3 * 60_000 },
	);

	assert.match(reply, /pary/i);
});
