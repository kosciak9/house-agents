import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, Filter } from "grammy";

import { root } from "../agent/harness.ts";
import { startProgress, stopProgress } from "./progress.ts";

export const handleTextMessage = async (
	ctx: Filter<Context, "message:text">,
): Promise<void> => {
	console.log("Received message:", ctx.message.text);

	startProgress(ctx.message.message_id);

	try {
		const submission = await root.submit(
			{ type: "input", content: ctx.message.text },
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
