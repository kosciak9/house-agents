// Contract: the agent uses the tools of the MCP servers its deployment lists
// in MCP_SERVERS, over stdio and over HTTP with an API key header, and only
// the tools each server allows.
// Runs its own bot process on an empty session, next to a test MCP server
// (`e2e/mcp/server.ts`) on HTTP; the bot starts the stdio one itself.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

const MINUTE = 60_000;
const SERVER = ["--import", "tsx", "e2e/mcp/server.ts"];

const runId = Date.now().toString(36).toUpperCase();
const httpWord = `ZDALNE-${runId}`;
const stdioWord = `LOKALNE-${runId}`;
const apiKey = `key-${runId}`;

const directory = mkdtempSync(path.join(tmpdir(), "e2e-mcp-"));
const visitFile = path.join(directory, "visits.txt");

// Starts the HTTP test server and resolves with its port.
const startHttpServer = (child: ChildProcess): Promise<number> =>
	new Promise((resolve, reject) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			const port = /listening on (\d+)/.exec(chunk.toString())?.[1];
			if (port) resolve(Number(port));
		});
		child.once("exit", (code) =>
			reject(new Error(`MCP server exited (${code})`)),
		);
	});

let httpServer: ChildProcess;
let runningBot: RunningBot;
let client: Client;
let bot: string;

before(async () => {
	httpServer = spawn(process.execPath, [...SERVER, "http"], {
		env: {
			...process.env,
			WORD: httpWord,
			VISIT_FILE: visitFile,
			API_KEY: apiKey,
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	const port = await startHttpServer(httpServer);

	runningBot = await startBot({
		mcpServers: {
			remote: {
				url: `http://127.0.0.1:${port}/mcp`,
				headers: { Authorization: `Bearer ${apiKey}` },
				tools: ["get_word"],
			},
			local: {
				command: process.execPath,
				args: [...SERVER, "stdio"],
				env: { WORD: stdioWord, VISIT_FILE: visitFile },
				tools: ["get_word"],
			},
		},
	});
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
	httpServer?.kill();
	rmSync(directory, { recursive: true, force: true });
});

test("mcp: allowed tools work over HTTP and stdio, others are hidden", {
	timeout: 6 * MINUTE,
}, async (t) => {
	await t.test("calls a tool over HTTP with the API key", async () => {
		const reply = await sendAndWaitForReply(
			client,
			bot,
			"Użyj narzędzia get_word serwera remote i odpowiedz samym słowem.",
			{ timeoutMs: 2 * MINUTE },
		);
		assert.match(reply, new RegExp(httpWord));
	});

	await t.test("calls a tool over stdio", async () => {
		const reply = await sendAndWaitForReply(
			client,
			bot,
			"Użyj narzędzia get_word serwera local i odpowiedz samym słowem.",
			{ timeoutMs: 2 * MINUTE },
		);
		assert.match(reply, new RegExp(stdioWord));
	});

	await t.test("cannot call a tool the server does not allow", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			'Wywołaj narzędzie record_visit z imieniem "test" na obu serwerach. ' +
				"Odpowiedz jednym zdaniem.",
			{ timeoutMs: 2 * MINUTE },
		);
		assert.equal(existsSync(visitFile), false);
	});
});
