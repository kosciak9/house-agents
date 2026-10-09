import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { type OfficeFormat, officeFormats } from "./formats.ts";
import type { Reply, Request, WorkerInput } from "./worker.ts";

// An editable copy of an Office file lives in RAM, in a worker thread of its
// own (`worker.ts`), reached by its handle. Calls to one copy run one at a
// time; one cancelled or running too long closes it, since the worker cannot
// stop halfway through an edit.

const MAX_COPIES_PER_FORMAT = 8;
const MAX_QUEUED_CALLS = 16;
const TTL = 24 * 60 * 60_000;
const OPERATION_TIMEOUT = 30 * 60_000;
const UNAVAILABLE =
	"Working copy unavailable after restart, 24 idle hours, close or cancellation. Reopen the original file; unsaved edits are RAM only.";

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

type Copy = {
	id: string;
	format: OfficeFormat;
	worker: Worker;
	directory: string;
	/** Replies awaited, by request id. */
	pending: Map<number, Pending>;
	/** The last call, which the next one waits for. */
	tail: Promise<unknown>;
	nextRequestId: number;
	touched: number;
	queued: number;
	cleanup?: Promise<void>;
};

const copies = new Map<string, Copy>();
// Copies being opened count towards the limit before they have a handle.
const opening: Record<OfficeFormat, number> = { xlsx: 0, docx: 0, pptx: 0 };

const stop = (copy: Copy, reason: string): Promise<void> => {
	if (copy.cleanup) return copy.cleanup;
	for (const pending of copy.pending.values())
		pending.reject(new Error(reason));
	copy.pending.clear();
	copy.cleanup = (async () => {
		try {
			await copy.worker.terminate();
		} finally {
			try {
				await rm(copy.directory, { recursive: true, force: true });
			} finally {
				copies.delete(copy.id);
			}
		}
	})();
	return copy.cleanup;
};

const stopDetached = (copy: Copy, reason: string) => {
	void stop(copy, reason).catch((error) =>
		console.error("Working-copy cleanup failed", error),
	);
};

const isExpired = (copy: Copy): boolean =>
	copy.queued === 0 &&
	copy.pending.size === 0 &&
	Date.now() - copy.touched > TTL;

/** The reply to request `id`; the copy closes if `signal` aborts first. */
const awaitReply = (
	copy: Copy,
	id: number,
	signal: AbortSignal,
): Promise<unknown> => {
	copy.worker.ref();
	return new Promise((resolve, reject) => {
		const cancel = () =>
			stopDetached(
				copy,
				"Working-copy operation cancelled or exceeded 30 minutes; handle invalidated. Reopen the original file.",
			);
		const timer = setTimeout(cancel, OPERATION_TIMEOUT);
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			// An idle copy does not keep the process alive.
			if (copy.pending.size === 0) copy.worker.unref();
		};
		copy.pending.set(id, {
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
	});
};

const request = (
	copy: Copy,
	operation: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<unknown> => {
	if (copy.cleanup) return Promise.reject(new Error(UNAVAILABLE));
	if (signal.aborted) {
		stopDetached(copy, "Working-copy operation cancelled; handle invalidated.");
		return Promise.reject(new Error("Working-copy operation cancelled."));
	}
	const id = copy.nextRequestId++;
	const reply = awaitReply(copy, id, signal);
	try {
		copy.worker.postMessage({ id, operation, args } satisfies Request);
	} catch (error) {
		const pending = copy.pending.get(id);
		copy.pending.delete(id);
		pending?.reject(error instanceof Error ? error : new Error(String(error)));
	}
	return reply;
};

/** Opens `bytes`, or a new empty file, as a working copy: its handle and info. */
export const createWorkingCopy = async (
	format: OfficeFormat,
	{ name, bytes }: { name: string; bytes?: Buffer },
	signal: AbortSignal,
): Promise<{ id: string; info: unknown }> => {
	signal.throwIfAborted();
	for (const copy of copies.values()) {
		if (isExpired(copy))
			await stop(copy, "Working copy expired after 24 idle hours.");
	}
	const count = [...copies.values()].filter(
		(copy) => copy.format === format,
	).length;
	if (count + opening[format] >= MAX_COPIES_PER_FORMAT)
		throw new Error(
			`Maximum ${MAX_COPIES_PER_FORMAT} RAM ${format} working copies. Close unused copies first.`,
		);
	opening[format]++;
	let directory: string | undefined;
	let copy: Copy | undefined;
	try {
		directory = await mkdtemp(path.join(tmpdir(), `house-${format}-`));
		signal.throwIfAborted();
		const worker = new Worker(officeFormats[format].worker, {
			workerData: { directory, name, bytes } satisfies WorkerInput,
			// Native Node TS stripping works even when the entrypoint is launched by tsx.
			execArgv: [],
			resourceLimits: { maxOldGenerationSizeMb: 256 },
		});
		const opened: Copy = {
			id: randomUUID(),
			format,
			worker,
			directory,
			pending: new Map(),
			tail: Promise.resolve(),
			nextRequestId: 1,
			touched: Date.now(),
			queued: 0,
		};
		copy = opened;
		worker.on("message", (reply: Reply) => {
			const pending = opened.pending.get(reply.id);
			opened.pending.delete(reply.id);
			if (reply.fatal) {
				pending?.reject(
					new Error(reply.error ?? "Working-copy memory budget exceeded."),
				);
				stopDetached(
					opened,
					"Worker failed; handle invalidated. Reopen the source.",
				);
			} else if (reply.error !== undefined)
				pending?.reject(new Error(reply.error));
			else pending?.resolve(reply.result);
		});
		worker.on("error", (error: Error) =>
			stopDetached(
				opened,
				`Worker failed: ${error.message}. Handle invalidated; reopen source.`,
			),
		);
		worker.on("exit", () =>
			stopDetached(opened, "Worker exited. Handle invalidated; reopen source."),
		);
		// The worker answers id 0 once it has opened the file.
		const info = await awaitReply(opened, 0, signal);
		signal.throwIfAborted();
		if (opened.cleanup) throw new Error(UNAVAILABLE);
		opened.touched = Date.now();
		copies.set(opened.id, opened);
		return { id: opened.id, info };
	} catch (error) {
		if (copy) await stop(copy, "Working-copy opening failed.");
		else if (directory) await rm(directory, { recursive: true, force: true });
		throw error;
	} finally {
		opening[format]--;
	}
};

export const callWorkingCopy = async (
	format: OfficeFormat,
	id: string,
	operation: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<unknown> => {
	const copy = copies.get(id);
	if (!copy || copy.format !== format || copy.cleanup)
		throw new Error(UNAVAILABLE);
	if (isExpired(copy)) {
		await stop(copy, "Working copy expired.");
		throw new Error(UNAVAILABLE);
	}
	if (signal.aborted) {
		await stop(copy, "Working-copy operation cancelled; handle invalidated.");
		signal.throwIfAborted();
	}
	if (copy.queued >= MAX_QUEUED_CALLS)
		throw new Error(
			`Too many simultaneous calls to this working copy (maximum ${MAX_QUEUED_CALLS}). Await existing calls first.`,
		);
	copy.queued++;
	const cancel = () =>
		stopDetached(copy, "Working-copy operation cancelled; handle invalidated.");
	signal.addEventListener("abort", cancel, { once: true });
	const result = copy.tail
		.catch(() => undefined)
		.then(() => request(copy, operation, args, signal))
		.finally(() => {
			copy.queued--;
			copy.touched = Date.now();
			signal.removeEventListener("abort", cancel);
		});
	copy.tail = result;
	return result;
};

export const closeWorkingCopy = async (
	format: OfficeFormat,
	id: string,
): Promise<{ closed: boolean }> => {
	const copy = copies.get(id);
	if (!copy || copy.format !== format) return { closed: false };
	await stop(copy, "Working copy closed. Unsaved edits discarded.");
	return { closed: true };
};
