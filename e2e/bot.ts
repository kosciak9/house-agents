import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The agent's prompt; tests describe their agent here, never in the repo. */
export const DEFAULT_PROMPT =
	"Jesteś asystentem w teście E2E. Odpowiadasz zwięźle po polsku. " +
	"Gdy prośba dokładnie określa formę odpowiedzi, trzymasz się jej dosłownie.";

export type RunningBot = {
	/** The bot's session; pass it to the next `startBot` to test a restart. */
	sessionFile: string;
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
 * Runs the real bot (`src/index.ts`) as a separate process against the test
 * environment, as the agent `prompt` describes. Without `sessionFile` it
 * starts from an empty session that is deleted on `stop`. Set E2E_VERBOSE=1 to
 * see the bot's output.
 */
export const startBot = async ({
	sessionFile,
	prompt = DEFAULT_PROMPT,
}: {
	sessionFile?: string;
	prompt?: string;
} = {}): Promise<RunningBot> => {
	const ownDirectory =
		sessionFile === undefined
			? mkdtempSync(path.join(tmpdir(), "e2e-bot-"))
			: undefined;
	const file = sessionFile ?? path.join(ownDirectory ?? "", "session.sqlite");

	const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
		env: {
			...process.env,
			TELEGRAM_ENVIRONMENT: "test",
			AGENT_SESSION_FILE: file,
			AGENT_PROMPT: prompt,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	const output: string[] = [];
	const collect = (chunk: Buffer) => {
		output.push(chunk.toString());
		if (process.env.E2E_VERBOSE) process.stderr.write(`[bot] ${chunk}`);
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

	return { sessionFile: file, stop };
};
