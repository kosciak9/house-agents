import { models } from "../agent/models.ts";
import { config, type Model } from "../config.ts";
import { type Policy, parsePolicy } from "../mcp/config.ts";

// The subagents come from the deployment's `subagents`, checked here like
// its MCP servers.

export type SubagentConfig = {
	description: string;
	prompt: string;
	model: Model;
	/** The MCP tools it may use. */
	policy: Policy;
	/** Whether it gets a Lightpanda browser of its own. */
	lightpanda: boolean;
};

const requiredString = (value: unknown, field: string): string => {
	if (typeof value !== "string" || !value) {
		throw new Error(`${field} is required`);
	}
	return value;
};

const parseSubagent = (name: string, value: unknown): SubagentConfig => {
	const field = `config.subagents.${name}`;
	if (name === "general") {
		throw new Error(`${field} is reserved for the built-in general subagent`);
	}
	if (typeof value !== "object" || value === null) {
		throw new Error(`${field} must be an object`);
	}
	const subagent = value as Record<string, unknown>;

	const model = (subagent.model as Model | undefined) ?? config().model;
	if (!models.getModel(model.provider, model.modelId)) {
		throw new Error(
			`${field}.model ${model.provider}/${model.modelId} is unknown`,
		);
	}

	const lightpanda = subagent.lightpanda ?? false;
	if (typeof lightpanda !== "boolean") {
		throw new Error(`${field}.lightpanda must be true or false`);
	}
	const policy = parsePolicy(subagent.mcp, `${field}.mcp`);
	// Its tools are named like those of a server called so.
	if (lightpanda && policy.has("lightpanda")) {
		throw new Error(`${field}.mcp names a "lightpanda" server next to its own`);
	}

	return {
		description: requiredString(subagent.description, `${field}.description`),
		prompt: requiredString(subagent.prompt, `${field}.prompt`),
		model,
		policy,
		lightpanda,
	};
};

export const subagents: ReadonlyMap<string, SubagentConfig> = new Map(
	Object.entries(config().subagents ?? {}).map(([name, subagent]) => [
		name,
		parseSubagent(name, subagent),
	]),
);
