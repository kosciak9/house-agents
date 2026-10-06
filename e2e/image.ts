import { crc32, deflateSync } from "node:zlib";

export const COLORS = [
	{ rgb: [220, 20, 20], answer: /czerwon/i },
	{ rgb: [20, 180, 20], answer: /zielon/i },
	{ rgb: [20, 40, 220], answer: /niebiesk/i },
] as const;

const pngChunk = (type: string, data: Buffer): Buffer => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, checksum]);
};

/** A square PNG of one color. */
export const solidPng = (rgb: readonly number[], size: number): Buffer => {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.writeUInt8(8, 8); // bit depth
	header.writeUInt8(2, 9); // truecolor RGB
	const row = Buffer.concat([
		Buffer.from([0]), // no filter
		Buffer.from(Array.from({ length: size }, () => rgb).flat()),
	]);
	const pixels = Buffer.concat(Array.from({ length: size }, () => row));

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(pixels)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
};
