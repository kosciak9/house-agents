import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { InputFile } from "grammy";
import { Type } from "typebox";

import { localTool } from "../codemode/local-tool.ts";
import { getFile } from "../files/store.ts";
import { bot, chatId } from "./bot.ts";

/** Telegram is an edge adapter: local file editing tools never import it. */
export const telegramTools: readonly CodemodeTool[] = [
	{
		...localTool(
			"telegram_send_file",
			"Send a stored file to the user's Telegram chat by fileId, with an optional plain-text caption. Returns metadata, never bytes.",
			Type.Object(
				{
					fileId: Type.String({ minLength: 1 }),
					caption: Type.Optional(Type.String({ maxLength: 1024 })),
				},
				{ additionalProperties: false },
			),
			async ({ fileId, caption }, { signal }) => {
				const file = getFile(fileId);
				const sent = await bot.api.sendDocument(
					chatId,
					new InputFile(file.data, file.fileName),
					{ ...(caption !== undefined && { caption }) },
					// grammY types its Node shim's older AbortSignal; node-fetch accepts
					// the native signal too (both expose the same cancellation protocol).
					signal as Parameters<typeof bot.api.sendDocument>[3],
				);
				return {
					fileId,
					fileName: file.fileName,
					mimeType: file.mimeType,
					size: file.data.length,
					messageId: sent.message_id,
				};
			},
		),
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
	},
];
