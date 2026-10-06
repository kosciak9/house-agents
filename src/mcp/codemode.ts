import { Type } from "@earendil-works/pi-ai";
import {
	CodemodeSandbox,
	type CodemodeTool,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { defineTool } from "@earendil-works/pi-durable";

const TIMEOUT_MS = 5 * 60_000;

// MCP tools reach the agent only through this one tool: it writes a script
// that calls them, and only what the script outputs or returns enters the
// context, not every nested result.

/** The `codemode` tool over `tools`, which the script calls as `tools.<name>`. */
export const createCodemodeTool = (tools: readonly CodemodeTool[]) =>
	defineTool({
		name: "codemode",
		description:
			"Run JavaScript (the body of an async function) in a sandbox whose only " +
			"capability is calling the tools below as `await tools.<name>(args)`. " +
			"Chain and filter their results in the script; output with text() or " +
			"return a value. There is no fetch, timers or modules.\n\n" +
			renderDeclarations({ tools }),
		parameters: Type.Object({
			code: Type.String({ description: "The script." }),
		}),
		execute: async ({ code }, _api, context) => {
			const sandbox = new CodemodeSandbox({
				tools: [...tools],
				timeoutMs: TIMEOUT_MS,
			});
			try {
				const result = await sandbox.execute(code, {
					signal: context.abortSignal,
				});
				const content = [...result.output];
				if (result.ok && result.value !== undefined) {
					content.push({ type: "text", text: JSON.stringify(result.value) });
				}
				if (!result.ok) {
					content.push({
						type: "text",
						text: result.error.stack ?? result.error.message,
					});
				}
				if (content.length === 0)
					content.push({ type: "text", text: "(no output)" });
				return { content, isError: !result.ok };
			} finally {
				await sandbox.close();
			}
		},
	});
