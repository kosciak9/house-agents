import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { localTool } from "../codemode/local-tool.ts";
import {
	getFile,
	listFiles,
	MAX_FILE_BYTES,
	putFile,
	readFileChunk,
	releaseFile,
} from "./store.ts";

const fileId = Type.String({ minLength: 1 });

export const fileTools: readonly CodemodeTool[] = [
	localTool(
		"file_import",
		"Store original bytes from an MCP attachment or create a text file in RAM. Returns {id, fileName, mimeType, size}; pass id as fileId to Office tools or delivery. Use encoding base64 for binary files, utf8 for Markdown, CSV or other text. Keep content inside codemode scripts, not model context. Source files are immutable; import edited text as a new file.",
		Type.Object(
			{
				fileName: Type.String({ minLength: 1 }),
				mimeType: Type.String({ minLength: 1 }),
				content: Type.String({ maxLength: Math.ceil(MAX_FILE_BYTES / 3) * 4 }),
				encoding: Type.Union([Type.Literal("base64"), Type.Literal("utf8")]),
			},
			{ additionalProperties: false },
		),
		async ({ fileName, mimeType, content, encoding }) => {
			if (
				/[\\/]/.test(fileName) ||
				[...fileName].some((character) => {
					const code = character.charCodeAt(0);
					return code < 32 || code === 127;
				})
			)
				throw new Error("Use a file name, not a path or control characters.");
			const data = Buffer.from(content, encoding);
			if (encoding === "base64" && data.toString("base64") !== content)
				throw new Error("File content must be canonical standard base64.");
			return putFile({ data, fileName, mimeType });
		},
	),
	localTool(
		"file_read_text",
		"Read a UTF-8 text file (Markdown, CSV, JSON, code, etc.) up to 1 MiB without truncation. Returns {fileName, mimeType, text}. Edit text in JavaScript and call file_import with encoding utf8 to store a new deliverable; binary Office files need their own editing tools.",
		Type.Object({ fileId }, { additionalProperties: false }),
		async ({ fileId }) => {
			const file = getFile(fileId);
			if (file.data.length > 1024 * 1024)
				throw new Error("Text file exceeds the 1 MiB read limit.");
			return {
				fileName: file.fileName,
				mimeType: file.mimeType,
				text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					file.data,
				),
			};
		},
	),
	localTool(
		"file_list",
		"List RAM files available for spreadsheet, document and presentation tools or attachment bridges. Files disappear after restart or 24 idle hours.",
		Type.Object({}, { additionalProperties: false }),
		async () => listFiles(),
	),
	localTool(
		"file_read",
		"Read immutable file bytes as base64 for MCP/email attachments. Offset and length count bytes, not base64 characters; defaults to 4 MiB, max 64 MiB per call. For one complete attachment, set length to the exported file size and require eof=true before sending. Keep base64 inside codemode, never return it to model context.",
		Type.Object(
			{
				fileId,
				offset: Type.Optional(
					Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
				),
				length: Type.Optional(
					Type.Integer({ minimum: 1, maximum: MAX_FILE_BYTES }),
				),
			},
			{ additionalProperties: false },
		),
		async (args) => {
			const offset = args.offset ?? 0;
			const length = args.length ?? 4 * 1024 * 1024;
			const file = readFileChunk(args.fileId, offset, length);
			const chunk = file.data;
			return {
				id: args.fileId,
				fileName: file.fileName,
				mimeType: file.mimeType,
				size: file.size,
				offset,
				length: chunk.length,
				nextOffset: offset + chunk.length,
				eof: offset + chunk.length === file.size,
				base64: chunk.toString("base64"),
			};
		},
	),
	localTool(
		"file_release",
		"Release a RAM file. Already opened working copies are unaffected.",
		Type.Object({ fileId }, { additionalProperties: false }),
		async (args) => releaseFile(args.fileId),
	),
];
