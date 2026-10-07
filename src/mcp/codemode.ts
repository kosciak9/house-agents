import { type ImageContent, Type } from "@earendil-works/pi-ai";
import {
	CodemodeSandbox,
	type CodemodeTool,
	MCP_TYPESCRIPT_PREAMBLE,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { defineTool } from "@earendil-works/pi-durable";

const TIMEOUT_MS = 5 * 60_000;

// MCP tools reach the agent only through this one tool: it writes a script
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
export const createCodemodeTool = (tools: readonly CodemodeTool[]) =>
	defineTool({
		name: "codemode",
		description:
			"Run JavaScript (the body of an async function) in a sandbox whose only " +
			"capability is calling the tools below as `await tools.<name>(args)`. " +
			"Each resolves to the tool's MCP `CallToolResult`; a failed call throws. " +
			"Chain and filter their results in the script; output with text(), " +
			"show yourself an image with image(block), or return a value: images in " +
			"it are shown too. There is no fetch, timers or modules.\n\n" +
			`${MCP_TYPESCRIPT_PREAMBLE}\n\n${renderDeclarations({ tools })}`,
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
