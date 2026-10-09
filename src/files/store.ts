import { randomUUID } from "node:crypto";

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

const requireFile = (id: string): StoredFile => {
	prune();
	const file = files.get(id);
	if (!file)
		throw new Error(
			"File unavailable: RAM files expire after 24 idle hours, release, or restart. Upload the source again.",
		);
	file.touched = Date.now();
	return file;
};

export const getFile = (
	id: string,
): { data: Buffer; fileName: string; mimeType: string } => {
	const file = requireFile(id);
	return {
		data: Buffer.from(file.data),
		fileName: file.fileName,
		mimeType: file.mimeType,
	};
};

/** Copy only the requested bytes, not the whole file for each attachment chunk. */
export const readFileChunk = (id: string, offset: number, length: number) => {
	const file = requireFile(id);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
		throw new Error("Offset exceeds file size or is invalid.");
	if (!Number.isSafeInteger(length) || length < 1)
		throw new Error("Chunk length must be a positive integer.");
	return {
		...metadata(file),
		data: Buffer.from(file.data.subarray(offset, offset + length)),
	};
};
export const listFiles = (): FileMetadata[] => {
	prune();
	return [...files.values()].map(metadata);
};

export const releaseFile = (id: string): { released: boolean } => ({
	released: files.delete(id),
});
