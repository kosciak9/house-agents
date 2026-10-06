// Contract: the agent speaks as the persona its deployment's prompt defines,
// not as a generic assistant.
// Runs its own bot process on an empty session, as an agent defined here.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { DEFAULT_PROMPT, type RunningBot, startBot } from "./bot.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
} from "./telegram/client.ts";

const NAME = "Zefiryn";

let runningBot: RunningBot;
let client: Client;

before(async () => {
	runningBot = await startBot({
		prompt: `Masz na imię ${NAME}. ${DEFAULT_PROMPT}`,
	});
	client = await connectTestUser();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
});

test("prompt: the agent introduces itself by its prompt's name", async () => {
	const reply = await sendAndWaitForReply(
		client,
		botUsername(),
		"Jak masz na imię? Odpowiedz jednym słowem.",
	);

	assert.match(reply, new RegExp(NAME, "i"));
});
