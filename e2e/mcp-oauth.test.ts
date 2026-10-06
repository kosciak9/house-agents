// Contract: for an MCP server that authorizes through OAuth the bot itself
// sends the user its authorization link; the user approves and sends the
// address the browser ends up on with /mcp_auth, after which the server's
// tools work, also after a full restart without asking again. Nothing of the
// bot is reachable from outside.
// Runs its own bot processes on one session, next to a test MCP server
// (`e2e/mcp/server.ts`) that is its own OAuth authorization server and
// approves at once, so fetching the link stands in for the user's consent.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import { type RunningMcpServer, startHttpMcpServer } from "./mcp/http.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
	waitForBotMessage,
} from "./telegram/client.ts";

const MINUTE = 60_000;

const runId = Date.now().toString(36).toUpperCase();
const word = `CHRONIONE-${runId}`;

const directory = mkdtempSync(path.join(tmpdir(), "e2e-mcp-oauth-"));
const sessionFile = path.join(directory, "session.sqlite");

let mcpServer: RunningMcpServer;
let runningBot: RunningBot | undefined;
let client: Client;
let bot: string;

const startOAuthBot = () =>
	startBot({
		sessionFile,
		mcpServers: {
			secure: { url: mcpServer.url, oauth: true, tools: ["get_word"] },
		},
	});

const askForWord = () =>
	sendAndWaitForReply(
		client,
		bot,
		"Użyj narzędzia get_word serwera secure i odpowiedz samym słowem.",
		{ timeoutMs: 2 * MINUTE },
	);

before(async () => {
	mcpServer = await startHttpMcpServer({
		WORD: word,
		VISIT_FILE: path.join(directory, "visits.txt"),
		OAUTH: "1",
	});
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	mcpServer?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("mcp oauth: link in chat → pasted redirect → tools work, also after restart", {
	timeout: 6 * MINUTE,
}, async (t) => {
	let link = "";
	let redirect = "";

	await t.test("sends the authorization link on start", async () => {
		const authorizeUrl = new RegExp(
			`${new URL(mcpServer.url).origin.replace(/\./g, "\\.")}/authorize\\?[^\\s)]+`,
		);
		const message = waitForBotMessage(client, bot, {
			matches: (text) => authorizeUrl.test(text),
			timeoutMs: 2 * MINUTE,
		});
		runningBot = await startOAuthBot();
		link = authorizeUrl.exec(await message)?.[0] ?? "";
	});

	await t.test(
		"approving sends the browser to the redirect address",
		async () => {
			const response = await fetch(link, { redirect: "manual" });
			assert.equal(response.status, 302);
			redirect = response.headers.get("location") ?? "";
			assert.match(redirect, /^http:\/\/localhost\/mcp-oauth\/callback\?/);
		},
	);

	await t.test("/mcp_auth with the redirect address authorizes", async () => {
		const reply = await sendAndWaitForReply(
			client,
			bot,
			`/mcp_auth ${redirect}`,
		);
		assert.match(reply, /„secure” autoryzowany/);
	});

	await t.test("the server's tools work", async () => {
		assert.match(await askForWord(), new RegExp(word));
	});

	await t.test("they still work after a restart", async () => {
		await runningBot?.stop();
		runningBot = await startOAuthBot();
		assert.match(await askForWord(), new RegExp(word));
	});
});
