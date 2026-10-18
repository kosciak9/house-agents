import type { Context } from "@earendil-works/chord";
import type {
	CodemodeTool,
	CodemodeToolContext,
} from "@earendil-works/pi-codemode";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";

/** What a local tool runs with: the `codemode` call its script came from. */
export type LocalToolContext = CodemodeToolContext & {
	readonly api: ToolExecutionApi;
	readonly context: Context;
};

/** Host calls from the sandbox are untrusted, including nested tool arguments. */
export const localTool = <Schema extends TSchema>(
	name: string,
	description: string,
	schema: Schema,
	execute: (
		args: Static<Schema>,
		context: LocalToolContext,
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
		// The codemode tool runs every script with its call's api and context.
		return execute(args, context as LocalToolContext);
	},
});
