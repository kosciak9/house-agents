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
};

const requiredString = (value: unknown, field: string): string => {
	if (typeof value !== "string" || !value) {
		throw new Error(`${field} is required`);
	}
	return value;
};

const parseSubagent = (name: string, value: unknown): SubagentConfig => {
	const field = `config.subagents.${name}`;
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

	return {
		description: requiredString(subagent.description, `${field}.description`),
		prompt: requiredString(subagent.prompt, `${field}.prompt`),
		model,
		policy: parsePolicy(subagent.mcp, `${field}.mcp`),
	};
};

export const subagents: ReadonlyMap<string, SubagentConfig> = new Map(
	Object.entries(config().subagents ?? {}).map(([name, subagent]) => [
		name,
		parseSubagent(name, subagent),
	]),
);
