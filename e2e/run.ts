// `pnpm e2e:test [name ...] [--grep <pattern>]`: runs the E2E files named
// (`memory` or `e2e/memory.test.ts`; all by default) one at a time, with the
// compact reporter of `e2e/reporter.ts`. Runs from every checkout share the
// test bot, so a run waits for any other one to finish first.
import { spawn } from "node:child_process";
import {
	globSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const LOCK_FILE = "state/e2e.lock";
const LOCK_POLL_MS = 5_000;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { grep: { type: "string" } },
});

const testFile = (name: string): string =>
	name.endsWith(".ts") ? name : path.join("e2e", `${name}.test.ts`);

const files =
	positionals.length > 0
		? positionals.map(testFile)
		: globSync("e2e/*.test.ts").sort();

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// One lock for every checkout: worktrees link `state/` to the main one.
const acquireLock = async (): Promise<void> => {
	mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
	let announced = false;
	for (;;) {
		try {
			const fd = openSync(LOCK_FILE, "wx");
			writeSync(fd, String(process.pid));
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = Number(readFileSync(LOCK_FILE, "utf8"));
		if (!Number.isSafeInteger(owner) || !isAlive(owner)) {
			rmSync(LOCK_FILE, { force: true });
			continue;
		}
		if (!announced) {
			console.log(`Waiting for another E2E run to finish (pid ${owner})…`);
			announced = true;
		}
		await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
	}
};

const releaseLock = () => {
	try {
		if (Number(readFileSync(LOCK_FILE, "utf8")) === process.pid) {
			rmSync(LOCK_FILE, { force: true });
		}
	} catch {}
};

await acquireLock();
process.on("exit", releaseLock);

const child = spawn(
	process.execPath,
	[
		"--env-file-if-exists=.env",
		"--import",
		"tsx",
		"--test",
		"--test-concurrency=1",
		"--test-reporter=./e2e/reporter.ts",
		...(values.grep ? ["--test-name-pattern", values.grep] : []),
		...files,
	],
	{ stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
	process.exitCode = code ?? (signal ? 1 : 0);
});
