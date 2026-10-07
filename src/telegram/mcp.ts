import type { CommandContext, Context, Filter, NextFunction } from "grammy";

import { listServerTools } from "../mcp/client.ts";
import {
	agentPolicy,
	type Policy,
	type ServerConfig,
	servers,
	tokens,
} from "../mcp/config.ts";
import { type McpLogin, startLogin } from "../mcp/login.ts";
import { hasTokens } from "../mcp/oauth.ts";
import type { Mcp } from "../mcp/start.ts";
import { subagents } from "../subagents/config.ts";
import { chatId } from "./bot.ts";

// The MCP servers between the user and the chat, past the agent: `/mcp`
// lists them, `/mcp <server>` shows its tools and who may call each, and
// `/mcp_login <server>` logs in to one through OAuth. What may be called is
// up to the config; the chat only shows it.

export const LOGIN_COMMAND = "mcp_login";

const AGENT = "agent";

// Who may use what, by policy: the agent and each subagent.
const policies: [string, Policy][] = [
	[AGENT, agentPolicy],
	...[...subagents].map(([name, subagent]): [string, Policy] => [
		name,
		subagent.policy,
	]),
];

const usersOf = (server: string, tool?: string): string[] =>
	policies
		.filter(([, policy]) => {
			const allowed = policy.get(server);
			return allowed !== undefined && (!tool || allowed.includes(tool));
		})
		.map(([name]) => name);

const needsLogin = (server: string, config: ServerConfig): boolean =>
	config.type === "http" &&
	config.oauth !== undefined &&
	!hasTokens(tokens, server, config.url);

const statusText = (mcp: Mcp, server: string, config: ServerConfig) => {
	if (needsLogin(server, config)) return "🔒 wymaga logowania";
	switch (mcp.status(server)) {
		case "connected":
			return "✓ połączony";
		case "login":
			return "🔒 wymaga ponownego logowania";
		case "error":
			return "✗ nie łączy się";
		default:
			return "łączony, gdy pracuje subagent";
	}
};

const listText = (mcp: Mcp): string =>
	servers.size === 0
		? "Nie ma skonfigurowanych serwerów MCP."
		: [
				...[...servers].map(([server, config]) => {
					const users = usersOf(server);
					return `${server}: ${statusText(mcp, server, config)}; ${
						users.length > 0 ? `dla: ${users.join(", ")}` : "nieużywany"
					}`;
				}),
				"",
				`Narzędzia: /mcp <serwer>. Logowanie: /${LOGIN_COMMAND} <serwer>.`,
			].join("\n");

const toolsText = async (server: string, config: ServerConfig) => {
	const tools = await listServerTools(server, config, tokens);
	if (!tools) {
		return `${server}: 🔒 wymaga logowania: /${LOGIN_COMMAND} ${server}`;
	}
	return [
		`${server}, narzędzia (✓ dozwolone, według konfiguracji):`,
		...tools.map((tool) => {
			const users = usersOf(server, tool.name);
			return users.length > 0
				? `✓ ${tool.name} (${users.join(", ")})`
				: `· ${tool.name}`;
		}),
	].join("\n");
};

/** `/mcp` lists the servers; `/mcp <server>` shows the tools of one. */
export const createMcpCommand =
	(mcp: Mcp) =>
	async (ctx: CommandContext<Context>): Promise<void> => {
		const server = ctx.match.trim();
		if (!server) {
			await ctx.reply(listText(mcp));
			return;
		}

		const config = servers.get(server);
		if (!config) {
			await ctx.reply(`Nie ma serwera „${server}”. Zobacz /mcp.`);
			return;
		}
		try {
			await ctx.reply(await toolsText(server, config));
		} catch (error) {
			console.error(`MCP ${server}: listing tools failed:`, error);
			await ctx.reply(`Serwer „${server}” nie odpowiada.`);
		}
	};

type Login = McpLogin & { server: string; linkMessageId: number };

let login: Login | undefined;

/**
 * `/mcp_login <server>` sends the link to approve at; the next text message
 * is the address the browser ended up on.
 */
export const createLoginCommand =
	(mcp: Mcp) =>
	async (ctx: CommandContext<Context>): Promise<void> => {
		const server = ctx.match.trim();
		const config = servers.get(server);
		if (config?.type !== "http" || !config.oauth) {
			await ctx.reply(
				`Podaj serwer logujący się przez OAuth: /${LOGIN_COMMAND} <serwer>. Zobacz /mcp.`,
			);
			return;
		}

		try {
			const started = await startLogin(server, config, tokens);
			if (!started) {
				await mcp.reconnect(server);
				await ctx.reply(`Serwer „${server}” jest już zalogowany.`);
				return;
			}
			const link = await ctx.reply(
				`Zaloguj się do „${server}”:\n${started.url.href}\n\n` +
					"Po zatwierdzeniu przeglądarka otworzy stronę, która się nie " +
					"załaduje. Wyślij tutaj jej pełny adres. /cancel przerywa.",
				{ link_preview_options: { is_disabled: true } },
			);
			login = { ...started, server, linkMessageId: link.message_id };
		} catch (error) {
			console.error(`MCP ${server}: login failed:`, error);
			await ctx.reply(`Nie udało się zacząć logowania do „${server}”.`);
		}
	};

const parseUrl = (text: string): URL | undefined => {
	try {
		return new URL(text);
	} catch {
		return undefined;
	}
};

/** While a login waits, the next text message is the address it ended on. */
export const createLoginAnswer =
	(mcp: Mcp) =>
	async (
		ctx: Filter<Context, "message:text">,
		next: NextFunction,
	): Promise<void> => {
		const current = login;
		if (!current || ctx.message.text.startsWith("/")) {
			await next();
			return;
		}

		const redirect = parseUrl(ctx.message.text.trim());
		if (!redirect) {
			await ctx.reply("To nie jest adres; wyślij pełny adres z przeglądarki.");
			return;
		}

		login = undefined;
		try {
			await current.finish(redirect);
			await mcp.reconnect(current.server);
			// The link and the address carry the login; neither stays in the chat.
			await ctx.api
				.deleteMessages(chatId, [current.linkMessageId, ctx.message.message_id])
				.catch((error) =>
					console.error("Deleting the login messages failed:", error),
				);
			await ctx.reply(`Połączono z „${current.server}”.`);
		} catch (error) {
			console.error(`MCP ${current.server}: login failed:`, error);
			await ctx.reply(
				`Logowanie nie powiodło się. Spróbuj ponownie: /${LOGIN_COMMAND} ${current.server}`,
			);
		}
	};

/** `/cancel` stops a login under way, or goes on to the next handler. */
export const cancelMcpLogin = async (
	ctx: CommandContext<Context>,
	next: NextFunction,
): Promise<void> => {
	if (!login) {
		await next();
		return;
	}
	login = undefined;
	await ctx.reply("Logowanie przerwane.");
};
