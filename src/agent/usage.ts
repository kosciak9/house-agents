import type { JsonRepresentation } from "@earendil-works/chord";
import type { Usage } from "@earendil-works/pi-ai";
import {
	defineEntry,
	type EntryId,
	ROOT_CONVERSATION_ID,
	type Tx,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";

// Background memory calls have no model-facing entry. Keep their spend in the
// native ledger and an application-only entry, so /current can select a range.
const ModelUsageEntry = defineEntry<{
	model: string;
	usage: JsonRepresentation<Usage>;
}>("agent.model-usage");

export const emptyUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export const addUsage = (total: Usage, usage: Readonly<Usage>): void => {
	for (const key of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"totalTokens",
	] as const)
		total[key] += usage[key];
	for (const key of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"total",
	] as const)
		total.cost[key] += usage.cost[key];
	if (usage.reasoning !== undefined)
		total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	if (usage.cacheWrite1h !== undefined)
		total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
};

const addToBucket = (
	bucket: UsageState["models"],
	key: string,
	usage: Usage,
) => {
	const total = Object.hasOwn(bucket, key) ? bucket[key] : emptyUsage();
	addUsage(total, usage);
	Object.defineProperty(bucket, key, {
		value: total,
		enumerable: true,
		writable: true,
		configurable: true,
	});
};

export const recordModelUsage = async (
	tx: Tx,
	model: string,
	usage: Usage | undefined,
): Promise<void> => {
	if (!usage) return;
	const recorded = emptyUsage();
	addUsage(recorded, usage);
	const ledger = await tx.doc(UsageDoc, ROOT_CONVERSATION_ID);
	// Draft maps already have the known model keys; avoid reflection on drafts.
	if (!Object.hasOwn(ledger.models, model)) ledger.models[model] = emptyUsage();
	addUsage(ledger.models[model], recorded);
	await tx.appendEntry(ModelUsageEntry, ROOT_CONVERSATION_ID, {
		data: { model, usage: recorded },
	});
};

/** All agent and subagent spend recorded since the main context's head. */
export const currentUsage = async (
	tx: Tx,
	from: EntryId | undefined,
): Promise<UsageState> => {
	const state: UsageState = { models: {}, tools: {} };
	let conversationsCursor: Parameters<Tx["scanConversations"]>[2];
	do {
		const conversations = await tx.scanConversations(
			{},
			100,
			conversationsCursor,
		);
		for (const conversation of conversations.items) {
			let cursor: Parameters<Tx["scanEntries"]>[2];
			do {
				const page = await tx.scanEntries(
					{
						conversationId: conversation.id,
						...(from !== undefined && { minEntryId: from }),
					},
					100,
					cursor,
				);
				for (const entry of page.items) {
					if (ModelUsageEntry.is(entry)) {
						addToBucket(state.models, entry.data.model, entry.data.usage);
					}
					for (const message of entry.model ?? []) {
						if (message.role === "assistant") {
							addToBucket(
								state.models,
								`${message.provider}/${message.model}`,
								message.usage,
							);
						} else if (message.role === "toolResult" && message.usage) {
							addToBucket(state.tools, message.toolName, message.usage);
						}
					}
				}
				cursor = page.next;
			} while (cursor !== undefined);
		}
		conversationsCursor = conversations.next;
	} while (conversationsCursor !== undefined);
	return state;
};
