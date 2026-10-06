import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AgentEvent,
	type Conversation,
	type Harness,
	watchEvents,
} from "@earendil-works/pi-durable";

// Ends a session of the conversation after `idleMs` without a run, or once its
// context reaches `maxTokens`: each ending gives the session its line of
// memory and starts a new context. Timers live in this process; after a
// restart the idle time counts from the start.

export type SessionLimits = {
	idleMs: number;
	maxTokens: number;
};

// Tokens the model saw for the newest answer: the size of the context.
const contextTokens = (event: AgentEvent): number | undefined => {
	if (event.type !== "message_end" || event.entry.kind !== "pi.assistant") {
		return undefined;
	}
	const message = event.entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	const { input, cacheRead, cacheWrite, output } = message.usage;
	return input + cacheRead + cacheWrite + output;
};

export const keepSessions = async ({
	harness,
	conversation,
	limits,
	endSession,
}: {
	harness: Harness;
	conversation: Conversation;
	limits: SessionLimits;
	endSession: (conversation: Conversation) => Promise<void>;
}): Promise<void> => {
	let busy = false;
	let tokens = 0;
	let timer: NodeJS.Timeout | undefined;

	const end = async () => {
		if (busy) return;
		tokens = 0;
		try {
			await endSession(conversation);
		} catch (error) {
			console.error("Ending the session failed:", error);
		}
	};

	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(end, limits.idleMs);
		timer.unref();
	};

	const stream = await watchEvents(
		harness,
		conversation.id,
		BACKGROUND_CONTEXT,
	);
	stream.start(async (events) => {
		for (const event of events) {
			tokens = contextTokens(event) ?? tokens;
			if (event.type === "run_start") {
				busy = true;
				clearTimeout(timer);
			} else if (event.type === "run_end") {
				busy = false;
				if (tokens >= limits.maxTokens) await end();
				else arm();
			}
		}
	});
	arm();
};
