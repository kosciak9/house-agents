import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isContextOverflow } from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type Conversation,
	type Harness,
	watchEvents,
} from "@earendil-works/pi-durable";
import { Cron } from "croner";

// Compacts the conversation `idleMs` after the run answering the user's last
// message, once its context reaches `maxTokens`, when a run ends on a context
// overflow, and at every firing of `cron`: each compaction gives the session
// its line of memory and starts a new context. Scheduled prompts and subagent
// reports neither keep the session open nor end it; a compaction due while
// they run waits for their run to end. Timers live in this process; after a
// restart the idle time counts from the start.

export type CompactionLimits = {
	idleMs: number;
	maxTokens: number;
	/** E.g. after the agent's own night routine; the agent never knows. */
	cron?: { cron: string; timeZone?: string };
};

// The newest answer, when it is the agent's own.
const assistantMessage = (event: AgentEvent) => {
	if (event.type !== "message_end" || event.entry.kind !== "pi.assistant") {
		return undefined;
	}
	const message = event.entry.model?.[0];
	return message?.role === "assistant" ? message : undefined;
};

let onUserInput = (): void => {};

/** The user said something: the idle time counts from the run answering it. */
export const userSpoke = (): void => onUserInput();

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
	// The user spoke since the last run ended.
	let spoke = false;
	// A compaction waits for the current run to end.
	let due = false;
	let timer: NodeJS.Timeout | undefined;

	const run = async () => {
		if (busy) {
			due = true;
			return;
		}
		clearTimeout(timer);
		due = false;
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

	onUserInput = () => {
		spoke = true;
		clearTimeout(timer);
	};

	if (limits.cron) {
		const schedule = new Cron(limits.cron.cron, {
			timezone: limits.cron.timeZone,
			unref: true,
		});
		schedule.schedule(() => run());
	}

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
			} else if (event.type === "run_end") {
				busy = false;
				if (due || overflow || tokens >= limits.maxTokens) await run();
				else if (spoke) {
					spoke = false;
					arm();
				}
			}
		}
	});
	arm();
};
