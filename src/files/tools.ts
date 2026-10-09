import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { localTool } from "../codemode/local-tool.ts";
import { listFiles, readFileChunk, releaseFile } from "./store.ts";

const fileId = Type.String({ minLength: 1 });
const MAX_CHUNK = 4 * 1024 * 1024;

export const fileTools: readonly CodemodeTool[] = [
	localTool(
		"file_list",
		"List RAM files available for spreadsheet, document and presentation tools or attachment bridges. Files disappear after restart or 24 idle hours.",
		Type.Object({}, { additionalProperties: false }),
		async () => listFiles(),
	),
	localTool(
		"file_read",
		"Read immutable file bytes as base64 for MCP/email attachments. Offset and length count bytes, not base64 characters; max 4 MiB per chunk. Concatenate decoded chunks for larger files.",
		Type.Object(
			{
				fileId,
				offset: Type.Optional(
					Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
				),
				length: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CHUNK })),
			},
			{ additionalProperties: false },
		),
		async (args) => {
			const offset = args.offset ?? 0;
			const length = args.length ?? MAX_CHUNK;
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
