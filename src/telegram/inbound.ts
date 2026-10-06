import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { UserInput } from "@earendil-works/pi-durable";
import type { CommandContext, Context, Filter } from "grammy";

import { root } from "../agent/harness.ts";
import { transcribe } from "../voice/whisper.ts";
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

		if (settled.status !== "done" || settled.type !== "input") {
			throw new Error(`Unexpected submission result: ${settled.status}`);
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

// Starts a new context; the transcript stays in storage and the long-term
// memory is read afresh at the next request.
export const handleResetCommand = async (
	ctx: CommandContext<Context>,
): Promise<void> => {
	await root.reset(undefined, BACKGROUND_CONTEXT);
	await ctx.react("👍");
};
