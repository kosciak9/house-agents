// A model that does what the test tells it to, so tests of the harness's own
// logic (tools, working copies, schedules, subagents, delivery) neither wait
// for nor depend on a real model's judgement. A message whose first line is
// `script: [...]` (see `script`) holds the steps of the turns that answer it:
// each answer is the next step, a tool call or a final text, until the steps
// run out and the model answers NO_REPLY. Later messages that are no script,
// e.g. a subagent's report, continue the last script. Scheduled prompts and
// subagent tasks may be scripts too.
import {
	type AssistantMessage,
	createFauxCore,
	createProvider,
	fauxAssistantMessage,
	fauxToolCall,
	type JsonObject,
	type Message,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import type { Model } from "../src/index.ts";

export const SCRIPTED_MODEL: Model = { provider: "e2e", modelId: "scripted" };

// In a final text, `{{result}}` stands for the text of the last tool result
// and `{{match:<regex>}}` for the newest match of the regex in the
// conversation; so does a tool argument that is one of them alone, while
// arguments that only contain one, e.g. a subagent's script, stay as they are.
type Step = { call: string; args: JsonObject } | { say: string };

export const call = (tool: string, args: JsonObject): Step => ({
	call: tool,
	args,
});

/** A `codemode` call running `code`. */
export const codemode = (code: string): Step => call("codemode", { code });

export const say = (text: string): Step => ({ say: text });

/** The message that makes the scripted model take `steps`. */
export const script = (...steps: Step[]): string =>
	`script: ${JSON.stringify(steps)}`;

const SCRIPT_LINE = /^script: (.+)$/;

const textOf = (message: Message): string => {
	if (message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
};

// The script of a user message, past the wrapper of a scheduled prompt.
const scriptOf = (message: Message): Step[] | undefined => {
	if (message.role !== "user") return undefined;
	const lines = textOf(message).split("\n");
	const line = lines[0] === "<scheduled>" ? lines[1] : lines[0];
	const match = SCRIPT_LINE.exec(line ?? "");
	return match ? JSON.parse(match[1] as string) : undefined;
};

const PLACEHOLDER = /\{\{(result|match:(.+?))\}\}/g;

const fill = (text: string, messages: readonly Message[]): string =>
	text.replace(PLACEHOLDER, (_, field, pattern) => {
		const newestFirst = [...messages].reverse();
		if (field === "result") {
			const result = newestFirst.find(
				(message) => message.role === "toolResult",
			);
			return result ? textOf(result) : "";
		}
		const regex = new RegExp(pattern);
		for (const message of newestFirst) {
			const found = regex.exec(textOf(message));
			if (found) return found[0];
		}
		return "";
	});

const answer = ({ messages }: TranscriptContext): AssistantMessage => {
	const start = messages.findLastIndex(
		(message) => scriptOf(message) !== undefined,
	);
	const steps = start < 0 ? [] : (scriptOf(messages[start] as Message) ?? []);
	const taken = messages
		.slice(start + 1)
		.filter((message) => message.role === "assistant").length;
	const step = steps[taken];
	if (!step) return fauxAssistantMessage("NO_REPLY");
	if ("say" in step) return fauxAssistantMessage(fill(step.say, messages));
	const args = Object.fromEntries(
		Object.entries(step.args).map(([name, value]) => [
			name,
			typeof value === "string" && /^\{\{.+\}\}$/.test(value)
				? fill(value, messages)
				: value,
		]),
	);
	return fauxAssistantMessage(fauxToolCall(step.call, args), {
		stopReason: "toolUse",
	});
};

const options = {
	api: "e2e-scripted",
	provider: SCRIPTED_MODEL.provider,
	models: [{ id: SCRIPTED_MODEL.modelId }],
};

/** The scripted model's provider, for the agent's `config.providers`. */
export const scriptedProvider = (): Provider => {
	// One core per request: it streams the one answer it is given.
	const stream = (
		model: Parameters<ReturnType<typeof createFauxCore>["stream"]>[0],
		context: TranscriptContext,
		streamOptions?: SimpleStreamOptions,
	) => {
		const core = createFauxCore(options);
		core.setResponses([answer(context)]);
		return core.stream(model, context, streamOptions);
	};
	return createProvider({
		id: SCRIPTED_MODEL.provider,
		name: "E2E scripted model",
		auth: { apiKey: { name: "None", resolve: async () => ({ auth: {} }) } },
		models: createFauxCore(options).models,
		api: { stream, streamSimple: stream },
	});
};
