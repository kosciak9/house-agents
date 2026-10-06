// Contract: the user signs in to model providers from the chat, past the
// agent: /login lists them, /login <provider> asks its questions in the chat
// and stores the credential, /logout forgets it, /cancel stops a login.
// Runs its own bot process on an empty session with its own, empty credentials,
// so no real account is touched. Signs in with an API key (OpenCode Go): the
// subscriptions' OAuth needs a real account.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
	waitForDeletedMessage,
} from "./telegram/client.ts";

const runId = Date.now().toString(36).toUpperCase();
const apiKey = `sk-test-${runId}`;

const directory = mkdtempSync(path.join(tmpdir(), "e2e-login-"));
const credentialsFile = path.join(directory, "auth.json");

let runningBot: RunningBot;
let client: Client;
let bot: string;

// The status line of OpenCode Go in the /login list.
const opencodeStatus = async (): Promise<string> => {
	const list = await sendAndWaitForReply(client, bot, "/login");
	return list.split("\n").find((line) => line.startsWith("opencode-go")) ?? "";
};

before(async () => {
	runningBot = await startBot({ credentialsFile });
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("login: sign in, sign out and cancel from the chat", async (t) => {
	await t.test("/login lists the providers", async () => {
		const list = await sendAndWaitForReply(client, bot, "/login");
		for (const provider of ["openai-codex", "opencode-go", "xai"]) {
			assert.match(list, new RegExp(`^${provider} `, "m"));
		}
	});

	await t.test("/login <provider> asks for the key and stores it", async () => {
		const question = await sendAndWaitForReply(
			client,
			bot,
			"/login opencode-go",
		);
		assert.match(question, /API key/i);

		// The key does not stay in the chat.
		const deleted = waitForDeletedMessage(client, bot);
		const done = await sendAndWaitForReply(client, bot, apiKey);
		assert.match(done, /Zalogowano/);
		await deleted;
		assert.match(readFileSync(credentialsFile, "utf8"), new RegExp(apiKey));
		assert.match(await opencodeStatus(), /✅ stored credential/);
	});

	await t.test("/logout forgets it", async () => {
		const reply = await sendAndWaitForReply(client, bot, "/logout opencode-go");
		assert.match(reply, /Wylogowano/);
		assert.doesNotMatch(readFileSync(credentialsFile, "utf8"), /sk-test/);
		assert.doesNotMatch(await opencodeStatus(), /stored credential/);
	});

	await t.test("/cancel stops a login", async () => {
		await sendAndWaitForReply(client, bot, "/login opencode-go");
		const reply = await sendAndWaitForReply(client, bot, "/cancel");
		assert.match(reply, /przerwane/);
	});
});
