// Contract: the agent uses the tools of the MCP servers its deployment lists
// in its config, over stdio, over HTTP with an API key header, and over HTTP
// with OAuth, and only the tools its policy allows. /mcp lists the servers,
// their state and who uses them; /mcp <server> lists its tools, the allowed
// ones marked. An OAuth server offers nothing until the user logs in:
// /mcp_login sends the link, the user approves and sends the address the
// browser ends up on, after which its tools work, also after a full restart
// without asking again; the link and the address are deleted from the chat.
// /diagnostics tools lists the tools of the agent and of each subagent. Nothing of the bot is reachable from outside.
// The agent sees the images a tool returns.
// Subagents run in the background, several at once, each on a stdio server
// of its policy started for it alone and stopped once it has answered, and
// the agent gets their answers.
// Runs its own bot processes on one session, next to two test MCP servers
// (`e2e/mcp/server.ts`) on HTTP; the bot starts the stdio one itself. The
// OAuth server is its own authorization server and approves at once, so
// fetching the link stands in for the user's consent.
import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { DEFAULT_PROMPT, type RunningBot, startBot } from "./bot.ts";
import { COLORS } from "./image.ts";
import {
	type RunningMcpServer,
	STDIO_SERVER,
	startHttpMcpServer,
} from "./mcp/http.ts";
import {
	botUsername,
	connectTestUser,
	recentMessages,
	sendAndWaitForReply,
} from "./telegram/client.ts";

const MINUTE = 60_000;

const runId = Date.now().toString(36).toUpperCase();
const httpWord = `ZDALNE-${runId}`;
const stdioWord = `LOKALNE-${runId}`;
const oauthWord = `CHRONIONE-${runId}`;
const scoutWord = `ZWIAD-${runId}`;
const apiKey = `key-${runId}`;
// Random per run, so the agent cannot pass by guessing the same color.
const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? COLORS[0];

const directory = mkdtempSync(path.join(tmpdir(), "e2e-mcp-"));
const visitFile = path.join(directory, "visits.txt");
const lifeFile = path.join(directory, "scout-servers.txt");

let httpServer: RunningMcpServer;
let oauthServer: RunningMcpServer;
let runningBot: RunningBot | undefined;
let client: Client;
let bot: string;

const startMcpBot = () =>
	startBot({
		stateDir: directory,
		mcpServers: {
			remote: {
				url: httpServer.url,
				headers: { Authorization: `Bearer ${apiKey}` },
			},
			local: {
				...STDIO_SERVER,
				env: { WORD: stdioWord, VISIT_FILE: visitFile },
			},
			secure: { url: oauthServer.url, oauth: true },
			words: {
				...STDIO_SERVER,
				env: { WORD: scoutWord, VISIT_FILE: visitFile, LIFE_FILE: lifeFile },
			},
		},
		mcp: {
			remote: ["get_word", "get_picture"],
			local: ["get_word"],
			secure: ["get_word"],
		},
		subagents: {
			zwiadowca: {
				description: "Pobiera słowo ze swojego serwera.",
				prompt: DEFAULT_PROMPT,
				mcp: { words: ["get_word"] },
			},
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
		PICTURE: color.rgb.join(","),
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
	timeout: 9 * MINUTE,
}, async (t) => {
	let link = "";
	let redirect = "";

	await t.test(
		"/mcp lists the servers, who uses them, and logins",
		async () => {
			runningBot = await startMcpBot();
			const list = await sendAndWaitForReply(client, bot, "/mcp");
			assert.match(list, /^secure: 🔒 wymaga logowania; dla: agent$/m);
			assert.match(list, /^local: ✓ połączony; dla: agent$/m);
			assert.match(list, /^words: .*; dla: zwiadowca$/m);
			// A subagent's server runs only while a subagent does.
			assert.equal(existsSync(lifeFile), false);
		},
	);

	await t.test(
		"/mcp <server> lists its tools, the allowed ones marked",
		async () => {
			const tools = await sendAndWaitForReply(client, bot, "/mcp words");
			assert.match(tools, /^✓ get_word \(zwiadowca\)$/m);
			assert.match(tools, /^· record_visit$/m);
		},
	);

	await t.test("/mcp_login sends the link to approve at", async () => {
		const authorizeUrl = new RegExp(
			`${new URL(oauthServer.url).origin.replace(/\./g, "\\.")}/authorize\\?[^\\s)]+`,
		);
		const reply = await sendAndWaitForReply(client, bot, "/mcp_login secure");
		link = authorizeUrl.exec(reply)?.[0] ?? "";
		assert.ok(link, reply);
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

	await t.test("sending the redirect address logs in", async () => {
		const reply = await sendAndWaitForReply(client, bot, redirect);
		assert.match(reply, /Połączono z „secure”/);
	});

	await t.test("the link and the address leave the chat", async () => {
		const texts = (await recentMessages(client, bot)).join("\n");
		// The history reaches back past the link.
		assert.match(texts, /^\/mcp_login secure$/m);
		assert.doesNotMatch(texts, /\/authorize\?/);
		assert.doesNotMatch(texts, /mcp-oauth\/callback/);
	});

	await t.test("/diagnostics tools lists every agent's tools", async () => {
		const tools = await sendAndWaitForReply(client, bot, "/diagnostics tools");
		assert.match(tools, /^· codemode: .*secure__get_word/m);
		assert.match(tools, /^· subagent$/m);
		assert.match(
			tools,
			/^zwiadowca \(gdy pracuje\):\n· codemode: words__get_word$/m,
		);
	});

	await t.test("calls a tool over OAuth", async () => {
		assert.match(await askForWord("secure"), new RegExp(oauthWord));
	});

	await t.test("calls a tool over HTTP with the API key", async () => {
		assert.match(await askForWord("remote"), new RegExp(httpWord));
	});

	await t.test("sees the image a tool returns", async () => {
		const reply = await sendAndWaitForReply(
			client,
			bot,
			"Użyj narzędzia get_picture serwera remote. Jaki kolor ma obrazek? " +
				"Odpowiedz jednym słowem po polsku.",
			{ timeoutMs: 2 * MINUTE },
		);
		assert.match(reply, color.answer);
	});

	await t.test("calls a tool over stdio", async () => {
		assert.match(await askForWord("local"), new RegExp(stdioWord));
	});

	await t.test("subagents run at once, on servers of their own", async () => {
		// Only what the subagents start; listing its tools started it before.
		writeFileSync(lifeFile, "");
		await sendAndWaitForReply(
			client,
			bot,
			"Uruchom naraz dwa subagenty zwiadowca, każdy z zadaniem: pobierz " +
				"słowo narzędziem get_word i odpowiedz samym słowem. " +
				"Gdy odpowiedzą, podaj mi to słowo.",
			{
				matches: (text) => text.includes(scoutWord),
				timeoutMs: 3 * MINUTE,
			},
		);
		const life = readFileSync(lifeFile, "utf8");
		const started = [...life.matchAll(/^start (\d+)$/gm)].map((m) => m[1]);
		const exited = [...life.matchAll(/^exit (\d+)$/gm)].map((m) => m[1]);
		assert.equal(new Set(started).size, 2);
		assert.deepEqual(new Set(exited), new Set(started));
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
