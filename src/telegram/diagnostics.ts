import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommandContext, Context } from "grammy";

import { root } from "../agent/harness.ts";
import { LIGHTPANDA_TOOLS } from "../lightpanda/connect.ts";
import { toolName } from "../mcp/client.ts";
import type { Mcp } from "../mcp/start.ts";
import { subagents } from "../subagents/config.ts";

// `/diagnostics <what>` shows how the agent stands, past the agent.

const CODEMODE = "codemode";

const toolLines = (tools: string[], mcpTools: string[]): string[] =>
	tools.map((tool) =>
		tool === CODEMODE && mcpTools.length > 0
			? `· ${tool}: ${mcpTools.join(", ")}`
			: `· ${tool}`,
	);

// Every tool the agent is offered now, then what each subagent gets once it
// runs; MCP tools as `codemode` scripts call them.
const toolsText = async (mcp: Mcp): Promise<string> => {
	const agent = await root.agent(BACKGROUND_CONTEXT);
	return [
		"agent:",
		...toolLines(
			agent.tools.map((tool) => tool.name),
			mcp.tools(),
		),
		...[...subagents].flatMap(([name, { policy, lightpanda }]) => {
			const mcpTools = [
				...[...policy].flatMap(([server, tools]) =>
					tools.map((tool) => toolName(server, tool)),
				),
				...(lightpanda ? LIGHTPANDA_TOOLS : []),
			];
			return [
				"",
				`${name} (gdy pracuje):`,
				...(mcpTools.length > 0
					? toolLines([CODEMODE], mcpTools)
					: ["· (żadnych)"]),
			];
		}),
	].join("\n");
};

/** `/diagnostics tools` lists the tools of the agent and its subagents. */
export const createDiagnosticsCommand =
	(mcp: Mcp) =>
	async (ctx: CommandContext<Context>): Promise<void> => {
		switch (ctx.match.trim()) {
			case "tools":
				await ctx.reply(await toolsText(mcp));
				return;
			default:
				await ctx.reply("Użycie: /diagnostics tools");
		}
	};
