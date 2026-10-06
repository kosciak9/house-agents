// Speech to text through a Whisper server with the OpenAI transcription API,
// e.g. whisper.cpp's `whisper-server`; the deployment points WHISPER_API_URL
// at its `/v1/audio/transcriptions` endpoint.
const whisperUrl = process.env.WHISPER_API_URL;
if (!whisperUrl) {
	throw new Error("WHISPER_API_URL is required");
}

const TIMEOUT_MS = 5 * 60_000;

export type Audio = {
	data: Buffer;
	fileName: string;
	mimeType: string;
};

/** Transcribes speech in any language the server detects. */
export const transcribe = async (audio: Audio): Promise<string> => {
	const form = new FormData();
	form.append(
		"file",
		new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }),
		audio.fileName,
	);
	form.append("model", "whisper-1");
	form.append("response_format", "json");

	const response = await fetch(whisperUrl, {
		method: "POST",
		body: form,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Transcription failed: ${response.status}`);
	}

	const { text } = (await response.json()) as { text?: unknown };
	if (typeof text !== "string") {
		throw new Error("Transcription response has no text");
	}

	return text.trim();
};
