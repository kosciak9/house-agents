// Contract: the user signs in to model providers from the chat, past the
// agent: /login lists them with their status, /login <provider> asks the
// provider's questions in the chat, /cancel stops it and /logout forgets a
// stored credential.
// Runs its own bot process on an empty session with its own credentials, so no
// real account is touched. Goes only as far as a login gets without one: the
// subscriptions' device codes need a real account to approve.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
} from "./telegram/client.ts";

const runId = Date.now().toString(36).toUpperCase();
const xaiKey = `xai-test-${runId}`;

const directory = mkdtempSync(path.join(tmpdir(), "e2e-login-"));
const credentialsFile = path.join(directory, "auth.json");

let runningBot: RunningBot;
let client: Client;
let bot: string;

// The status line of xAI in the /login list.
const xaiStatus = async (): Promise<string> => {
	const list = await sendAndWaitForReply(client, bot, "/login");
	return list.split("\n").find((line) => line.startsWith("xai ")) ?? "";
};

before(async () => {
	writeFileSync(
		credentialsFile,
		JSON.stringify({ xai: { type: "api_key", key: xaiKey } }),
	);
	runningBot = await startBot({ credentialsFile });
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("login: status, questions in the chat, cancel and logout", async (t) => {
	await t.test("/login lists the providers with their status", async () => {
		const list = await sendAndWaitForReply(client, bot, "/login");
		assert.match(list, /^openai-codex .*—$/m);
		assert.match(await xaiStatus(), /✅ stored credential/);
	});

	await t.test("/login <provider> asks its questions in the chat", async () => {
		const question = await sendAndWaitForReply(
			client,
			bot,
			"/login openai-codex",
		);
		assert.match(question, /^1\. .*\n2\. /m);

		const retry = await sendAndWaitForReply(client, bot, "9");
		assert.match(retry, /odpowiedz numerem/);
	});

	await t.test("/cancel stops the login", async () => {
		const reply = await sendAndWaitForReply(client, bot, "/cancel");
		assert.match(reply, /przerwane/);
	});

	await t.test("/logout forgets the credential", async () => {
		const reply = await sendAndWaitForReply(client, bot, "/logout xai");
		assert.match(reply, /Wylogowano/);
		assert.doesNotMatch(readFileSync(credentialsFile, "utf8"), /xai-test/);
		assert.doesNotMatch(await xaiStatus(), /stored credential/);
	});
});
