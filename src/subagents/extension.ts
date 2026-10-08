import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	type Registry,
} from "@earendil-works/pi-durable";

import { PromptFirstExtension } from "../agent/prompt-first.ts";
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
// input. A subagent knows only its own prompt and task: no memory, schedules
// or subagents of its own.
//
// It gets the MCP tools its policy allows, and Lightpanda if it has it, on
// connections of its own: opened when it starts and closed once it has
// answered, so each subagent gets a browser of its own. They come in an
// extension of that one conversation, which the agent's default selection
// leaves out.

const RUN_EXTENSION = "subagent-run:";

const MAX_TASKS = 10;

/** Whether `extension` belongs to one subagent's conversation only. */
export const isSubagentRun = (extension: Extension): boolean =>
	extension.name.startsWith(RUN_EXTENSION);

type JobInput = {
	agent: string;
	tasks: string[];
};

type JobState =
	| { phase: "start" }
	| { phase: "run"; conversations: ConversationId[] };

const completed = {
	status: "terminal",
	outcome: { status: "completed", result: null },
} as const;

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

const report = (agent: string, tasks: string[], answers: string[]): string =>
	[
		`Every "${agent}" subagent you started has answered; they are done ` +
			"and gone. The user has not seen their answers: reply to the user " +
			"with what they asked for, from these answers.",
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
}: {
	/** Where each subagent's own MCP tools are installed while it runs. */
	registry: Registry;
	subagents: ReadonlyMap<string, SubagentConfig>;
	servers: ReadonlyMap<string, ServerConfig>;
	tokens: TokenStore;
}) => {
	const JobTask = defineTask<JobInput, JobState, null>({
		name: "subagent.job",
		version: 1,

		initial: () => ({ phase: "start" }),

		phases: {
			start: async (task, runtime, context) => {
				const subagent = subagents.get(task.input.agent);
				if (!subagent) throw new Error(`No subagent "${task.input.agent}"`);
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
							extensions: [PromptFirstExtension],
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
				const subagent = subagents.get(task.input.agent);
				if (!subagent) throw new Error(`No subagent "${task.input.agent}"`);

				// After a restart a subagent goes on where it was, on servers
				// connected anew.
				const answer = async (
					conversation: ConversationId,
					prompt: string,
				): Promise<string> => {
					const connections: Connection[] = [];
					const run = { name: `${RUN_EXTENSION}${conversation}` };
					try {
						connections.push(
							await connectServers(subagent.policy, servers, tokens),
						);
						if (subagent.lightpanda) {
							connections.push(await connectLightpanda());
						}
						const tools = connections.flatMap(({ tools }) => tools);
						const extension = defineExtension({
							...run,
							tools: tools.length > 0 ? [createCodemodeTool(tools)] : [],
						});
						registry.install(extension);
						await runtime.commit(async (tx) => {
							await configure(tx, conversation, {
								extensions: [PromptFirstExtension, extension],
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

				const agent = await runtime.conversation(
					runtime.conversationId,
					context,
				);
				// The request id keeps a run retried after a crash from
				// reporting twice.
				await agent?.submit(
					{
						type: "input",
						content: report(task.input.agent, task.input.tasks, answers),
						whenBusy: "followUp",
						requestId: `subagent:${task.id}`,
					},
					context,
				);
				await runtime.commit(() => completed, context);
			},
		},

		abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
	});

	const names = [...subagents.keys()];

	const subagentTool = defineTool({
		name: "subagent",
		description:
			"Start subagents in the background, one per task, all at once: put " +
			"every task for them in one call. Their answers come to you by " +
			"themselves, together in one later message, once every one is done; " +
			"don't wait, check or schedule anything for them, and don't do their " +
			"tasks yourself meanwhile. A subagent has tools of its own and knows " +
			"nothing of this conversation, so write each task to stand on its " +
			"own. The subagents:\n" +
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
			await api.createTask(
				JobTask,
				{ agent: args.agent, tasks: args.tasks },
				{ ownership: { kind: "conversation" }, background: true },
				context,
			);
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
