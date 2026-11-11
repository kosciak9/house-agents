import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	isContextOverflow,
	type Model as ModelSpec,
	type Models,
	type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { Model } from "../config.ts";

/** The agent turned to its fallback model, or back to its own. */
export type ModelSwitch =
	| { to: "fallback"; model: Model; fallback: Model; error: string }
	| { to: "model"; model: Model; fallback: Model };

const listeners = new Set<(change: ModelSwitch) => void>();

/** Hears every switch between the model and its fallback. */
export const onModelSwitch = (
	listener: (change: ModelSwitch) => void,
): void => {
	listeners.add(listener);
};

const emit = (change: ModelSwitch): void => {
	for (const listener of listeners) listener(change);
};

const isModel = (spec: ModelSpec<Api>, model: Model): boolean =>
	spec.provider === model.provider && spec.id === model.modelId;

// A context overflow is no fault of the model: the memory compacts the
// conversation instead.
const failed = (message: AssistantMessage, spec: ModelSpec<Api>): boolean =>
	message.stopReason === "error" &&
	!isContextOverflow(message, spec.contextWindow);

/**
 * `models` where every request that fails is made again on `fallback`, in the
 * same call: the agent, its subagents and its memory all get the fallback's
 * answer instead of the error, whatever model they run on. Only the agent's
 * own `model` turning to the fallback and back is announced. The next request
 * tries its model first again.
 */
export const withFallback = (
	models: Models,
	model: Model,
	fallback: Model,
): Models => {
	const fallbackSpec = models.getModel(fallback.provider, fallback.modelId);
	if (!fallbackSpec) {
		throw new Error(
			`config.fallbackModel ${fallback.provider}/${fallback.modelId} is unknown`,
		);
	}
	let onFallback = false;

	const streamSimple = (
		spec: ModelSpec<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): AssistantMessageEventStream => {
		const first = models.streamSimple(spec, context, options);
		if (isModel(spec, fallback)) return first;
		const own = isModel(spec, model);

		const stream = createAssistantMessageEventStream();
		void (async () => {
			for await (const event of first) {
				if (event.type !== "error" || !failed(event.error, spec)) {
					stream.push(event);
					if (event.type === "done" && own && onFallback) {
						onFallback = false;
						emit({ to: "model", model, fallback });
					}
					continue;
				}
				if (options?.signal?.aborted) {
					stream.push(event);
					return;
				}
				const error = event.error.errorMessage ?? "error";
				console.error(
					`Model ${spec.provider}/${spec.id} failed (${error}); ` +
						`asking ${fallback.provider}/${fallback.modelId}`,
				);
				if (own && !onFallback) {
					onFallback = true;
					emit({ to: "fallback", model, fallback, error });
				}
				const { reasoning: _reasoning, ...rest } = options ?? {};
				const thinking = fallback.thinkingLevel ?? "off";
				for await (const retried of models.streamSimple(
					fallbackSpec,
					context,
					thinking === "off" ? rest : { ...rest, reasoning: thinking },
				)) {
					stream.push(retried);
				}
				return;
			}
		})();
		return stream;
	};

	return new Proxy(models, {
		get(target, property) {
			if (property === "streamSimple") return streamSimple;
			if (property === "completeSimple") {
				return (
					spec: ModelSpec<Api>,
					context: Context,
					options?: ModelsSimpleStreamOptions,
				) => streamSimple(spec, context, options).result();
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
