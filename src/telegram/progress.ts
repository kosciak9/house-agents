import type { ToolProgressEvent } from "../progress/extension.ts";
import { bot, chatId } from "./bot.ts";

type ToolProgress = {
	name: string;
	status: "running" | "done";
};

type ActiveDraft = {
	draftId: number;
	tools: ReadonlyMap<string, ToolProgress>;
};

let activeDraft: ActiveDraft | undefined;

export const startProgress = (draftId: number): void => {
	activeDraft = { draftId, tools: new Map() };
};

export const stopProgress = (): void => {
	activeDraft = undefined;
};

const toToolProgress = (event: ToolProgressEvent): ToolProgress => ({
	name: event.name,
	status: event.type === "tool-started" ? "running" : "done",
});

const renderProgress = (tools: Iterable<ToolProgress>): string =>
	[...tools]
		.map((tool) =>
			tool.status === "running" ? `▸ **${tool.name}**` : `✓ ${tool.name}`,
		)
		.join("\n");

export const publishProgress = async (
	event: ToolProgressEvent,
): Promise<void> => {
	if (!activeDraft) return;

	const draft: ActiveDraft = {
		...activeDraft,
		tools: new Map(activeDraft.tools).set(event.id, toToolProgress(event)),
	};
	activeDraft = draft;

	const markdown = renderProgress(draft.tools.values());
	if (!markdown) return;

	await bot.api.sendRichMessageDraft(chatId, draft.draftId, {
		markdown,
	});
};
