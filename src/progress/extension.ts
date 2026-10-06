import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

export type ToolProgressEvent = {
	type: "tool-started" | "tool-finished";
	id: string;
	name: string;
};

export type PublishProgress = (event: ToolProgressEvent) => Promise<void>;

export const createProgressExtension = (publish: PublishProgress) =>
	defineExtension({
		name: "tool-progress",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call) => {
					await publish({ type: "tool-started", id: call.id, name: call.name });
					return undefined;
				},

				afterTool: async (call) => {
					await publish({
						type: "tool-finished",
						id: call.id,
						name: call.name,
					});
					return undefined;
				},
			}),
		],
	});
