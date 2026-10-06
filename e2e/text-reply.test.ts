// Contract: a text message in the bot's chat gets an agent reply.
// Requires the bot running against the test environment (pnpm dev with
// TELEGRAM_ENVIRONMENT=test).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
} from "./telegram/client.ts";

let client: Client;

before(async () => {
	client = await connectTestUser();
});

after(async () => {
	await client.close();
});

test("Telegram text → agent → reply", async () => {
	const reply = await sendAndWaitForReply(
		client,
		botUsername(),
		"Odpowiedz dokładnie jednym słowem, małymi literami: pong",
	);

	assert.match(reply.toLowerCase(), /pong/);
});
