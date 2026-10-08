import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	type Registry,
	ROOT_CONVERSATION_ID,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";

import { PromptFirstExtension } from "../agent/prompt-first.ts";
import type { Model } from "../config.ts";
import { connectLightpanda } from "../lightpanda/connect.ts";
import { type Connection, connectServers } from "../mcp/client.ts";
import { createCodemodeTool } from "../mcp/codemode.ts";
import type { ServerConfig } from "../mcp/config.ts";
import type { TokenStore } from "../mcp/oauth.ts";
import type { SubagentConfig } from "./config.ts";

// The agent hands tasks to subagents with one tool, `subagent`, and carries
// on: a background task, owned by the agent's conversation but outside its
// runs, gives each task a conversation of its own and runs them all at once.
// Once every one has answered, it hands the answers back to the agent as one
// input. Every task is standalone, without its parent's transcript. General
// shares the root's model, instructions and tools, including delegation;
// specialists keep their configured prompt and isolated tool connections.
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
	"Same model, instructions and tools as you, in an isolated context. Use for " +
	"expensive spreadsheet work and other substantial standalone tasks. Pass the " +
	"source fileId and all requirements; have it open a separate workbook copy " +
	"or clone before editing, and return the exported fileId in its text answer, " +
	"never file bytes. File and workbook handles are volatile: after a process " +
	"restart an old handle may be unavailable; report that failure, do not invent " +
	"a replacement.";

/** Whether `extension` belongs to one subagent's conversation only. */
export const isSubagentRun = (extension: Extension): boolean =>
	extension.name.startsWith(RUN_EXTENSION);

/** Installed again before resuming an interrupted general conversation. */
export const createGeneralRunExtension = (conversation: ConversationId) =>
	defineExtension({
		name: `${RUN_EXTENSION}${conversation}`,
		sections: [
			section(
				"subagent-context",
				() =>
					"You are a general subagent working on a standalone task. " +
					"You have the root assistant's tools, but not its transcript " +
					"or long-term memory: memory tools are root-only. Return " +
					"a substantive text answer to your parent, not a user-facing " +
					"acknowledgement, reaction or NO_REPLY. If you delegate, " +
					"the subagent tool waits for that work before returning; " +
					"use its answers to finish your own task. Workbook and " +
					"file handles may not survive a process restart; report " +
					"missing sources explicitly. Return exported fileIds as " +
					"text, never bytes.",
			),
		],
	});

type JobInput = {
	agent: string;
	tasks: string[];
};

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
				? "The user has not seen their answers: reply to the user with what they asked for, from these answers."
				: "Use these answers to finish your standalone task and report back to your parent."),
		...tasks.map(
			(task, index) =>
				`<task>\n${task}\n</task>\n<answer>\n${answers[index]}\n</answer>`,
		),
	].join("\n\n");

export const createSubagentExtension = ({
	registry,
	subagents,
	servers,
	tokens,
	general,
}: {
	/** Where each subagent's own MCP tools are installed while it runs. */
	registry: Registry;
	subagents: ReadonlyMap<string, SubagentConfig>;
	servers: ReadonlyMap<string, ServerConfig>;
	tokens: TokenStore;
	/** The root deployment, without importing the harness back into its registry. */
	general: () => { model: Model; prompt: string };
}) => {
	const agentConfig = (name: string) => {
		if (name === "general") return general();
		const specialist = subagents.get(name);
		if (!specialist) throw new Error(`No subagent "${name}"`);
		return specialist;
	};
	const rootExtensions = () =>
		registry
			.snapshot()
			.installed()
			.filter((extension) => !isSubagentRun(extension));

	const JobTask = defineTask<JobInput, JobState, string | null>({
		name: "subagent.job",
		version: 1,

		initial: () => ({ phase: "start" }),

		phases: {
			start: async (task, runtime, context) => {
				const subagent = agentConfig(task.input.agent);
				const { model } = subagent;

				await runtime.commit(async (tx) => {
					const conversations: ConversationId[] = [];
					for (const _ of task.input.tasks) {
						const { id } = await tx.createConversation({
							ownership: { kind: "task", taskId: task.id },
						});
						await configure(tx, id, {
							model: { provider: model.provider, modelId: model.modelId },
							thinkingLevel: model.thinkingLevel ?? null,
							instructions: subagent.prompt,
							tools: null,
							extensions:
								task.input.agent === "general"
									? rootExtensions()
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
				const subagent = agentConfig(task.input.agent);
				const specialist = subagents.get(task.input.agent);

				// General reuses the root's installed catalogue, including local tools;
				// specialists reconnect their private servers after a restart.
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
						}
						const tools = connections.flatMap(({ tools }) => tools);
						const extension = specialist
							? defineExtension({
									...run,
									tools: tools.length > 0 ? [createCodemodeTool(tools)] : [],
								})
							: createGeneralRunExtension(conversation);
						registry.install(extension);
						await runtime.commit(async (tx) => {
							await configure(tx, conversation, {
								...(specialist
									? {}
									: {
											model: {
												provider: subagent.model.provider,
												modelId: subagent.model.modelId,
											},
											thinkingLevel: subagent.model.thinkingLevel ?? null,
											instructions: subagent.prompt,
										}),
								extensions: [
									...(specialist ? [PromptFirstExtension] : rootExtensions()),
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
					const agent = await runtime.conversation(
						runtime.conversationId,
						context,
					);
					// The request id keeps a run retried after a crash from reporting twice.
					await agent?.submit(
						{
							type: "input",
							content: result,
							whenBusy: "followUp",
							requestId: `subagent:${task.id}`,
						},
						context,
					);
				}
				// Nested callers receive the report as their tool result, before their
				// next generation, not as a follow-up after they have already yielded.
				await runtime.commit(() => completed(result), context);
			},
		},

		abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
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
			const job = await api.commit(async (tx) => {
				const call = await tx.doc(CallDoc, api.taskId);
				if (call.job !== null) return call.job;
				call.job = await tx.createTask(
					JobTask,
					{ agent: args.agent, tasks: args.tasks },
					{
						conversationId: api.conversationId,
						ownership: { kind: "conversation" },
						background: true,
					},
				);
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
							"tell the user they are on it and end your turn.",
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
