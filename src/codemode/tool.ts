import type {
	CodemodeTool,
	CodemodeToolContext,
} from "@earendil-works/pi-codemode";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";

/** Host calls from the sandbox are untrusted, including nested tool arguments. */
export const localTool = <Schema extends TSchema>(
	name: string,
	description: string,
	schema: Schema,
	execute: (
		args: Static<Schema>,
		context: CodemodeToolContext,
	) => Promise<unknown>,
): CodemodeTool => ({
	name,
	description,
	inputSchema: Object.fromEntries(Object.entries(schema)),
	execute: async (args, context) => {
		if (!Value.Check(schema, args)) {
			const errors = Value.Errors(schema, args).slice(0, 5);
			throw new Error(
				`${name}: ${errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`,
			);
		}
		context.signal.throwIfAborted();
		return execute(args, context);
	},
});
