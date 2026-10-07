import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isContextOverflow } from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type Conversation,
	type Harness,
	watchEvents,
} from "@earendil-works/pi-durable";

// Compacts the conversation after `idleMs` without a run, once its context
// reaches `maxTokens`, or when a run ends on a context overflow: each
// compaction gives the session its line of memory and starts a new context.
// Timers live in this process; after a restart the idle time counts from the
// start.

export type CompactionLimits = {
	idleMs: number;
	maxTokens: number;
};

// The newest answer, when it is the agent's own.
const assistantMessage = (event: AgentEvent) => {
	if (event.type !== "message_end" || event.entry.kind !== "pi.assistant") {
		return undefined;
	}
	const message = event.entry.model?.[0];
	return message?.role === "assistant" ? message : undefined;
};

export const compactWhenDue = async ({
	harness,
	conversation,
	limits,
	compact,
}: {
	harness: Harness;
	conversation: Conversation;
	limits: CompactionLimits;
	compact: (conversation: Conversation) => Promise<void>;
}): Promise<void> => {
	let busy = false;
	let tokens = 0;
	let overflow = false;
	let timer: NodeJS.Timeout | undefined;

	const run = async () => {
		if (busy) return;
		tokens = 0;
		overflow = false;
		try {
			await compact(conversation);
		} catch (error) {
			console.error("Compacting the conversation failed:", error);
		}
	};

	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(run, limits.idleMs);
		timer.unref();
	};

	const stream = await watchEvents(
		harness,
		conversation.id,
		BACKGROUND_CONTEXT,
	);
	stream.start(async (events) => {
		for (const event of events) {
			const message = assistantMessage(event);
			if (message !== undefined) {
				// Tokens the model saw for its answer: the size of the context.
				const { input, cacheRead, cacheWrite, output } = message.usage;
				tokens = input + cacheRead + cacheWrite + output;
				overflow = isContextOverflow(message);
			}
			if (event.type === "run_start") {
				busy = true;
				clearTimeout(timer);
			} else if (event.type === "run_end") {
				busy = false;
				if (overflow || tokens >= limits.maxTokens) await run();
				else arm();
			}
		}
	});
	arm();
};
