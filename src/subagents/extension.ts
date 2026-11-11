import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import {
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	type Extension,
	ProviderDoc,
	type Registry,
	ROOT_CONVERSATION_ID,
	section,
	type TaskId,
	type TaskRuntime,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";

import { localTools } from "../agent/local-tools.ts";
import { PromptFirstExtension } from "../agent/prompt-first.ts";
import { createCodemodeTool } from "../codemode/tool.ts";
import { modelSettings } from "../config.ts";
import { connectLightpanda } from "../lightpanda/connect.ts";
import { type Connection, connectServers } from "../mcp/client.ts";
import { type ServerConfig, workerPolicy } from "../mcp/config.ts";
import type { TokenStore } from "../mcp/oauth.ts";
import { formatTime } from "../scheduler/schedules.ts";
import { general, type SubagentConfig, workerModels } from "./config.ts";
import { type Dispatched, dispatch } from "./dispatcher.ts";
import {
	intentOf,
	type Job,
	Log,
	logJobs,
	RETRY_HOURS,
	statusOf,
	tooManyFailures,
} from "./log.ts";

// The agent hands tasks to subagents with one tool, `subagent`, and carries
// on: a background task, owned by the agent's conversation but outside its
// runs, gives each task a conversation of its own and runs them all at once.
// Once every one has answered, it hands the answers back to the agent as one
// input. Every task is standalone, without its parent's transcript. General,
// the agent's worker, runs on the worker's prompt and model with the root's
// extensions (memory, skills, delegation) but a codemode of its own: the local
// tools and the MCP tools of the worker's policy, on connections opened for it.
// Specialists keep their configured prompt and isolated tool connections.
//
// A specialist gets the MCP tools its policy allows, and Lightpanda if it has it, on
// connections of its own: opened when it starts and closed once it has
// answered, so each subagent gets a browser of its own. They come in an
// extension of that one conversation, which the agent's default selection
// leaves out.

const RUN_EXTENSION = "subagent-run:";

const MAX_TASKS = 10;

// The tool and its job are linked in one commit, so recovery can await the
// same nested job rather than spawn a duplicate or lose its eventual answer.
const CallDoc = defineDoc<{ job: TaskId<string | null> | null }>({
	kind: "subagent.call",
	version: 1,
	scope: "task",
	initial: () => ({ job: null }),
});

const GENERAL_DESCRIPTION =
	"Your worker, in an isolated context: it reaches the sources and services " +
	"(MCP), files and the web, and reads your memory and skills. Use it for " +
	"everything beyond this conversation, including expensive file editing. Pass the " +
	"source fileId and all requirements; have it open a separate working copy " +
	"or clone before editing, and return the exported fileId in its text answer, " +
	"never file bytes. File and working-copy handles (XLSX, DOCX, PPTX) are volatile: after a process " +
	"restart an old handle may be unavailable; report that failure, do not invent " +
	"a replacement.";

/** Every installed extension but those of one subagent's conversation only. */
export const rootExtensions = (registry: Registry): Extension[] =>
	registry
		.snapshot()
		.installed()
		.filter((extension) => !extension.name.startsWith(RUN_EXTENSION));

// A worker brings its own codemode; the scratchpad and the wake-ups are the
// agent's own: a worker is gone before any of its wake-ups would fire.
const NOT_FOR_WORKERS = new Set(["codemode", "scratchpad", "scheduler"]);

/** The root's extensions a worker gets. */
export const generalExtensions = (registry: Registry): Extension[] =>
	rootExtensions(registry).filter(({ name }) => !NOT_FOR_WORKERS.has(name));

/**
 * A worker's own extension, with its codemode over `tools`; installed again,
 * with the local tools only, before resuming an interrupted general
 * conversation, until its run connects the servers again.
 */
export const createGeneralRunExtension = (
	conversation: ConversationId,
	tools: readonly CodemodeTool[] = localTools,
) =>
	defineExtension({
		name: `${RUN_EXTENSION}${conversation}`,
		tools: [createCodemodeTool(tools)],
		sections: [
			section(
				"subagent-context",
				() =>
					"You are a general subagent working on a standalone task. " +
					"Open your answer with one line, `Status: done`, " +
					"`Status: partial` or `Status: failed`, then report. " +
					"You read the root assistant's long-term memory and skills, " +
					"but not its transcript; only the root writes skills. Return " +
					"a substantive text answer to your parent, not a user-facing " +
					"acknowledgement, reaction or NO_REPLY. If you delegate, " +
					"the subagent tool waits for that work before returning; " +
					"use its answers to finish your own task. File and working-copy " +
					"handles (XLSX, DOCX, PPTX) may not survive a process restart; report " +
					"missing sources explicitly. Return exported fileIds as " +
					"text, never bytes.",
			),
		],
	});

type JobInput = {
	agent: string;
	tasks: string[];
	/** Each task's kind, as the agent labels it (absent in older jobs). */
	intents?: string[];
	/** The worker model each general task picked, by name; `null` the default. */
	models?: (string | null)[];
	/** The root's turn that started it: its jobs report to the root together. */
	batch?: string;
};

type Part = {
	agent: string;
	tasks: string[];
	answers: string[];
	intents?: string[];
};

// The root's jobs by the turn that started them, with each one's answers once
// it has them; the last to answer reports for all, so every task started in
// one turn comes back in one report.
const Batches = defineDoc<{
	batches: Record<string, Record<string, Part | null>>;
}>({
	kind: "subagent.batches",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ batches: {} }),
});

type JobState =
	| { phase: "start" }
	| {
			phase: "run";
			conversations: ConversationId[];
			/**
			 * The dispatcher's briefs and model picks, which replace the agent's;
			 * null for a task it left out.
			 */
			briefs?: (string | null)[];
			models?: (string | null)[];
	  };

const completed = (result: string) =>
	({
		status: "terminal",
		outcome: { status: "completed", result },
	}) as const;

const aborted = {
	status: "terminal",
	outcome: { status: "aborted" },
} as const;

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const answerText = (message: AssistantMessage): string =>
	message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();

const taskTag = (agent: string, intent: string | undefined): string =>
	`<task agent="${agent}"${intent ? ` intent="${intent.replace(/"/g, "'")}"` : ""}>`;

const report = (
	agent: string,
	tasks: string[],
	answers: string[],
	root: boolean,
): string =>
	[
		`Every "${agent}" subagent you started has answered; they are done ` +
			"and gone. " +
			(root
				? "The user has not seen their answers: reply to the user with what they asked for, from these answers, or NO_REPLY if they leave nothing worth telling."
				: "Use these answers to finish your standalone task and report back to your parent."),
		...tasks.map(
			(task, index) =>
				`<task>\n${task}\n</task>\n<answer>\n${answers[index]}\n</answer>`,
		),
	].join("\n\n");

// What the root hears once every job of a turn has answered.
const rootReport = (parts: readonly Part[]): string =>
	[
		"Every subagent you started has answered; they are done and gone. " +
			"The user has not seen their answers: reply to the user with what they asked for, from these answers, or NO_REPLY if they leave nothing worth telling.",
		...parts.flatMap(({ agent, tasks, answers, intents }) =>
			tasks.map(
				(task, index) =>
					`${taskTag(agent, intents?.[index])}\n${task}\n</task>\n<answer>\n${answers[index]}\n</answer>`,
			),
		),
	].join("\n\n");

// The input that started the root's turn which made the tool call `taskId`:
// the newest of the root's inputs before the call's assistant message.
const turnOf = async (
	api: { taskId: TaskId; getTask: ToolExecutionApi["getTask"] },
	context: Context,
): Promise<string | undefined> => {
	const call = await api.getTask(api.taskId, context);
	const assistant = (call?.input as { assistant?: EntryId } | undefined)
		?.assistant;
	if (assistant === undefined) return undefined;
	// Imported late: the harness itself is built from these extensions.
	const { root } = await import("../agent/harness.ts");
	let cursor: Parameters<typeof root.entries>[2];
	do {
		const page = await root.entries(
			{ maxEntryId: assistant },
			100,
			cursor,
			context,
		);
		const input = page.items.find((entry) => entry.kind === "pi.user");
		if (input) return input.id.toString();
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
};

export const createSubagentExtension = ({
	registry,
	subagents,
	servers,
	tokens,
}: {
	/** Where each subagent's own MCP tools are installed while it runs. */
	registry: Registry;
	subagents: ReadonlyMap<string, SubagentConfig>;
	servers: ReadonlyMap<string, ServerConfig>;
	tokens: TokenStore;
}) => {
	// A worker's servers one by one: one that cannot be reached is left out
	// rather than failing the whole run.
	const connectWorkerServers = async (): Promise<Connection[]> => {
		const settled = await Promise.allSettled(
			[...workerPolicy].map(([server, allowed]) =>
				connectServers(new Map([[server, allowed]]), servers, tokens),
			),
		);
		return settled.flatMap((result, index) => {
			if (result.status === "fulfilled") return [result.value];
			console.error(
				`MCP ${[...workerPolicy.keys()][index]}: not connected for a worker:`,
				result.reason,
			);
			return [];
		});
	};

	const agentConfig = (name: string) => {
		if (name === "general") return general();
		const specialist = subagents.get(name);
		if (!specialist) throw new Error(`No subagent "${name}"`);
		return specialist;
	};

	// What the root's tasks of `task` did, for the log; a nested job's are left
	// out, its parent's task covers them.
	const logged = async (
		task: { id: TaskId; input: JobInput },
		runtime: TaskRuntime<JobInput, JobState, string | null, object>,
		outcomes: readonly Omit<Job, "id" | "intent" | "agent" | "model">[],
		context: Context,
		models: readonly (string | null)[] | undefined = task.input.models,
	): Promise<void> => {
		if (runtime.conversationId !== ROOT_CONVERSATION_ID) return;
		const { agent, intents } = task.input;
		await runtime.commit(async (tx) => {
			logJobs(
				await tx.doc(Log, runtime.conversationId),
				outcomes.map((outcome, index) => ({
					id: `${task.id}:${index}`,
					intent: intents?.[index] ?? "",
					agent,
					model: models?.[index] ?? "default",
					...outcome,
				})),
			);
			return undefined;
		}, context);
	};
	// The root hears a job's answers with those of the rest of its batch, once
	// the last of them answers; a retried phase reports once (the request id),
	// and not at all once its batch is gone.
	const reportToRoot = async (
		task: { id: TaskId; input: JobInput },
		runtime: TaskRuntime<JobInput, JobState, string | null, object>,
		part: Part,
		context: Context,
	): Promise<void> => {
		const { batch } = task.input;
		let parts: Part[] | undefined = batch === undefined ? [part] : undefined;
		let reported: string[] = [];
		if (batch !== undefined) {
			// A task's commit returns its next state; the parts come out aside.
			await runtime.commit(async (tx) => {
				const { batches } = await tx.doc(Batches, runtime.conversationId);
				const jobs = batches[batch];
				if (jobs === undefined) return undefined;
				// A retried phase or an abort keeps the answers already given.
				jobs[task.id] ??= part;
				const all = Object.values(jobs);
				if (all.every((job) => job !== null)) {
					parts = JSON.parse(JSON.stringify(all)) as Part[];
					reported = Object.keys(jobs);
				}
				return undefined;
			}, context);
		}
		if (parts === undefined) return;
		const agent = await runtime.conversation(runtime.conversationId, context);
		await agent?.submit(
			{
				type: "input",
				content: rootReport(parts),
				whenBusy: "followUp",
				requestId:
					batch === undefined
						? `subagent:${task.id}`
						: `subagent:${batch}:${task.id}`,
			},
			context,
		);
		if (batch !== undefined) {
			// A job started in the turn meanwhile stays, to report on its own.
			await runtime.commit(async (tx) => {
				const { batches } = await tx.doc(Batches, runtime.conversationId);
				const jobs = batches[batch];
				if (jobs === undefined) return undefined;
				for (const id of reported) delete jobs[id];
				if (Object.keys(jobs).length === 0) delete batches[batch];
				return undefined;
			}, context);
		}
	};

	// A job that cannot run answers every task with its failure, so that its
	// batch still reports.
	const fail = async (
		task: { id: TaskId; input: JobInput },
		runtime: TaskRuntime<JobInput, JobState, string | null, object>,
		error: unknown,
		context: Context,
	): Promise<void> => {
		if (runtime.signal.aborted) throw error;
		const { agent, tasks, intents } = task.input;
		const answers = tasks.map(() => `(failed: ${errorMessage(error)})`);
		const isRoot = runtime.conversationId === ROOT_CONVERSATION_ID;
		await logged(
			task,
			runtime,
			tasks.map(() => ({
				at: Date.now(),
				status: "failed",
				cost: 0,
				seconds: 0,
				tools: [],
			})),
			context,
		);
		if (isRoot)
			await reportToRoot(
				task,
				runtime,
				{ agent, tasks, answers, intents },
				context,
			);
		await runtime.commit(
			() => completed(report(agent, tasks, answers, isRoot)),
			context,
		);
	};

	// The root's general tasks go through the dispatcher, when there is one; a
	// failure leaves them as the agent wrote them.
	const dispatchedFor = async (
		task: { input: JobInput },
		runtime: TaskRuntime<JobInput, JobState, string | null, object>,
		context: Context,
	): Promise<Dispatched[] | undefined> => {
		if (
			task.input.agent !== "general" ||
			runtime.conversationId !== ROOT_CONVERSATION_ID
		) {
			return undefined;
		}
		try {
			// Imported late: the harness itself is built from these extensions.
			const { root } = await import("../agent/harness.ts");
			const dispatched = await dispatch(
				task.input.tasks.map((text, index) => ({
					intent: task.input.intents?.[index] ?? "",
					task: text,
					model: task.input.models?.[index] ?? null,
				})),
				root,
				runtime,
				context,
			);
			// An abort is no failure of the dispatcher: the phase stops, and runs
			// again with it, rather than commit the tasks unbriefed.
			runtime.signal.throwIfAborted();
			return dispatched;
		} catch (error) {
			if (runtime.signal.aborted) throw error;
			console.error("The dispatcher failed; the tasks run as asked:", error);
			return undefined;
		}
	};

	const JobTask = defineTask<JobInput, JobState, string | null>({
		name: "subagent.job",
		version: 1,

		initial: () => ({ phase: "start" }),

		phases: {
			start: async (task, runtime, context) => {
				let subagent: ReturnType<typeof agentConfig>;
				try {
					subagent = agentConfig(task.input.agent);
				} catch (error) {
					await fail(task, runtime, error, context);
					return;
				}

				const dispatched = await dispatchedFor(task, runtime, context);
				// A task the dispatcher left out keeps the agent's pick.
				const dispatchedPicks = dispatched?.map((answer, index) =>
					answer ? answer.model : (task.input.models?.[index] ?? null),
				);
				const picks = dispatchedPicks ?? task.input.models;
				await runtime.commit(async (tx) => {
					const conversations: ConversationId[] = [];
					for (const [index] of task.input.tasks.entries()) {
						const { id } = await tx.createConversation({
							ownership: { kind: "task", taskId: task.id },
						});
						// One provider session for every subagent of a kind: their
						// prompts are alike, so they share the provider's cache.
						(await tx.doc(ProviderDoc, id)).sessionId =
							`subagent:${task.input.agent}`;
						await configure(tx, id, {
							...modelSettings(
								task.input.agent === "general"
									? general(picks?.[index]).model
									: subagent.model,
							),
							instructions: subagent.prompt,
							tools: null,
							extensions:
								task.input.agent === "general"
									? generalExtensions(registry)
									: [PromptFirstExtension],
						});
						conversations.push(id);
					}
					return {
						status: "running",
						checkpoint: {
							phase: "run",
							conversations,
							...(dispatched &&
								dispatchedPicks && {
									briefs: dispatched.map((answer) => answer?.brief ?? null),
									models: dispatchedPicks,
								}),
						},
					};
				}, context);
			},

			run: async (task, runtime, context) => {
				let subagent: ReturnType<typeof agentConfig>;
				try {
					subagent = agentConfig(task.input.agent);
				} catch (error) {
					await fail(task, runtime, error, context);
					return;
				}
				const specialist = subagents.get(task.input.agent);
				const { conversations, briefs } = task.state.checkpoint;
				const picks = task.state.checkpoint.models ?? task.input.models;

				// Every run opens its own connections, and a restart reconnects them.
				const answer = async (
					conversation: ConversationId,
					index: number,
				): Promise<{ text: string; cost: number; tools: string[] }> => {
					const asked = task.input.tasks[index] ?? "";
					const brief = briefs?.[index];
					// The agent's own words go along, so nothing it knew is lost.
					const prompt = brief
						? `${brief}\n\nThe task as the agent asked for it:\n<request>\n${asked}\n</request>`
						: asked;
					const connections: Connection[] = [];
					const run = { name: `${RUN_EXTENSION}${conversation}` };
					// The MCP tools its scripts call, for the log.
					const used = new Set<string>();
					const failed = (reason: string) => ({
						text: `(failed: ${reason})`,
						cost: 0,
						tools: [...used],
					});
					try {
						if (specialist) {
							connections.push(
								await connectServers(specialist.policy, servers, tokens),
							);
							if (specialist.lightpanda) {
								connections.push(await connectLightpanda());
							}
						} else {
							connections.push(...(await connectWorkerServers()));
						}
						const tools = connections.flatMap(({ tools }) =>
							tools.map((tool) => ({
								...tool,
								execute: (...args: Parameters<typeof tool.execute>) => {
									used.add(tool.name);
									return tool.execute(...args);
								},
							})),
						);
						const extension = specialist
							? defineExtension({
									...run,
									tools: tools.length > 0 ? [createCodemodeTool(tools)] : [],
								})
							: createGeneralRunExtension(conversation, [
									...localTools,
									...tools,
								]);
						registry.install(extension);
						await runtime.commit(async (tx) => {
							await configure(tx, conversation, {
								...(specialist
									? {}
									: {
											...modelSettings(general(picks?.[index]).model),
											instructions: subagent.prompt,
										}),
								extensions: [
									...(specialist
										? [PromptFirstExtension]
										: generalExtensions(registry)),
									extension,
								],
							});
						}, context);

						const handle = await runtime.conversation(conversation, context);
						if (!handle) throw new Error("Its conversation is gone");
						const settled = await (
							await handle.submit(
								{
									type: "input",
									content: prompt,
									requestId: `subagent:${conversation}`,
								},
								context,
							)
						).wait(context);
						if (settled.status !== "done") return failed(settled.reason);

						const { messages } = await runtime.context(conversation, context);
						const last = messages.at(-1);
						return {
							text: (last?.role === "assistant" && answerText(last)) || "",
							cost: messages.reduce(
								(sum, message) =>
									sum +
									(message.role === "assistant"
										? (message.usage?.cost?.total ?? 0)
										: 0),
								0,
							),
							tools: [...used],
						};
					} catch (error) {
						if (runtime.signal.aborted) throw error;
						return failed(errorMessage(error));
					} finally {
						registry.uninstall(run);
						await Promise.allSettled(connections.map(({ close }) => close()));
					}
				};

				const started = Date.now();
				const outcomes = await Promise.all(
					conversations.map(async (conversation, index) => {
						const outcome = await answer(conversation, index);
						return { ...outcome, seconds: (Date.now() - started) / 1000 };
					}),
				);
				const answers = outcomes.map(({ text }) => text);
				await logged(
					task,
					runtime,
					outcomes.map(({ text, cost, tools, seconds }) => ({
						at: Date.now(),
						status: statusOf(text),
						cost,
						seconds: Math.round(seconds),
						tools,
					})),
					context,
					picks,
				);

				const isRoot = runtime.conversationId === ROOT_CONVERSATION_ID;
				const result = report(
					task.input.agent,
					task.input.tasks,
					answers,
					isRoot,
				);
				if (isRoot) {
					await reportToRoot(
						task,
						runtime,
						{
							agent: task.input.agent,
							tasks: task.input.tasks,
							answers,
							intents: task.input.intents,
						},
						context,
					);
				}
				// Nested callers receive the report as their tool result, before their
				// next generation, not as a follow-up after they have already yielded.
				await runtime.commit(() => completed(result), context);
			},
		},

		abort: async (task, runtime, context) => {
			// Its batch must not wait for it forever; a job of its own just stops.
			if (
				runtime.conversationId === ROOT_CONVERSATION_ID &&
				task.input.batch !== undefined
			) {
				const { agent, tasks, intents } = task.input;
				const answers = tasks.map(() => "(stopped before answering)");
				await reportToRoot(
					task,
					runtime,
					{ agent, tasks, answers, intents },
					context,
				);
			}
			await runtime.commit(() => aborted, context);
		},
	});

	const names = ["general", ...subagents.keys()];
	const choices = [...workerModels.keys()];

	const subagentTool = defineTool({
		name: "subagent",
		replay: "safe",
		description:
			"Start subagents in the background, one per task, all at once: put " +
			"every task for them in one call. Their answers come to you by " +
			"themselves, together in one later message, once every one is done; " +
			"don't wait, check or schedule anything for them, and don't do their " +
			"tasks yourself meanwhile. When called by a subagent, this tool waits " +
			"for nested work so it can finish before reporting to its parent. A subagent knows " +
			"nothing of this conversation, so write each task to stand on its " +
			"own. Label each task with its intent, the kind of task it is " +
			"(e.g. calendar.read, mail.draft), the same label for the same kind: " +
			`after two failures of one intent within ${RETRY_HOURS} hours the ` +
			"harness does not run a third, and you take another way (ask the " +
			"user, or let it go). The subagents:\n" +
			`- general: ${GENERAL_DESCRIPTION}\n` +
			[...subagents]
				.map(([name, { description }]) => `- ${name}: ${description}`)
				.join("\n") +
			(choices.length > 0
				? "\nA general task may pick its worker's model (model); without " +
					"one it runs on the default. Your retro shows how each did on " +
					"which intent. The models:\n" +
					[...workerModels]
						.map(([name, { description }]) => `- ${name}: ${description}`)
						.join("\n")
				: ""),
		parameters: Type.Object({
			agent: Type.Union(names.map((name) => Type.Literal(name))),
			tasks: Type.Array(
				Type.Object({
					intent: Type.String({
						description: "The kind of task, e.g. calendar.read.",
					}),
					task: Type.String({ description: "The task, standing on its own." }),
					...(choices.length > 0 && {
						model: Type.Optional(
							Type.Union(
								choices.map((name) => Type.Literal(name)),
								{ description: "A general task's worker model." },
							),
						),
					}),
				}),
				{
					minItems: 1,
					maxItems: MAX_TASKS,
					description: "One subagent each.",
				},
			),
		}),
		execute: async (args, api, context: Context) => {
			const isRoot = api.conversationId === ROOT_CONVERSATION_ID;
			// The root's tasks of an intent that keeps failing do not start.
			const log = isRoot
				? await api.snapshot(Log, api.conversationId, context)
				: undefined;
			const now = Date.now();
			const refused: string[] = [];
			const tasks = args.tasks.filter(({ intent }) => {
				const failures = tooManyFailures(log?.jobs ?? [], intent, now);
				if (failures === undefined) return true;
				refused.push(
					`Not started: "${intent}" failed ${failures.length} times in the last ${RETRY_HOURS} hours (${failures.map(formatTime).join(", ")}); take another way: ask the user, or let it go.`,
				);
				return false;
			});
			if (tasks.length === 0) {
				return { content: [{ type: "text", text: refused.join("\n") }] };
			}
			const batch = isRoot ? await turnOf(api, context) : undefined;
			const job = await api.commit(async (tx) => {
				const call = await tx.doc(CallDoc, api.taskId);
				if (call.job !== null) return call.job;
				call.job = await tx.createTask(
					JobTask,
					{
						agent: args.agent,
						tasks: tasks.map(({ task }) => task),
						intents: tasks.map(({ intent }) => intentOf(intent)),
						models: tasks.map(
							(task) =>
								("model" in task && typeof task.model === "string"
									? task.model
									: null) ?? null,
						),
						...(batch && { batch }),
					},
					{
						conversationId: api.conversationId,
						ownership: { kind: "conversation" },
						background: true,
					},
				);
				if (batch !== undefined) {
					const { batches } = await tx.doc(Batches, api.conversationId);
					batches[batch] = { ...batches[batch], [call.job]: null };
				}
				return call.job;
			}, context);
			// A child must not report a delegation acknowledgement as its final
			// answer and disappear while its own background jobs are still live.
			if (!isRoot) {
				const settled = await api.waitForTask(job, context);
				return {
					content: [
						{
							type: "text",
							text:
								settled.state.outcome.status === "completed"
									? (settled.state.outcome.result ??
										"Nested subagents completed without an answer.")
									: `Nested subagents did not complete: ${settled.state.outcome.status}.`,
						},
					],
					isError: settled.state.outcome.status !== "completed",
				};
			}
			return {
				content: [
					{
						type: "text",
						text: [
							`Started ${tasks.length} "${args.agent}" subagent(s) in ` +
								"the background. Their answers will come to you by themselves; " +
								"end your turn: after a message from the user, tell them briefly " +
								"they are on it; after a scheduled prompt, answer NO_REPLY.",
							...refused,
						].join("\n"),
					},
				],
			};
		},
	});

	return defineExtension({
		name: "subagent",
		tools: [subagentTool],
		tasks: [JobTask],
	});
};
