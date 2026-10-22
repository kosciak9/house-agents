import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { UserInput } from "@earendil-works/pi-durable";
import type { CommandContext, Context, Filter } from "grammy";
import type { Message } from "grammy/types";

import { root } from "../agent/harness.ts";
import { memory } from "../agent/memory.ts";
import { readDocument } from "../documents/read.ts";
import { type FileMetadata, putFile } from "../files/store.ts";
import { officeFormat, officeFormats } from "../office/formats.ts";
import { transcribe } from "../voice/whisper.ts";
import { bot } from "./bot.ts";
import { downloadFile, MAX_DOWNLOAD_BYTES } from "./files.ts";
import { recall, remember, type Said } from "./history.ts";
import { hold, parts, receive } from "./turns.ts";

// How the model refers to a file the chat sent in file and Office tools.
const fileReference = (file: FileMetadata): string =>
	JSON.stringify({
		fileId: file.id,
		fileName: file.fileName,
		mimeType: file.mimeType,
		size: file.size,
	});

const EXCERPT_LENGTH = 1_000;

const excerpt = (text: string): string =>
	text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;

// What a message the chat points at said, as far as the bot knows.
const described = (messageId: number, message?: Message): Said | undefined => {
	const known = recall(messageId);
	if (known) return known;
	if (!message) return undefined;
	const text =
		message.text ??
		message.caption ??
		(message.photo && "(a photo)") ??
		(message.voice && "(a voice message)") ??
		(message.document &&
			`(the file "${message.document.file_name ?? "file"}")`);
	if (text === undefined) return undefined;
	return {
		from: message.from?.id === bot.botInfo.id ? "agent" : "user",
		text,
	};
};

const whose = ({ from }: Said): string =>
	from === "agent" ? "your message" : "their own message";

// A reply says which message it answers, and the part of it it quotes.
const replyContext = (message: Message): Exclude<UserInput, string> => {
	const replied = message.reply_to_message;
	if (!replied) return [];
	const said = described(replied.message_id, replied);
	const text = message.quote?.text ?? said?.text;
	if (!said || text === undefined)
		return [{ type: "text", text: "The user replies to an earlier message." }];
	const verb = message.quote ? "quotes" : "replies to";
	return [
		{
			type: "text",
			text: `The user ${verb} ${whose(said)}: "${excerpt(text)}"`,
		},
	];
};

// The handlers remember what each message said, once they know it.
const receiveMessage = (
	message: Message,
	read: () => Promise<UserInput | undefined>,
): void => {
	const context = replyContext(message);
	receive({
		messageId: message.message_id,
		content: read().then((content) =>
			content === undefined || context.length === 0
				? content
				: [...context, ...parts(content)],
		),
	});
};

export const handleTextMessage = (
	ctx: Filter<Context, "message:text">,
): void => {
	const { message } = ctx;
	console.log("Received message:", message.text);
	remember(message.message_id, { from: "user", text: message.text });

	receiveMessage(message, async () => message.text);
};

// The model sees the photo itself; its caption, if any, comes along as text.
export const handlePhotoMessage = (
	ctx: Filter<Context, "message:photo">,
): void => {
	const { message } = ctx;
	const { caption, photo, message_id } = message;
	console.log("Received photo:", caption ?? "");
	remember(message_id, { from: "user", text: caption ?? "(a photo)" });

	receiveMessage(message, async () => {
		// Telegram lists the sizes of a photo from smallest to largest.
		const largest = photo[photo.length - 1];
		if (!largest) return undefined;

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

		return [
			...(caption ? [{ type: "text" as const, text: caption }] : []),
			{ type: "text", text: attachment },
			{ type: "image", data: image.toString("base64"), mimeType: "image/jpeg" },
		];
	});
};

// Editable Office files are inspected through format tools; other attachments
// have a model-facing preview separate from their immutable original bytes.
export const handleDocumentMessage = (
	ctx: Filter<Context, "message:document">,
): void => {
	const { message } = ctx;
	const { caption, document, message_id } = message;
	const fileName = document.file_name ?? "file";
	const mimeType = document.mime_type ?? "application/octet-stream";
	console.log("Received document:", fileName, mimeType);
	remember(message_id, {
		from: "user",
		text: caption ?? `(the file "${fileName}")`,
	});

	receiveMessage(message, async () => {
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

		return [
			...(caption ? [{ type: "text" as const, text: caption }] : []),
			...content,
		];
	});
};

// The model gets what was said, as if it had been typed.
export const handleVoiceMessage = (
	ctx: Filter<Context, "message:voice">,
): void => {
	const { message } = ctx;
	const { voice, message_id } = message;

	receiveMessage(message, async () => {
		const text = await transcribe({
			data: await downloadFile(voice.file_id),
			fileName: "voice.ogg",
			mimeType: voice.mime_type ?? "audio/ogg",
		});
		console.log("Received voice:", text);
		if (!text) return undefined;
		remember(message_id, { from: "user", text });
		return text;
	});
};

// A reaction names only the message it lands on; the model is told what that
// message said, if the bot still knows, along with the next message.
export const handleReaction = (
	ctx: Filter<Context, "message_reaction">,
): void => {
	const { message_id } = ctx.messageReaction;
	const { emojiAdded, emojiRemoved, customEmojiAdded, customEmojiRemoved } =
		ctx.reactions();
	const added = [
		...emojiAdded,
		...customEmojiAdded.map(() => "(custom emoji)"),
	];
	const removed = [
		...emojiRemoved,
		...customEmojiRemoved.map(() => "(custom emoji)"),
	];
	if (added.length === 0 && removed.length === 0) return;
	console.log("Received reaction:", added, removed);

	const said = described(message_id);
	const target = said
		? `${whose(said)}: "${excerpt(said.text)}"`
		: "an earlier message you no longer know";
	const text = [
		...(added.length > 0
			? [`The user reacted with ${added.join(" ")} to ${target}`]
			: []),
		...(removed.length > 0
			? [`The user took back their ${removed.join(" ")} reaction to ${target}`]
			: []),
	].join("\n");
	hold(text);
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
