import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { UserInput } from "@earendil-works/pi-durable";
import type { CommandContext, Context, Filter } from "grammy";

import { root } from "../agent/harness.ts";
import { memory } from "../agent/memory.ts";
import { readDocument } from "../documents/read.ts";
import { type FileMetadata, putFile } from "../files/store.ts";
import { officeFormat, officeFormats } from "../office/formats.ts";
import { transcribe } from "../voice/whisper.ts";
import { bot, chatId } from "./bot.ts";
import { downloadFile, MAX_DOWNLOAD_BYTES } from "./files.ts";
import { startProgress, stopProgress } from "./progress.ts";
import { setReplyTarget } from "./reply-target.ts";

// How the model refers to a file the chat sent in file and Office tools.
const fileReference = (file: FileMetadata): string =>
	JSON.stringify({
		fileId: file.id,
		fileName: file.fileName,
		mimeType: file.mimeType,
		size: file.size,
	});

const submitInput = async (
	messageId: number,
	content: UserInput,
): Promise<void> => {
	setReplyTarget(messageId);
	startProgress(messageId);

	try {
		const submission = await root.submit(
			{ type: "input", content },
			BACKGROUND_CONTEXT,
		);

		const settled = await submission.wait(BACKGROUND_CONTEXT);

		// An input /compact cut short needs no word; any other one left unanswered
		// tells the chat why, e.g. that no model it can use is logged in.
		if (settled.status === "unanswered" && settled.reason !== "aborted") {
			const why =
				typeof settled.detail === "string" ? settled.detail : settled.reason;
			await bot.api.sendMessage(chatId, `⚠️ Nie udało się odpowiedzieć: ${why}`);
		}
	} finally {
		stopProgress();
	}
};

export const handleTextMessage = async (
	ctx: Filter<Context, "message:text">,
): Promise<void> => {
	console.log("Received message:", ctx.message.text);

	await submitInput(ctx.message.message_id, ctx.message.text);
};

// The model sees the photo itself; its caption, if any, comes along as text.
export const handlePhotoMessage = async (
	ctx: Filter<Context, "message:photo">,
): Promise<void> => {
	const { caption, photo, message_id } = ctx.message;
	console.log("Received photo:", caption ?? "");

	// Telegram lists the sizes of a photo from smallest to largest.
	const largest = photo[photo.length - 1];
	if (!largest) return;

	// Telegram re-encodes every photo as JPEG.
	const image = await downloadFile(largest.file_id);
	let attachment: string;
	try {
		const file = putFile({
			data: image,
			fileName: `photo-${message_id}.jpg`,
			mimeType: "image/jpeg",
		});
		attachment = `Telegram photo stored as JPEG for file/image tools: ${fileReference(file)}. RAM reference expires on restart or after 24 idle hours.`;
	} catch (error) {
		console.error("Retaining photo bytes failed:", error);
		attachment =
			"The photo is shown below, but its bytes could not be retained for file/image tools. Release unused RAM files before uploading it again.";
	}

	await submitInput(message_id, [
		...(caption ? [{ type: "text" as const, text: caption }] : []),
		{ type: "text", text: attachment },
		{ type: "image", data: image.toString("base64"), mimeType: "image/jpeg" },
	]);
};

// Editable Office files are inspected through format tools; other attachments
// have a model-facing preview separate from their immutable original bytes.
export const handleDocumentMessage = async (
	ctx: Filter<Context, "message:document">,
): Promise<void> => {
	const { caption, document, message_id } = ctx.message;
	const fileName = document.file_name ?? "file";
	const mimeType = document.mime_type ?? "application/octet-stream";
	console.log("Received document:", fileName, mimeType);

	const content: Exclude<UserInput, string> = [];
	if ((document.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
		content.push({
			type: "text",
			text: `The user sent the file "${fileName}" (${mimeType}). It is larger than the 20 MB a Telegram bot may download, so its content cannot be shown.`,
		});
	} else {
		try {
			const data = await downloadFile(document.file_id);
			const file = putFile({ data, fileName, mimeType });
			const format = officeFormat(file);
			content.push({
				type: "text",
				text: `Original attachment stored in memory: ${fileReference(file)}. This fileId expires on restart or after 24 idle hours. ${format ? `Use ${officeFormats[format].tools} to open an editable copy and inspect the original ${format.toUpperCase()} content. Format tools also preview and export derivatives; no automatic PDF conversion was made.` : "Use file tools to access the original bytes; any preview below is separate."}`,
			});
			if (!format)
				content.push(...(await readDocument({ data, fileName, mimeType })));
		} catch (error) {
			console.error(`Receiving document ${fileName} failed:`, error);
			content.push({
				type: "text",
				text: `The user sent the file "${fileName}" (${mimeType}), but its content could not be downloaded, retained or previewed.`,
			});
		}
	}

	await submitInput(message_id, [
		...(caption ? [{ type: "text" as const, text: caption }] : []),
		...content,
	]);
};

// The model gets what was said, as if it had been typed.
export const handleVoiceMessage = async (
	ctx: Filter<Context, "message:voice">,
): Promise<void> => {
	const { voice, message_id } = ctx.message;

	const text = await transcribe({
		data: await downloadFile(voice.file_id),
		fileName: "voice.ogg",
		mimeType: voice.mime_type ?? "audio/ogg",
	});
	console.log("Received voice:", text);
	if (!text) return;

	await submitInput(message_id, text);
};

// Ends the session: it becomes a line of long-term memory and a new context
// starts. The chat hears when the compaction begins and when it is done.
export const handleCompactCommand = async (
	ctx: CommandContext<Context>,
): Promise<void> => {
	await ctx.reply("🗜️ Kompaktuję rozmowę…");
	await memory.compact(root, BACKGROUND_CONTEXT);
	await ctx.reply("✅ Rozmowa skompaktowana.");
};
