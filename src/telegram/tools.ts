import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { InputFile } from "grammy";

import { getFile } from "../files/store.ts";
import { bot, chatId } from "./bot.ts";

/** Telegram is an edge adapter: spreadsheet and file tools never import it. */
export const telegramTools: readonly CodemodeTool[] = [
	{
		name: "telegram_send_file",
		description:
			"Send a stored file to the user's Telegram chat by fileId, with an optional plain-text caption. Returns metadata, never bytes.",
		inputSchema: {
			type: "object",
			properties: {
				fileId: { type: "string" },
				caption: { type: "string", maxLength: 1024 },
			},
			required: ["fileId"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				fileId: { type: "string" },
				fileName: { type: "string" },
				mimeType: { type: "string" },
				size: { type: "integer" },
				messageId: { type: "integer" },
			},
			required: ["fileId", "fileName", "mimeType", "size", "messageId"],
		},
		execute: async (args, { signal }) => {
			if (
				typeof args !== "object" ||
				args === null ||
				Array.isArray(args) ||
				!("fileId" in args) ||
				typeof args.fileId !== "string" ||
				!args.fileId ||
				("caption" in args &&
					(typeof args.caption !== "string" || args.caption.length > 1024)) ||
				Object.keys(args).some((key) => key !== "fileId" && key !== "caption")
			)
				throw new Error(
					"telegram_send_file expects { fileId: string, caption?: string (at most 1024 characters) }",
				);
			const file = getFile(args.fileId);
			const caption = "caption" in args ? args.caption : undefined;
			signal.throwIfAborted();
			const sent = await bot.api.sendDocument(
				chatId,
				new InputFile(file.data, file.fileName),
				{ ...(typeof caption === "string" && { caption }) },
				// grammY types its Node shim's older AbortSignal; node-fetch accepts
				// the native signal too (both expose the same cancellation protocol).
				signal as Parameters<typeof bot.api.sendDocument>[3],
			);
			return {
				fileId: args.fileId,
				fileName: file.fileName,
				mimeType: file.mimeType,
				size: file.data.length,
				messageId: sent.message_id,
			};
		},
	},
];
