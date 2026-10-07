import { type ModelSwitch, onModelSwitch } from "../agent/fallback.ts";
import type { Model } from "../config.ts";
import { bot, chatId } from "./bot.ts";

const MAX_ERROR_LENGTH = 300;

const modelName = (model: Model): string =>
	`${model.provider}/${model.modelId}`;

const switchText = (change: ModelSwitch): string =>
	change.to === "fallback"
		? `⚠️ ${modelName(change.model)} nie odpowiada: ` +
			`${change.error.slice(0, MAX_ERROR_LENGTH)}\n` +
			`Odpowiadam przez ${modelName(change.fallback)}.`
		: `${modelName(change.model)} znów odpowiada.`;

/** Tells the chat when the agent turns to its fallback model, and back. */
export const announceModelSwitches = (): void =>
	onModelSwitch((change) => {
		bot.api.sendMessage(chatId, switchText(change)).catch((error) => {
			console.error("Telegram error:", error);
		});
	});
