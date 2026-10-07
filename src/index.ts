import { type Config, readConfigFile, useConfig } from "./config.ts";

export type { Config, McpServer, Model, Subagent } from "./config.ts";

/**
 * Runs the agent until the process ends, as `config` describes or, without
 * one, as `house-agents.config.ts` in the working directory does.
 */
export const startAgent = async (config?: Config): Promise<void> => {
	useConfig(config ?? (await readConfigFile()));
	// Every other module reads the config as it loads, so they load only now.
	await import("./start.ts");
};
