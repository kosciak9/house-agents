// Contract: the agent uses the tools of the MCP servers its deployment lists
// in MCP_SERVERS, over stdio, over HTTP with an API key header, and over HTTP
// with OAuth, and only the tools each server allows. For the OAuth server the
// bot itself sends the user its authorization link; the user approves and
// sends the address the browser ends up on with /mcp_auth, after which its
// tools work, also after a full restart without asking again. Nothing of the
// bot is reachable from outside.
// Runs its own bot processes on one session, next to two test MCP servers
// (`e2e/mcp/server.ts`) on HTTP; the bot starts the stdio one itself. The
// OAuth server is its own authorization server and approves at once, so
// fetching the link stands in for the user's consent.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import {
	type RunningMcpServer,
	STDIO_SERVER,
	startHttpMcpServer,
} from "./mcp/http.ts";
import {
	botUsername,
	connectTestUser,
	sendAndWaitForReply,
	waitForBotMessage,
} from "./telegram/client.ts";

const MINUTE = 60_000;

const runId = Date.now().toString(36).toUpperCase();
const httpWord = `ZDALNE-${runId}`;
const stdioWord = `LOKALNE-${runId}`;
const oauthWord = `CHRONIONE-${runId}`;
const apiKey = `key-${runId}`;

const directory = mkdtempSync(path.join(tmpdir(), "e2e-mcp-"));
const sessionFile = path.join(directory, "session.sqlite");
const visitFile = path.join(directory, "visits.txt");

let httpServer: RunningMcpServer;
let oauthServer: RunningMcpServer;
let runningBot: RunningBot | undefined;
let client: Client;
let bot: string;

const startMcpBot = () =>
	startBot({
		sessionFile,
		mcpServers: {
			remote: {
				url: httpServer.url,
				headers: { Authorization: `Bearer ${apiKey}` },
				tools: ["get_word"],
			},
			local: {
				...STDIO_SERVER,
				env: { WORD: stdioWord, VISIT_FILE: visitFile },
				tools: ["get_word"],
			},
			secure: { url: oauthServer.url, oauth: true, tools: ["get_word"] },
		},
	});

const askForWord = (server: string) =>
	sendAndWaitForReply(
		client,
		bot,
		`Użyj narzędzia get_word serwera ${server} i odpowiedz samym słowem.`,
		{ timeoutMs: 2 * MINUTE },
	);

before(async () => {
	httpServer = await startHttpMcpServer({
		WORD: httpWord,
		VISIT_FILE: visitFile,
		API_KEY: apiKey,
	});
	oauthServer = await startHttpMcpServer({
		WORD: oauthWord,
		VISIT_FILE: visitFile,
		OAUTH: "1",
	});
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	httpServer?.stop();
	oauthServer?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("mcp: allowed tools work over stdio, HTTP and OAuth, others are hidden", {
	timeout: 6 * MINUTE,
}, async (t) => {
	let link = "";
	let redirect = "";

	await t.test("sends the OAuth authorization link on start", async () => {
		const authorizeUrl = new RegExp(
			`${new URL(oauthServer.url).origin.replace(/\./g, "\\.")}/authorize\\?[^\\s)]+`,
		);
		const message = waitForBotMessage(client, bot, {
			matches: (text) => authorizeUrl.test(text),
			timeoutMs: 2 * MINUTE,
		});
		runningBot = await startMcpBot();
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

	await t.test("calls a tool over OAuth", async () => {
		assert.match(await askForWord("secure"), new RegExp(oauthWord));
	});

	await t.test("calls a tool over HTTP with the API key", async () => {
		assert.match(await askForWord("remote"), new RegExp(httpWord));
	});

	await t.test("calls a tool over stdio", async () => {
		assert.match(await askForWord("local"), new RegExp(stdioWord));
	});

	await t.test("cannot call a tool the server does not allow", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			'Wywołaj narzędzie record_visit z imieniem "test" na wszystkich serwerach. ' +
				"Odpowiedz jednym zdaniem.",
			{ timeoutMs: 2 * MINUTE },
		);
		assert.equal(existsSync(visitFile), false);
	});

	await t.test("OAuth tools still work after a restart", async () => {
		await runningBot?.stop();
		runningBot = await startMcpBot();
		assert.match(await askForWord("secure"), new RegExp(oauthWord));
	});
});
