import type {
	AuthEvent,
	AuthInteraction,
	AuthPrompt,
} from "@earendil-works/pi-ai";
import type { CommandContext, Context, Filter, NextFunction } from "grammy";

import { models } from "../agent/models.ts";
import { bot, chatId } from "./bot.ts";

// Logging in to the model providers runs between the user and the chat, past
// the agent: `/login`, `/logout`, `/cancel`. Answers to a login's questions are
// taken from the chat while it runs.

type Login = {
	controller: AbortController;
	/** Takes the answer to the open question; false if it is not one. */
	answer: ((text: string) => boolean) | undefined;
};

let login: Login | undefined;

const send = (text: string) =>
	bot.api.sendMessage(chatId, text, {
		link_preview_options: { is_disabled: true },
	});

const eventText = (event: AuthEvent): string => {
	switch (event.type) {
		case "device_code":
			return `Otwórz ${event.verificationUri} i wpisz kod: ${event.userCode}`;
		case "auth_url":
			return [`Otwórz: ${event.url}`, event.instructions]
				.filter(Boolean)
				.join("\n");
		case "info":
			return [event.message, ...(event.links ?? []).map((link) => link.url)]
				.filter(Boolean)
				.join("\n");
		case "progress":
			return event.message;
	}
};

const promptText = (prompt: AuthPrompt): string =>
	prompt.type === "select"
		? [
				prompt.message,
				...prompt.options.map(
					(option, index) => `${index + 1}. ${option.label}`,
				),
				"Odpowiedz numerem.",
			].join("\n")
		: prompt.message;

// A select is answered with an option's number or id.
const selected = (prompt: AuthPrompt, text: string): string | undefined => {
	if (prompt.type !== "select") return text;
	const byNumber = prompt.options[Number(text) - 1];
	return (byNumber ?? prompt.options.find((option) => option.id === text))?.id;
};

const createInteraction = (current: Login): AuthInteraction => ({
	signal: current.controller.signal,

	notify: (event) => {
		send(eventText(event)).catch((error) =>
			console.error("Login message failed:", error),
		);
	},

	prompt: async (prompt) => {
		await send(promptText(prompt));
		return new Promise((resolve, reject) => {
			const abort = () => {
				current.answer = undefined;
				reject(new Error("Login cancelled"));
			};
			for (const signal of [prompt.signal, current.controller.signal]) {
				signal?.addEventListener("abort", abort, { once: true });
			}

			current.answer = (text) => {
				const value = selected(prompt, text);
				if (value === undefined) return false;
				current.answer = undefined;
				resolve(value);
				return true;
			};
		});
	},
});

const statusLines = async (): Promise<string[]> =>
	Promise.all(
		models.getProviders().map(async (provider) => {
			const check = await models.checkAuth(provider.id).catch(() => undefined);
			const status = check ? `✅ ${check.source ?? check.type}` : "—";
			return `${provider.id} (${provider.name}): ${status}`;
		}),
	);

/** `/login` lists the providers; `/login <provider>` signs in to one. */
export const handleLoginCommand = async (
	ctx: CommandContext<Context>,
): Promise<void> => {
	const providerId = ctx.match.trim();

	if (!providerId) {
		await ctx.reply(
			[...(await statusLines()), "", "Zaloguj: /login <dostawca>"].join("\n"),
		);
		return;
	}

	// Only subscriptions, which sign in through OAuth.
	const provider = models.getProvider(providerId);
	if (!provider?.auth.oauth) {
		await ctx.reply(`Nie znam dostawcy „${providerId}”. Zobacz /login.`);
		return;
	}
	if (login) {
		await ctx.reply("Trwa już logowanie; przerwij je przez /cancel.");
		return;
	}

	const current: Login = {
		controller: new AbortController(),
		answer: undefined,
	};
	login = current;

	// Not awaited: the login waits for answers that arrive as later updates.
	models
		.login(provider.id, "oauth", createInteraction(current))
		.then(() => send(`Zalogowano: ${provider.name}.`))
		.catch((error: unknown) => {
			console.error("Login failed:", error);
			return send(
				current.controller.signal.aborted
					? "Logowanie przerwane."
					: `Logowanie nie powiodło się: ${error instanceof Error ? error.message : error}`,
			);
		})
		.finally(() => {
			if (login === current) login = undefined;
		});
};

/** `/logout <provider>` forgets the stored credential. */
export const handleLogoutCommand = async (
	ctx: CommandContext<Context>,
): Promise<void> => {
	const provider = models.getProvider(ctx.match.trim());
	if (!provider) {
		await ctx.reply("Podaj dostawcę: /logout <dostawca>. Zobacz /login.");
		return;
	}
	await models.logout(provider.id);
	await ctx.reply(`Wylogowano: ${provider.name}.`);
};

/** `/cancel` stops the running login. */
export const handleCancelCommand = async (
	ctx: CommandContext<Context>,
): Promise<void> => {
	if (!login) {
		await ctx.reply("Nic nie trwa.");
		return;
	}
	login.controller.abort();
};

/** While a login waits for an answer, the next text message is that answer. */
export const takeLoginAnswer = async (
	ctx: Filter<Context, "message:text">,
	next: NextFunction,
): Promise<void> => {
	const answer = login?.answer;
	if (!answer || ctx.message.text.startsWith("/")) {
		await next();
		return;
	}

	if (!answer(ctx.message.text.trim())) {
		await ctx.reply("Nie rozumiem; odpowiedz numerem z listy.");
	}
};
