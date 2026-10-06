import type { CommandContext, Context } from "grammy";

import type { Mcp } from "../mcp/start.ts";
import { bot, chatId } from "./bot.ts";

// OAuth of MCP servers runs between the user and the chat, past the agent.

export const AUTH_COMMAND = "mcp_auth";

const authorizationText = (server: string, url: URL): string =>
	`Serwer MCP „${server}” wymaga autoryzacji:\n${url.href}\n\n` +
	"Po zatwierdzeniu przeglądarka otworzy stronę, która się nie załaduje. " +
	`Wyślij jej pełny adres jako: /${AUTH_COMMAND} <adres>`;

/** Sends the user a server's authorization link. */
export const sendAuthorizationLink = async (
	server: string,
	url: URL,
): Promise<void> => {
	await bot.api.sendMessage(chatId, authorizationText(server, url), {
		link_preview_options: { is_disabled: true },
	});
};

const parseUrl = (text: string): URL | undefined => {
	try {
		return new URL(text);
	} catch {
		return undefined;
	}
};

/**
 * `/mcp_auth <address>` finishes an authorization with the address the
 * browser ended up on; `/mcp_auth` alone sends the pending links again.
 */
export const createAuthCommand =
	(mcp: Mcp) =>
	async (ctx: CommandContext<Context>): Promise<void> => {
		const redirect = parseUrl(ctx.match.trim());

		if (!redirect) {
			const pending = mcp.pendingAuthorizations();
			if (pending.length === 0) {
				await ctx.reply("Żaden serwer MCP nie czeka na autoryzację.");
				return;
			}
			for (const { server, url } of pending) {
				await sendAuthorizationLink(server, url);
			}
			return;
		}

		try {
			const server = await mcp.finishAuthorization(redirect);
			await ctx.reply(`Serwer MCP „${server}” autoryzowany.`);
		} catch (error) {
			console.error("MCP authorization failed:", error);
			await ctx.reply(
				"Autoryzacja nie powiodła się. Wyślij /mcp_auth, żeby dostać nowy link.",
			);
		}
	};
