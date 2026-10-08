import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type CallbackQueryContext,
	type CommandContext,
	type Context,
	InlineKeyboard,
} from "grammy";

import { harness, root } from "../agent/harness.ts";
import { currentUsage } from "../agent/usage.ts";
import { LIGHTPANDA_TOOLS } from "../lightpanda/connect.ts";
import { toolName } from "../mcp/client.ts";
import type { Mcp } from "../mcp/start.ts";
import { openMemory } from "../memory/store.ts";
import { parseBlock } from "../memory/tree.ts";
import { memoryLines, zoomLines } from "../memory/wake.ts";
import { subagents } from "../subagents/config.ts";
import { usageText } from "./usage.ts";

// `/diagnostics <what>` shows how the agent stands, past the agent.

const CODEMODE = "codemode";

const toolLines = (tools: string[], mcpTools: string[]): string[] =>
	tools.map((tool) =>
		tool === CODEMODE && mcpTools.length > 0
			? `· ${tool}: ${mcpTools.join(", ")}`
			: `· ${tool}`,
	);

// Every tool the agent is offered now, then what each subagent gets once it
// runs; local and MCP tools as `codemode` scripts call them.
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

// Plain text avoids interpreting stored memories as Telegram markup. Preserve
// whole notes where possible and never split a UTF-16 surrogate pair.
const replyText = async (ctx: Context, text: string, memory = false) => {
	while (text.length > 0) {
		let end = Math.min(text.length, 3500);
		if (end < text.length) {
			const newline = text.lastIndexOf("\n", end - 1);
			if (newline > 0) end = newline + 1;
			else if (/^[\uD800-\uDBFF]$/.test(text[end - 1])) end -= 1;
		}
		const chunk = text.slice(0, end);
		text = text.slice(end);
		const keyboard = new InlineKeyboard();
		if (memory) {
			for (const match of chunk.matchAll(/^#(\d+-\d+) /gm)) {
				keyboard
					.text(`Zoom #${match[1]}`, `diagnostics-memory:${match[1]}`)
					.row();
			}
			keyboard.text("Całość pamięci", "diagnostics-memory:");
		}
		await ctx.reply(chunk, {
			...(keyboard.inline_keyboard.length > 0 && { reply_markup: keyboard }),
		});
	}
};

const showMemory = async (ctx: Context, address: string): Promise<void> => {
	const memory = await openMemory(harness, BACKGROUND_CONTEXT);
	const block = address === "" ? undefined : parseBlock(address);
	if (address !== "" && (!block || block.lo >= memory.count)) {
		await ctx.reply(
			"Użycie: /diagnostics memory lub /diagnostics memory #0-15 (istniejący zakres).",
		);
		return;
	}
	const lines = block
		? await zoomLines(memory, block)
		: await memoryLines(memory);
	await replyText(
		ctx,
		[
			`Pamięć — ${memory.count} zakończonych sesji`,
			"Aktualny zapis, w układzie czytanym przez agenta. Podgląd nie trafia do modelu.",
			...(memory.queue.length > 0
				? [`Oczekuje na zapis: ${memory.queue.length} sesji.`]
				: []),
			"",
			...(lines.length > 0 ? lines : ["Pamięć jest pusta."]),
			"",
			"Zagłębianie: /diagnostics memory #a-b lub przycisk Zoom.",
			"Powrót do całości: /diagnostics memory",
		].join("\n"),
		true,
	);
};

export const handleDiagnosticsMemoryCallback = async (
	ctx: CallbackQueryContext<Context>,
): Promise<void> => {
	await ctx.answerCallbackQuery();
	const data = ctx.callbackQuery.data;
	if (data?.startsWith("diagnostics-memory:")) {
		await showMemory(ctx, data.slice("diagnostics-memory:".length));
	}
};

/** Bot-side read-only inspection: no submissions or model calls. */
export const createDiagnosticsCommand =
	(mcp: Mcp) =>
	async (ctx: CommandContext<Context>): Promise<void> => {
		const [command, ...args] = ctx.match.trim().split(/\s+/);
		switch (command) {
			case "tools":
				await ctx.reply(await toolsText(mcp));
				return;
			case "usage":
				await replyText(
					ctx,
					usageText(await harness.usage(BACKGROUND_CONTEXT), false),
				);
				return;
			case "current": {
				const context = await root.context(BACKGROUND_CONTEXT);
				const state = await root.commit(
					(tx) => currentUsage(tx, context.head?.id),
					BACKGROUND_CONTEXT,
				);
				await replyText(ctx, usageText(state, true));
				return;
			}
			case "memory":
				await showMemory(ctx, args.join(" "));
				return;
			default:
				await ctx.reply(
					"Użycie: /diagnostics usage | current | memory [#a-b] | tools",
				);
		}
	};
