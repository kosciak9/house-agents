import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

type Reply = { id: number; result?: unknown; error?: string; fatal?: boolean };
type Pending = {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
};
type Workbook = {
	id: string;
	worker: Worker;
	directory: string;
	pending: Map<number, Pending>;
	tail: Promise<unknown>;
	next: number;
	touched: number;
	stopped: boolean;
	queued: number;
};
const workbooks = new Map<string, Workbook>();
let opening = 0;
const TTL = 24 * 60 * 60_000;
const OPERATION_TIMEOUT = 30 * 60_000;

const stop = async (book: Workbook, reason: string) => {
	if (book.stopped) return;
	book.stopped = true;
	workbooks.delete(book.id);
	for (const pending of book.pending.values())
		pending.reject(new Error(reason));
	book.pending.clear();
	await book.worker.terminate();
	await rm(book.directory, { recursive: true, force: true });
};

const request = (
	book: Workbook,
	operation: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
	initial = false,
): Promise<unknown> => {
	if (book.stopped)
		return Promise.reject(
			new Error(
				"Workbook unavailable after close, cancellation, expiration or restart. Reopen the original file.",
			),
		);
	if (signal.aborted)
		return Promise.reject(
			new Error("Spreadsheet operation aborted before starting."),
		);
	book.worker.ref();
	return new Promise((resolve, reject) => {
		const id = initial ? 0 : book.next++;
		const cancel = () => {
			void stop(
				book,
				"Spreadsheet operation cancelled or exceeded 30 minutes; workbook handle invalidated. Reopen the original file.",
			).catch(reject);
		};
		const timer = setTimeout(cancel, OPERATION_TIMEOUT);
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			if (book.pending.size === 0) book.worker.unref();
		};
		book.pending.set(id, {
			resolve: (value) => {
				finish();
				resolve(value);
			},
			reject: (error) => {
				finish();
				reject(error);
			},
		});
		signal.addEventListener("abort", cancel, { once: true });
		if (!initial) book.worker.postMessage({ id, operation, args });
	});
};

export const createWorkbook = async (
	name: string,
	bytes: Buffer | undefined,
	signal: AbortSignal,
): Promise<{ workbookId: string; info: unknown }> => {
	signal.throwIfAborted();
	for (const book of workbooks.values())
		if (Date.now() - book.touched > TTL)
			await stop(
				book,
				"Workbook expired after 24 idle hours. Reopen the source.",
			);
	if (workbooks.size + opening >= 8)
		throw new Error("Maximum 8 RAM workbooks. Close unused workbooks first.");
	opening++;
	let directory: string;
	try {
		directory = await mkdtemp(path.join(tmpdir(), "house-spreadsheet-"));
	} finally {
		opening--;
	}
	let worker: Worker;
	try {
		// Native Node TS stripping also works when the bot entrypoint was launched by tsx.
		worker = new Worker(new URL("./worker.ts", import.meta.url), {
			workerData: { directory, bytes, name },
			execArgv: [],
			resourceLimits: { maxOldGenerationSizeMb: 256 },
		});
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	const book: Workbook = {
		id: randomUUID(),
		worker,
		directory,
		pending: new Map(),
		tail: Promise.resolve(),
		next: 1,
		touched: Date.now(),
		stopped: false,
		queued: 0,
	};
	workbooks.set(book.id, book);
	worker.on("message", (reply: Reply) => {
		const pending = book.pending.get(reply.id);
		book.pending.delete(reply.id);
		if (reply.error) pending?.reject(new Error(reply.error));
		else pending?.resolve(reply.result);
		if (reply.fatal)
			void stop(
				book,
				"Workbook memory budget exceeded. Handle invalidated; reopen a smaller source.",
			).catch((error) =>
				console.error("Spreadsheet worker cleanup failed", error),
			);
	});
	worker.on("error", (error: Error) => {
		void stop(
			book,
			`Spreadsheet worker failed: ${error.message}. Handle invalidated; reopen source.`,
		).catch((failure) =>
			console.error("Spreadsheet worker cleanup failed", failure),
		);
	});
	worker.on("exit", () => {
		void stop(
			book,
			"Spreadsheet worker exited. Handle invalidated; reopen source.",
		).catch((error) =>
			console.error("Spreadsheet worker cleanup failed", error),
		);
	});
	try {
		return {
			workbookId: book.id,
			info: await request(book, "", {}, signal, true),
		};
	} catch (error) {
		await stop(book, "Spreadsheet opening failed.");
		throw error;
	}
};

export const callWorkbook = async (
	id: string,
	operation: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<unknown> => {
	const book = workbooks.get(id);
	if (!book || Date.now() - book.touched > TTL) {
		if (book) await stop(book, "Workbook expired.");
		throw new Error(
			"Workbook unavailable after restart, 24 idle hours, close or cancellation. Reopen the original file; unsaved edits are RAM only.",
		);
	}
	book.touched = Date.now();
	if (book.queued >= 16)
		throw new Error(
			"Too many simultaneous calls to this workbook (maximum 16). Await existing calls first.",
		);
	book.queued++;
	// Serialization belongs to the worker adapter, not a second durable task runtime.
	const result = book.tail
		.catch(() => undefined)
		.then(() => request(book, operation, args, signal))
		.finally(() => {
			book.queued--;
		});
	book.tail = result;
	return result;
};

export const closeWorkbook = async (
	id: string,
): Promise<{ closed: boolean }> => {
	const book = workbooks.get(id);
	if (book) await stop(book, "Workbook closed. Unsaved edits discarded.");
	return { closed: book !== undefined };
};
