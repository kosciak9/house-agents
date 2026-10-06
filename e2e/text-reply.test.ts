// Contract: a text message in the bot's chat gets an agent reply.
// Runs its own bot process on an empty session.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
} from "./telegram/client.ts";

let runningBot: RunningBot;
let client: Client;

before(async () => {
	runningBot = await startBot();
	client = await connectTestUser();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
});

test("Telegram text → agent → reply", async () => {
	const reply = await sendAndWaitForReply(
		client,
		botUsername(),
		"Odpowiedz dokładnie jednym słowem, małymi literami: pong",
	);

	assert.match(reply.toLowerCase(), /pong/);
});
