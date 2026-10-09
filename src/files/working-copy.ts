import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { OfficeFormat } from "./formats.ts";

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};
type Copy = {
	id: string;
	format: OfficeFormat;
	worker: Worker;
	directory: string;
	pending: Map<number, Pending>;
	tail: Promise<unknown>;
	next: number;
	touched: number;
	queued: number;
	cleanup?: Promise<void>;
};
const copies = new Map<string, Copy>();
const reservations: Record<OfficeFormat, number> = {
	xlsx: 0,
	docx: 0,
	pptx: 0,
};
const TTL = 24 * 60 * 60_000;
const OPERATION_TIMEOUT = 30 * 60_000;
const unavailable =
	"Working copy unavailable after restart, 24 idle hours, close or cancellation. Reopen the original file; unsaved edits are RAM only.";

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

const request = (
	copy: Copy,
	operation: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
	initial = false,
): Promise<unknown> => {
	if (copy.cleanup) return Promise.reject(new Error(unavailable));
	if (signal.aborted) {
		stopDetached(copy, "Working-copy operation cancelled; handle invalidated.");
		return Promise.reject(new Error("Working-copy operation cancelled."));
	}
	copy.worker.ref();
	return new Promise((resolve, reject) => {
		const id = initial ? 0 : copy.next++;
		const cancel = () =>
			stopDetached(
				copy,
				"Working-copy operation cancelled or exceeded 30 minutes; handle invalidated. Reopen the original file.",
			);
		const timer = setTimeout(cancel, OPERATION_TIMEOUT);
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
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
		try {
			if (!initial) copy.worker.postMessage({ id, operation, args });
		} catch (error) {
			copy.pending.delete(id);
			finish();
			reject(error);
		}
	});
};

export const createWorkingCopy = async (
	input: { format: OfficeFormat; worker: URL; name: string; bytes?: Buffer },
	signal: AbortSignal,
): Promise<{ id: string; info: unknown }> => {
	signal.throwIfAborted();
	for (const copy of copies.values()) {
		if (
			copy.queued === 0 &&
			copy.pending.size === 0 &&
			Date.now() - copy.touched > TTL
		)
			await stop(copy, "Working copy expired after 24 idle hours.");
	}
	const count = [...copies.values()].filter(
		(copy) => copy.format === input.format,
	).length;
	if (count + reservations[input.format] >= 8)
		throw new Error(
			`Maximum 8 RAM ${input.format} working copies. Close unused copies first.`,
		);
	reservations[input.format]++;
	let directory: string | undefined;
	let copy: Copy | undefined;
	try {
		directory = await mkdtemp(path.join(tmpdir(), `house-${input.format}-`));
		signal.throwIfAborted();
		const worker = new Worker(input.worker, {
			workerData: { directory, name: input.name, bytes: input.bytes },
			// Native Node TS stripping works even when the entrypoint is launched by tsx.
			execArgv: [],
			resourceLimits: { maxOldGenerationSizeMb: 256 },
		});
		const opened: Copy = {
			id: randomUUID(),
			format: input.format,
			worker,
			directory,
			pending: new Map(),
			tail: Promise.resolve(),
			next: 1,
			touched: Date.now(),
			queued: 0,
		};
		copy = opened;
		// Keep the reservation through initialization, before publishing the handle.
		worker.on(
			"message",
			(reply: {
				id: number;
				result?: unknown;
				error?: string;
				fatal?: boolean;
			}) => {
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
			},
		);
		worker.on("error", (error: Error) =>
			stopDetached(
				opened,
				`Worker failed: ${error.message}. Handle invalidated; reopen source.`,
			),
		);
		worker.on("exit", () =>
			stopDetached(opened, "Worker exited. Handle invalidated; reopen source."),
		);
		const info = await request(opened, "", {}, signal, true);
		signal.throwIfAborted();
		if (opened.cleanup) throw new Error(unavailable);
		opened.touched = Date.now();
		copies.set(opened.id, opened);
		return { id: opened.id, info };
	} catch (error) {
		if (copy) await stop(copy, "Working-copy opening failed.");
		else if (directory) await rm(directory, { recursive: true, force: true });
		throw error;
	} finally {
		reservations[input.format]--;
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
		throw new Error(unavailable);
	if (
		copy.queued === 0 &&
		copy.pending.size === 0 &&
		Date.now() - copy.touched > TTL
	) {
		await stop(copy, "Working copy expired.");
		throw new Error(unavailable);
	}
	if (signal.aborted) {
		await stop(copy, "Working-copy operation cancelled; handle invalidated.");
		signal.throwIfAborted();
	}
	if (copy.queued >= 16)
		throw new Error(
			"Too many simultaneous calls to this working copy (maximum 16). Await existing calls first.",
		);
	copy.queued++;
	// Serialization is worker transport ownership, not another durable scheduler.
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
