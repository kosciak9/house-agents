import { parentPort, workerData } from "node:worker_threads";

// The worker's side of a working copy (`working-copy.ts`): it opens the copy
// from `WorkerInput`, answers id 0 with its info, then answers each request
// with the operation's result. Requests come one at a time.

export type WorkerInput = {
	/** A scratch directory of its own, removed once the copy closes. */
	directory: string;
	name: string;
	/** The file to open; a new, empty copy without it. */
	bytes?: Uint8Array;
};

export type Request = {
	id: number;
	operation: string;
	args: Record<string, unknown>;
};

export type Reply = {
	id: number;
	result?: unknown;
	error?: string;
	/** The copy can no longer be trusted: its handle is closed. */
	fatal?: boolean;
};

export type OpenedCopy = {
	info: () => unknown;
	execute: (operation: string, args: Record<string, unknown>) => unknown;
};

/** An error after which the copy is closed rather than edited further. */
export const fatalError = (message: string): Error =>
	Object.assign(new Error(message), { fatal: true });

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isFatal = (error: unknown): boolean =>
	error instanceof Error && "fatal" in error && error.fatal === true;

export const serveWorkingCopy = async (
	open: (input: WorkerInput) => OpenedCopy | Promise<OpenedCopy>,
): Promise<void> => {
	const port = parentPort;
	if (!port) throw new Error("A working copy runs in a worker thread.");
	const reply = (message: Reply) => port.postMessage(message);

	let copy: OpenedCopy;
	try {
		copy = await open(workerData as WorkerInput);
		reply({ id: 0, result: copy.info() });
	} catch (error) {
		reply({ id: 0, error: errorMessage(error), fatal: true });
		port.close();
		return;
	}

	port.on("message", async ({ id, operation, args }: Request) => {
		try {
			reply({ id, result: await copy.execute(operation, args) });
		} catch (error) {
			reply({ id, error: errorMessage(error), fatal: isFatal(error) });
		}
	});
};
