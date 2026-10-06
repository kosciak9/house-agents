import { Bot } from "grammy";

import { config } from "../config.ts";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
	throw new Error("TELEGRAM_BOT_TOKEN is required");
}

// The bot serves exactly one chat; messages from any other chat are ignored.
export const chatId = config().telegram.chatId;

export const environment = config().telegram.environment ?? "prod";

export const bot = new Bot(token, { client: { environment } });
