// Contract: an MCP server that authorizes through OAuth gets the user a link
// in the chat; once the user opens it, the server's tools work, and they keep
// working after a full restart without asking again.
// Runs its own bot processes on one session, next to a test MCP server
// (`e2e/mcp/server.ts`) that is its own OAuth authorization server and
// approves at once, so opening the link stands in for the user's consent.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
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

const freePort = (): Promise<number> =>
	new Promise((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});

let mcpServer: RunningMcpServer;
let runningBot: RunningBot | undefined;
let client: Client;
let bot: string;
let callbackPort: number;

const startOAuthBot = () =>
	startBot({
		sessionFile,
		mcpServers: {
			secure: { url: mcpServer.url, oauth: true, tools: ["get_word"] },
		},
		mcpOAuth: { url: `http://127.0.0.1:${callbackPort}`, port: callbackPort },
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
	callbackPort = await freePort();
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	mcpServer?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("mcp oauth: link in chat → authorized → tools work, also after restart", {
	timeout: 6 * MINUTE,
}, async (t) => {
	let link = "";

	await t.test("sends the authorization link on start", async () => {
		const linkPattern = new RegExp(
			`http://127\\.0\\.0\\.1:${callbackPort}/mcp-oauth/start/secure`,
		);
		const message = waitForBotMessage(client, bot, {
			matches: (text) => linkPattern.test(text),
			timeoutMs: 2 * MINUTE,
		});
		runningBot = await startOAuthBot();
		link = linkPattern.exec(await message)?.[0] ?? "";
	});

	await t.test("opening the link authorizes the server", async () => {
		const response = await fetch(link);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /Authorized secure/);
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
