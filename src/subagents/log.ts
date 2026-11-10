import { defineDoc } from "@earendil-works/pi-durable";

// Every task the agent's own turns hand to a subagent, once it has answered:
// what kind of task it was (its intent), on which model, how it went, what it
// cost and which MCP tools it used. The retro reads the day's to learn which
// model fits which kind of task, and two failures of one intent within
// `RETRY_WINDOW` stop a third try.

export type Status = "done" | "partial" | "failed";

export type Job = {
	/** The job's task id and the task's index in it: one entry per task. */
	id: string;
	at: number;
	intent: string;
	agent: string;
	/** The picked model's name, or `default`. */
	model: string;
	/** As the subagent's answer opens; `null` when it says none. */
	status: Status | null;
	cost: number;
	seconds: number;
	tools: string[];
};

const MAX_JOBS = 500;
const RETRY_WINDOW = 3 * 60 * 60 * 1000;
const MAX_FAILURES = 2;

export const Log = defineDoc<{ jobs: Job[] }>({
	kind: "subagent.log",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ jobs: [] }),
});

/** An intent as the log compares it. */
export const intentOf = (intent: string): string => intent.trim().toLowerCase();

/** Appends `jobs` not logged yet, keeping the newest `MAX_JOBS`. */
export const logJobs = (log: { jobs: Job[] }, jobs: readonly Job[]): void => {
	const known = new Set(log.jobs.map(({ id }) => id));
	log.jobs.push(...jobs.filter(({ id }) => !known.has(id)));
	if (log.jobs.length > MAX_JOBS)
		log.jobs.splice(0, log.jobs.length - MAX_JOBS);
};

const STATUS = /^\W*status:\s*(done|partial|failed)\b/i;

/** How an answer says its task went: its opening `Status:` line. */
export const statusOf = (answer: string): Status | null => {
	if (/^\((failed|stopped)\b/.test(answer)) return "failed";
	const match = STATUS.exec(answer);
	return match ? ((match[1] as string).toLowerCase() as Status) : null;
};

/** When tasks of `intent` failed within the window before `now`, if too often. */
export const tooManyFailures = (
	jobs: readonly Job[],
	intent: string,
	now: number,
): number[] | undefined => {
	const failed = jobs
		.filter(
			(job) =>
				job.status === "failed" &&
				intentOf(job.intent) === intentOf(intent) &&
				job.at > now - RETRY_WINDOW,
		)
		.map(({ at }) => at);
	return failed.length >= MAX_FAILURES ? failed : undefined;
};

export const RETRY_HOURS = RETRY_WINDOW / (60 * 60 * 1000);
