import { randomUUID } from "node:crypto";
import type { CodemodeTool } from "@earendil-works/pi-codemode";

export type FileMetadata = {
	id: string;
	fileName: string;
	mimeType: string;
	size: number;
};
type StoredFile = FileMetadata & { data: Buffer; touched: number };
const files = new Map<string, StoredFile>();
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const TTL = 24 * 60 * 60_000;

const prune = () => {
	for (const [id, file] of files)
		if (Date.now() - file.touched > TTL) files.delete(id);
};
const metadata = ({
	id,
	fileName,
	mimeType,
	size,
}: FileMetadata): FileMetadata => ({ id, fileName, mimeType, size });

/** RAM only. Both ingress and egress copy bytes so source files stay immutable. */
export const putFile = (input: {
	data: Buffer;
	fileName: string;
	mimeType: string;
}): FileMetadata => {
	prune();
	if (!Buffer.isBuffer(input.data) || !input.fileName || !input.mimeType)
		throw new Error("File bytes, name and MIME type are required.");
	const used = [...files.values()].reduce((sum, file) => sum + file.size, 0);
	if (
		input.data.length > MAX_FILE_BYTES ||
		used + input.data.length > MAX_BYTES ||
		files.size >= 128
	)
		throw new Error(
			"RAM file budget exceeded (64 MiB/file, 256 MiB total, 128 files). Release unused files first.",
		);
	const file = {
		...input,
		data: Buffer.from(input.data),
		id: randomUUID(),
		size: input.data.length,
		touched: Date.now(),
	};
	files.set(file.id, file);
	return metadata(file);
};

export const getFile = (
	id: string,
): { data: Buffer; fileName: string; mimeType: string } => {
	prune();
	const file = files.get(id);
	if (!file)
		throw new Error(
			"File unavailable: RAM files expire after 24 idle hours, release, or restart. Upload the source again.",
		);
	file.touched = Date.now();
	return {
		data: Buffer.from(file.data),
		fileName: file.fileName,
		mimeType: file.mimeType,
	};
};
export const listFiles = (): FileMetadata[] => {
	prune();
	return [...files.values()].map(metadata);
};

const objectArgs = (args: unknown): Record<string, unknown> => {
	if (!args || typeof args !== "object" || Array.isArray(args))
		throw new Error("Expected an argument object.");
	return args as Record<string, unknown>;
};
const idArg = (args: Record<string, unknown>): string => {
	if (typeof args.fileId !== "string" || !args.fileId)
		throw new Error("fileId must be a nonempty string.");
	return args.fileId;
};

export const fileTools: readonly CodemodeTool[] = [
	{
		name: "file_list",
		description:
			"List RAM files available for spreadsheet tools or attachment bridges. Files disappear after restart or 24 idle hours.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		execute: async (args) => {
			objectArgs(args);
			return listFiles();
		},
	},
	{
		name: "file_read",
		description:
			"Read immutable file bytes as base64 for MCP/email attachments. Offset and length count bytes, not base64 characters; max 4 MiB per chunk. Concatenate decoded chunks for larger files.",
		inputSchema: {
			type: "object",
			properties: {
				fileId: { type: "string" },
				offset: { type: "integer", minimum: 0 },
				length: { type: "integer", minimum: 1, maximum: 4194304 },
			},
			required: ["fileId"],
			additionalProperties: false,
		},
		execute: async (input) => {
			const args = objectArgs(input);
			const id = idArg(args);
			const offset = args.offset ?? 0;
			const length = args.length ?? 4194304;
			if (
				typeof offset !== "number" ||
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				typeof length !== "number" ||
				!Number.isSafeInteger(length) ||
				length < 1 ||
				length > 4194304
			)
				throw new Error("Invalid byte offset/length; maximum chunk is 4 MiB.");
			const file = getFile(id);
			if (offset > file.data.length)
				throw new Error("Offset exceeds file size.");
			const chunk = file.data.subarray(offset, offset + length);
			return {
				id,
				fileName: file.fileName,
				mimeType: file.mimeType,
				size: file.data.length,
				offset,
				length: chunk.length,
				nextOffset: offset + chunk.length,
				eof: offset + chunk.length === file.data.length,
				base64: chunk.toString("base64"),
			};
		},
	},
	{
		name: "file_release",
		description:
			"Release a RAM file. Already opened workbook copies are unaffected.",
		inputSchema: {
			type: "object",
			properties: { fileId: { type: "string" } },
			required: ["fileId"],
			additionalProperties: false,
		},
		execute: async (args) => ({
			released: files.delete(idArg(objectArgs(args))),
		}),
	},
];
