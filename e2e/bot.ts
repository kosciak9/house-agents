import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Model } from "../src/index.ts";

/** The agent's prompt; tests describe their agent here, never in the repo. */
export const DEFAULT_PROMPT =
	"Jesteś asystentem w teście E2E. Odpowiadasz zwięźle po polsku. " +
	"Gdy prośba dokładnie określa formę odpowiedzi, trzymasz się jej dosłownie.";

export type RunningBot = {
	/** The bot's state; pass it to the next `startBot` to test a restart. */
	stateDir: string;
	stop: () => Promise<void>;
};

const STARTUP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

const waitForStartup = (child: ChildProcess, output: string[]): Promise<void> =>
	new Promise((resolve, reject) => {
		const fail = (reason: string) => {
			clearTimeout(timer);
			reject(new Error(`${reason}\n--- bot output ---\n${output.join("")}`));
		};
		const timer = setTimeout(
			() => fail(`Bot did not start within ${STARTUP_TIMEOUT_MS} ms`),
			STARTUP_TIMEOUT_MS,
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (!/Bot @\S+ started/.test(chunk.toString())) return;
			clearTimeout(timer);
			resolve();
		});
		child.once("exit", (code) => fail(`Bot exited during startup (${code})`));
	});

const stopProcess = async (child: ChildProcess): Promise<void> => {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
	await exited;
	clearTimeout(timer);
};

/**
 * Runs the real bot (`e2e/agent.ts`) as a separate process against the test
 * environment, as the agent `prompt` describes. Without `stateDir` it starts
 * from an empty state that is deleted
 * on `stop`. Local file tools and the built-in general subagent are always
 * available; `mcpServers`, `mcp` and `subagents` configure remote tools and
 * specialists. MCP servers' OAuth tokens are kept in the state,
 * so they survive a restart too. It signs
 * in to model providers with the real credentials unless `credentialsFile`
 * names other ones. `model` and `fallbackModel` replace `e2e/agent.ts`'s.
 */
export const startBot = async ({
	stateDir,
	prompt = DEFAULT_PROMPT,
	model,
	fallbackModel,
	mcpServers = {},
	mcp = {},
	subagents = {},
	credentialsFile = path.resolve("state/auth.json"),
}: {
	stateDir?: string;
	prompt?: string;
	/** The config's `model`. */
	model?: Model;
	/** The config's `fallbackModel`. */
	fallbackModel?: Model;
	/** The config's `mcpServers`. */
	mcpServers?: Record<string, unknown>;
	/** The config's `mcp`. */
	mcp?: Record<string, string[]>;
	/** The config's `subagents`. */
	subagents?: Record<string, unknown>;
	credentialsFile?: string;
} = {}): Promise<RunningBot> => {
	const ownDirectory =
		stateDir === undefined
			? mkdtempSync(path.join(tmpdir(), "e2e-bot-"))
			: undefined;
	const directory = stateDir ?? ownDirectory ?? "";

	const config = {
		prompt,
		...(model && { model }),
		...(fallbackModel && { fallbackModel }),
		mcpServers,
		mcp,
		subagents,
		stateDir: directory,
		credentialsFile,
	};
	const child = spawn(
		process.execPath,
		["--import", "tsx", "e2e/agent.ts", JSON.stringify(config)],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	// The reporter (`e2e/reporter.ts`) logs this output and shows it when a
	// test fails.
	const output: string[] = [];
	const collect = (chunk: Buffer) => {
		output.push(chunk.toString());
		for (const line of chunk.toString().split("\n")) {
			if (line.trim()) process.stdout.write(`[bot] ${line}\n`);
		}
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);

	const stop = async () => {
		await stopProcess(child);
		if (ownDirectory) rmSync(ownDirectory, { recursive: true, force: true });
	};

	try {
		await waitForStartup(child, output);
	} catch (error) {
		await stop();
		throw error;
	}

	return { stateDir: directory, stop };
};
