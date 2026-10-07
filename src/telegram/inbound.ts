import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { UserInput } from "@earendil-works/pi-durable";
import type { CommandContext, Context, Filter } from "grammy";

import { root } from "../agent/harness.ts";
import { memory } from "../agent/memory.ts";
import { transcribe } from "../voice/whisper.ts";
import { bot, chatId } from "./bot.ts";
import { downloadFile } from "./files.ts";
import { startProgress, stopProgress } from "./progress.ts";

const submitInput = async (
	messageId: number,
	content: UserInput,
): Promise<void> => {
	startProgress(messageId);

	try {
		const submission = await root.submit(
			{ type: "input", content },
			BACKGROUND_CONTEXT,
		);

		const settled = await submission.wait(BACKGROUND_CONTEXT);

		// An input /reset cut short needs no word; any other one left unanswered
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

	await submitInput(message_id, [
		...(caption ? [{ type: "text" as const, text: caption }] : []),
		{ type: "image", data: image.toString("base64"), mimeType: "image/jpeg" },
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
// starts. The chat hears when the reset begins and when it is done.
export const handleResetCommand = async (
	ctx: CommandContext<Context>,
): Promise<void> => {
	await ctx.reply("🔄 Resetuję rozmowę…");
	await memory.endSession(root, BACKGROUND_CONTEXT);
	await ctx.reply("✅ Zaczynamy od nowa.");
};
