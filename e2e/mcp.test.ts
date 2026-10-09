// Contract: the agent uses the tools of the remote MCP servers its deployment
// lists in its config, with an API key header or with OAuth, and only the
// tools its policy allows. /mcp lists the servers,
// their state and who uses them; /mcp <server> lists its tools, the allowed
// ones marked. An OAuth server offers nothing until the user logs in:
// /mcp_login sends the link, the user approves and sends the address the
// browser ends up on, after which its tools work, also after a full restart
// without asking again; the link and the address are deleted from the chat.
// /diagnostics tools lists the tools of the agent and of each subagent. Nothing of the bot is reachable from outside.
// The agent sees the images a tool returns.
// Subagents run in the background, several at once, each with the tools of
// its own policy, and the agent gets their answers. (Their Lightpanda is left
// to the deployment's use.)
// Runs its own bot processes on one session, next to three test MCP servers
// (`e2e/mcp/server.ts`). The OAuth server is its own authorization server and
// approves at once, so fetching the link stands in for the user's consent.
// A real model looks at the tool's image; after the restart the scripted
// model (`e2e/scripted-model.ts`) makes the tool calls.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import type { Model } from "../src/index.ts";
import { DEFAULT_PROMPT, type RunningBot, startBot } from "./bot.ts";
import { COLORS } from "./image.ts";
import { type RunningMcpServer, startHttpMcpServer } from "./mcp/http.ts";
import {
	call,
	codemode,
	SCRIPTED_MODEL,
	say,
	script,
} from "./scripted-model.ts";
import {
	botUsername,
	connectTestUser,
	recentMessages,
	sendAndWaitForReply,
} from "./telegram/client.ts";

const MINUTE = 60_000;

const runId = Date.now().toString(36).toUpperCase();
const httpWord = `ZDALNE-${runId}`;
const oauthWord = `CHRONIONE-${runId}`;
const scoutWord = `ZWIAD-${runId}`;
const apiKey = `key-${runId}`;
// Random per run, so the agent cannot pass by guessing the same color.
const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? COLORS[0];

const directory = mkdtempSync(path.join(tmpdir(), "e2e-mcp-"));
const visitFile = path.join(directory, "visits.txt");
const callFile = path.join(directory, "scout-calls.txt");

let httpServer: RunningMcpServer;
let oauthServer: RunningMcpServer;
let wordsServer: RunningMcpServer;
let runningBot: RunningBot | undefined;
let client: Client;
let bot: string;

const startMcpBot = (model?: Model) =>
	startBot({
		stateDir: directory,
		model,
		mcpServers: {
			remote: {
				url: httpServer.url,
				headers: { Authorization: `Bearer ${apiKey}` },
			},
			secure: { url: oauthServer.url, oauth: true },
			words: {
				url: wordsServer.url,
				headers: { Authorization: `Bearer ${apiKey}` },
			},
		},
		mcp: {
			remote: ["get_word", "get_picture"],
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

// The answer of a server's get_word, as the agent itself calls it.
const getWord = (server: string) =>
	sendAndWaitForReply(
		client,
		bot,
		script(
			codemode(`return await tools.${server}__get_word({});`),
			say("{{result}}"),
		),
		{ timeoutMs: MINUTE },
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
	wordsServer = await startHttpMcpServer({
		WORD: scoutWord,
		VISIT_FILE: visitFile,
		CALL_FILE: callFile,
		API_KEY: apiKey,
	});
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	httpServer?.stop();
	oauthServer?.stop();
	wordsServer?.stop();
	rmSync(directory, { recursive: true, force: true });
});

test("mcp: allowed tools work with an API key and OAuth, others are hidden", {
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
			assert.match(list, /^remote: ✓ połączony; dla: agent$/m);
			assert.match(list, /^words: .*; dla: zwiadowca$/m);
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

	await t.test(
		"OAuth tools work after a restart, without a new login",
		async () => {
			await runningBot?.stop();
			runningBot = await startMcpBot(SCRIPTED_MODEL);
			assert.match(await getWord("secure"), new RegExp(oauthWord));
		},
	);

	await t.test("calls a tool over HTTP with the API key", async () => {
		assert.match(await getWord("remote"), new RegExp(httpWord));
	});

	await t.test("subagents run at once, with tools of their own", async () => {
		const task = script(
			codemode("return await tools.words__get_word({});"),
			say("{{result}}"),
		);
		await sendAndWaitForReply(
			client,
			bot,
			script(
				call("subagent", { agent: "zwiadowca", tasks: [task, task] }),
				say("started"),
				// Once both have reported back.
				say(`{{match:ZWIAD-${runId}}}`),
			),
			{
				matches: (text) => text.includes(scoutWord),
				timeoutMs: MINUTE,
			},
		);
		// The agent itself may not use `words`: both calls are the subagents'.
		assert.equal(readFileSync(callFile, "utf8"), "get_word\nget_word\n");
	});

	await t.test("cannot call a tool the server does not allow", async () => {
		const reply = await sendAndWaitForReply(
			client,
			bot,
			script(
				codemode(`const failures = [];
for (const server of ["remote", "secure", "words"]) {
	try {
		await tools[server + "__record_visit"]({ name: "test" });
	} catch (error) {
		failures.push(server + ": " + error.message);
	}
}
return failures.join("; ");`),
				say("{{result}}"),
			),
			{ timeoutMs: MINUTE },
		);
		assert.match(reply, /remote: /, reply);
		assert.equal(existsSync(visitFile), false);
	});
});
