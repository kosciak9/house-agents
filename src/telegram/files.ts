import { bot, environment } from "./bot.ts";

// Test environment files live under their own path, like its API methods.
const fileUrl = (filePath: string): string =>
	environment === "test"
		? `https://api.telegram.org/file/bot${bot.token}/test/${filePath}`
		: `https://api.telegram.org/file/bot${bot.token}/${filePath}`;

/** The largest file the Bot API lets a bot download. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Downloads a file the chat sent, by its Telegram file id. */
export const downloadFile = async (fileId: string): Promise<Buffer> => {
	const file = await bot.api.getFile(fileId);
	if (!file.file_path) {
		throw new Error(`Telegram returned no path for file ${fileId}`);
	}
	if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES)
		throw new Error("Telegram file exceeds the 20 MB download limit");

	const response = await fetch(fileUrl(file.file_path));
	if (!response.ok) {
		throw new Error(`Downloading file ${fileId} failed: ${response.status}`);
	}

	if (!response.body) throw new Error("Telegram file download has no body");
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_DOWNLOAD_BYTES) {
				await reader.cancel();
				throw new Error("Telegram file exceeds the 20 MB download limit");
			}
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks, size);
	} finally {
		reader.releaseLock();
	}
};
