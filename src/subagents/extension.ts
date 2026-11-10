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
import { general, type SubagentConfig } from "./config.ts";

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

// A worker brings its own codemode, and the scratchpad is the agent's own.
const NOT_FOR_WORKERS = new Set(["codemode", "scratchpad"]);

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
	/** The root's turn that started it: its jobs report to the root together. */
	batch?: string;
};

type Part = { agent: string; tasks: string[]; answers: string[] };

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
	| { phase: "run"; conversations: ConversationId[] };

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
		...parts.flatMap(({ agent, tasks, answers }) =>
			tasks.map(
				(task, index) =>
					`<task agent="${agent}">\n${task}\n</task>\n<answer>\n${answers[index]}\n</answer>`,
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
		const { agent, tasks } = task.input;
		const answers = tasks.map(() => `(failed: ${errorMessage(error)})`);
		const isRoot = runtime.conversationId === ROOT_CONVERSATION_ID;
		if (isRoot)
			await reportToRoot(task, runtime, { agent, tasks, answers }, context);
		await runtime.commit(
			() => completed(report(agent, tasks, answers, isRoot)),
			context,
		);
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

				await runtime.commit(async (tx) => {
					const conversations: ConversationId[] = [];
					for (const _ of task.input.tasks) {
						const { id } = await tx.createConversation({
							ownership: { kind: "task", taskId: task.id },
						});
						await configure(tx, id, {
							...modelSettings(subagent.model),
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
						checkpoint: { phase: "run", conversations },
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

				// Every run opens its own connections, and a restart reconnects them.
				const answer = async (
					conversation: ConversationId,
					prompt: string,
				): Promise<string> => {
					const connections: Connection[] = [];
					const run = { name: `${RUN_EXTENSION}${conversation}` };
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
						const tools = connections.flatMap(({ tools }) => tools);
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
											...modelSettings(subagent.model),
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
						if (settled.status !== "done") {
							return `(failed: ${settled.reason})`;
						}

						const { messages } = await runtime.context(conversation, context);
						const last = messages.at(-1);
						return (last?.role === "assistant" && answerText(last)) || "";
					} catch (error) {
						if (runtime.signal.aborted) throw error;
						return `(failed: ${errorMessage(error)})`;
					} finally {
						registry.uninstall(run);
						await Promise.allSettled(connections.map(({ close }) => close()));
					}
				};

				const { conversations } = task.state.checkpoint;
				const answers = await Promise.all(
					conversations.map((conversation, index) =>
						answer(conversation, task.input.tasks[index] ?? ""),
					),
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
						{ agent: task.input.agent, tasks: task.input.tasks, answers },
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
				const { agent, tasks } = task.input;
				const answers = tasks.map(() => "(stopped before answering)");
				await reportToRoot(task, runtime, { agent, tasks, answers }, context);
			}
			await runtime.commit(() => aborted, context);
		},
	});

	const names = ["general", ...subagents.keys()];

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
			"own. The subagents:\n" +
			`- general: ${GENERAL_DESCRIPTION}\n` +
			[...subagents]
				.map(([name, { description }]) => `- ${name}: ${description}`)
				.join("\n"),
		parameters: Type.Object({
			agent: Type.Union(names.map((name) => Type.Literal(name))),
			tasks: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: MAX_TASKS,
				description: "One subagent each.",
			}),
		}),
		execute: async (args, api, context: Context) => {
			const batch =
				api.conversationId === ROOT_CONVERSATION_ID
					? await turnOf(api, context)
					: undefined;
			const job = await api.commit(async (tx) => {
				const call = await tx.doc(CallDoc, api.taskId);
				if (call.job !== null) return call.job;
				call.job = await tx.createTask(
					JobTask,
					{ agent: args.agent, tasks: args.tasks, ...(batch && { batch }) },
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
			if (api.conversationId !== ROOT_CONVERSATION_ID) {
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
						text:
							`Started ${args.tasks.length} "${args.agent}" subagent(s) in ` +
							"the background. Their answers will come to you by themselves; " +
							"end your turn: after a message from the user, tell them briefly " +
							"they are on it; after a scheduled prompt, answer NO_REPLY.",
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
