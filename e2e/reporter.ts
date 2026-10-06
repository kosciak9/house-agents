// Test reporter of `pnpm e2e:test`: one line per test, the reason of each
// failure, and a summary. Everything a test file prints (the bot's output
// among it) goes to tmp/e2e/<file>.log and is shown only when the file fails.
// E2E_VERBOSE=1 also prints it live.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TestEvent } from "node:test/reporters";

export const LOG_DIRECTORY = "tmp/e2e";
const TAIL_LINES = 40;

const seconds = (ms: number | undefined) => `${((ms ?? 0) / 1000).toFixed(1)}s`;

const indent = (text: string, depth: number) =>
	text
		.split("\n")
		.map((line) => `${"  ".repeat(depth)}${line}`)
		.join("\n");

// The test's own error, not the runner's wrapper around it.
const reason = (error: unknown): string | undefined => {
	const cause =
		error instanceof Error && "cause" in error && error.cause instanceof Error
			? error.cause
			: error;
	const message = cause instanceof Error ? cause.message : String(cause);
	if (/^\d+ subtests? failed$/.test(message)) return undefined;
	return message.trim();
};

type FileState = { log: string; lines: string[]; failed: boolean };

export default async function* reporter(
	source: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
	const files = new Map<string, FileState>();
	let currentFile: string | undefined;
	// Events name a file by a relative or an absolute path.
	const fileState = (file: string): FileState => {
		let state = files.get(path.resolve(file));
		if (!state) {
			mkdirSync(LOG_DIRECTORY, { recursive: true });
			const log = path.join(LOG_DIRECTORY, `${path.basename(file, ".ts")}.log`);
			writeFileSync(log, "");
			state = { log, lines: [], failed: false };
			files.set(path.resolve(file), state);
		}
		return state;
	};

	for await (const event of source) {
		switch (event.type) {
			case "test:stdout":
			case "test:stderr": {
				if (!event.data.file) break;
				const state = fileState(event.data.file);
				appendFileSync(state.log, event.data.message);
				state.lines.push(...event.data.message.trimEnd().split("\n"));
				state.lines.splice(0, state.lines.length - TAIL_LINES);
				if (process.env.E2E_VERBOSE) yield event.data.message;
				break;
			}

			case "test:pass":
			case "test:fail": {
				const { name, nesting, file, details } = event.data;
				// With one process per file, each file also reports as a test.
				if (file && path.resolve(name) === path.resolve(file)) break;
				if (file && file !== currentFile) {
					currentFile = file;
					yield `${path.relative(process.cwd(), file)}\n`;
				}
				const failed = event.type === "test:fail";
				const mark = failed ? "✖" : event.data.skip ? "-" : "✔";
				yield `${indent(`${mark} ${name} (${seconds(details.duration_ms)})`, nesting + 1)}\n`;
				if (!failed) break;
				const why = reason(event.data.details.error);
				if (why) yield `${indent(why, nesting + 3)}\n`;
				if (file) fileState(file).failed = true;
				break;
			}

			case "test:summary": {
				const { file, counts, duration_ms } = event.data;
				if (file) {
					const state = files.get(path.resolve(file));
					if (state?.failed && state.lines.length > 0) {
						yield `\n  Output of ${path.basename(file)} (last ${TAIL_LINES} lines, all in ${state.log}):\n`;
						yield `${indent(state.lines.join("\n"), 2)}\n\n`;
					}
					break;
				}
				const failed =
					counts.tests -
					counts.passed -
					counts.cancelled -
					counts.skipped -
					counts.todo;
				const parts = [
					`${counts.passed} passed`,
					`${failed} failed`,
					counts.cancelled > 0 ? `${counts.cancelled} cancelled` : undefined,
					counts.skipped > 0 ? `${counts.skipped} skipped` : undefined,
				].filter((part) => part !== undefined);
				yield `\n${failed > 0 || counts.cancelled > 0 ? "FAIL" : "OK"}: ${parts.join(", ")} in ${seconds(duration_ms)}. Logs: ${LOG_DIRECTORY}/\n`;
				break;
			}

			default:
				break;
		}
	}
}
