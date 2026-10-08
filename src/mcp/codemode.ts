import { type ImageContent, Type } from "@earendil-works/pi-ai";
import {
	CodemodeSandbox,
	type CodemodeTool,
	MCP_TYPESCRIPT_PREAMBLE,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { defineTool } from "@earendil-works/pi-durable";

// Large spreadsheet jobs can run inside a background general subagent.
const TIMEOUT_MS = 30 * 60_000;

// Local and MCP tools reach the agent only through this one tool: it writes a script
// that calls them, and only what the script outputs or returns enters the
// context, not every nested result.

const isImage = (value: unknown): value is ImageContent =>
	typeof value === "object" &&
	value !== null &&
	"type" in value &&
	value.type === "image" &&
	"data" in value &&
	typeof value.data === "string" &&
	"mimeType" in value &&
	typeof value.mimeType === "string";

/**
 * `value` with every image in it moved to `images`, so a returned tool result
 * shows its images to the model instead of their base64 as text.
 */
const takeImages = (value: unknown, images: ImageContent[]): unknown => {
	if (isImage(value)) {
		images.push({ type: "image", data: value.data, mimeType: value.mimeType });
		return `[image ${images.length}]`;
	}
	if (Array.isArray(value))
		return value.map((item) => takeImages(item, images));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				takeImages(item, images),
			]),
		);
	}
	return value;
};

/** The `codemode` tool over `tools`, which the script calls as `tools.<name>`. */
export const createCodemodeTool = (tools: readonly CodemodeTool[]) => {
	const names = new Set<string>();
	for (const tool of tools) {
		if (tool.name === "tool_search" || names.has(tool.name))
			throw new Error(`Duplicate or reserved codemode tool: ${tool.name}`);
		names.add(tool.name);
	}
	const search: CodemodeTool = {
		name: "tool_search",
		description:
			"Discover tool argument and return declarations by name or description keywords.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				matched: { type: "integer" },
				declarations: { type: "string" },
				note: { type: "string" },
			},
			required: ["matched", "declarations"],
		},
		execute: async (args) => {
			if (
				typeof args !== "object" ||
				args === null ||
				Array.isArray(args) ||
				!("query" in args) ||
				typeof args.query !== "string" ||
				Object.keys(args).some((key) => key !== "query")
			)
				throw new Error("tool_search expects { query: string }");
			const words = args.query
				.toLowerCase()
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			const matches = tools.filter((tool) => {
				const about = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
				return words.every((word) => about.includes(word));
			});
			return {
				matched: matches.length,
				declarations: renderDeclarations({ tools: matches.slice(0, 20) }),
				...(matches.length > 20 && {
					note: "Showing the first 20 tools; narrow the query.",
				}),
			};
		},
	};
	return defineTool({
		name: "codemode",
		description:
			"Run JavaScript (the body of an async function) in a sandbox whose only " +
			"capability is calling the tools below as `await tools.<name>(args)`. " +
			"Local tools return native JSON; MCP tools return MCP `CallToolResult`. A failed call throws. " +
			"Chain and filter their results in the script; output with text(), " +
			"show yourself an image with image(block), or return a value: images in " +
			"it are shown too. There is no fetch, timers or modules. " +
			"First discover argument/return declarations with `return await tools.tool_search({query: 'name or keywords'})`, " +
			"then call the selected tools in another script. `ALL_TOOLS` lists names and descriptions. " +
			"Keep file bytes inside scripts: file_read can supply base64 to external tools only when their discovered schema accepts it; " +
			"external servers do not automatically understand local fileId references. Files and workbooks are in-memory and expire on restart.\n\n" +
			`${MCP_TYPESCRIPT_PREAMBLE}\n\n${renderDeclarations({ tools: [search] })}\n\n` +
			`Available tools:\n${tools.map((tool) => `${tool.name}: ${(tool.description ?? "").split("\n")[0]?.slice(0, 180)}`).join("\n")}`,
		parameters: Type.Object({
			code: Type.String({ description: "The script." }),
		}),
		execute: async ({ code }, _api, context) => {
			const sandbox = new CodemodeSandbox({
				tools: [...tools, search],
				timeoutMs: TIMEOUT_MS,
			});
			try {
				const result = await sandbox.execute(code, {
					signal: context.abortSignal,
				});
				const content = [...result.output];
				if (result.ok && result.value !== undefined) {
					const images: ImageContent[] = [];
					const value = takeImages(result.value, images);
					content.push(
						{ type: "text", text: JSON.stringify(value) },
						...images,
					);
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
};
