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

	const response = await fetch(fileUrl(file.file_path));
	if (!response.ok) {
		throw new Error(`Downloading file ${fileId} failed: ${response.status}`);
	}

	return Buffer.from(await response.arrayBuffer());
};
