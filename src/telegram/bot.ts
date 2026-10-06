import { Bot } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
	throw new Error("TELEGRAM_BOT_TOKEN is required");
}

// The bot serves exactly one chat; messages from any other chat are ignored.
const parsedChatId = Number(process.env.TELEGRAM_CHAT_ID);
if (!Number.isSafeInteger(parsedChatId)) {
	throw new Error("TELEGRAM_CHAT_ID must be an integer chat id");
}

export const chatId = parsedChatId;

// "test" points the bot at Telegram's separate test environment, used by E2E.
export const environment = process.env.TELEGRAM_ENVIRONMENT ?? "prod";
if (environment !== "prod" && environment !== "test") {
	throw new Error('TELEGRAM_ENVIRONMENT must be "prod" or "test"');
}

export const bot = new Bot(token, { client: { environment } });
