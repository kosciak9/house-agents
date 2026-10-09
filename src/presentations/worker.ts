import { parentPort, workerData } from "node:worker_threads";
import { createPresentationAdapter } from "./adapter.ts";

if (!parentPort) throw new Error("PPTX adapter requires a worker.");
const port = parentPort;
const input: unknown = workerData;
if (
	!input ||
	typeof input !== "object" ||
	!("name" in input) ||
	typeof input.name !== "string"
)
	throw new Error("Invalid PPTX worker initialization.");
const bytes = "bytes" in input ? input.bytes : undefined;
if (bytes !== undefined && !(bytes instanceof Uint8Array))
	throw new Error("Invalid source bytes.");
try {
	const adapter = await createPresentationAdapter(bytes);
	port.postMessage({ id: 0, result: adapter.info() });
	let queue = Promise.resolve();
	port.on("message", (input: unknown) => {
		queue = queue.then(async () => {
			if (
				!input ||
				typeof input !== "object" ||
				!("id" in input) ||
				typeof input.id !== "number" ||
				!("operation" in input) ||
				typeof input.operation !== "string" ||
				!("args" in input)
			)
				return;
			try {
				port.postMessage({
					id: input.id,
					result: await adapter.execute(input.operation, input.args),
				});
			} catch (error) {
				port.postMessage({
					id: input.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	});
} catch (error) {
	port.postMessage({
		id: 0,
		error: error instanceof Error ? error.message : String(error),
		fatal: true,
	});
	port.close();
}
