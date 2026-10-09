import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getTdjson } from "prebuilt-tdlib";
import * as tdl from "tdl";
import type {
	InputMessageContent$Input as InputMessageContent,
	message as Message,
	Update,
} from "tdlib-types";

// TDLib keeps the logged-in test user in this directory.
export const LOCAL_DATABASE_DIR = "state/e2e-tdlib";

const requireEnv = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};

export const botUsername = (): string =>
	requireEnv("TELEGRAM_E2E_BOT_USERNAME");

// TELEGRAM_E2E_SESSION (base64 tar.gz of the database directory, printed by
// `pnpm e2e:login`) wins, so CI needs no files; locally the directory is used.
const databaseDirectory = (): string => {
	const session = process.env.TELEGRAM_E2E_SESSION;
	if (!session) return LOCAL_DATABASE_DIR;

	const directory = mkdtempSync(path.join(tmpdir(), "e2e-tdlib-"));
	const archive = path.join(directory, "session.tar.gz");
	writeFileSync(archive, Buffer.from(session, "base64"));
	execFileSync("tar", ["xzf", archive, "-C", directory]);
	return directory;
};

export const packSession = (directory: string): string =>
	execFileSync("tar", ["czf", "-", "-C", directory, "."]).toString("base64");

// E2E always runs against Telegram's test environment, never production.
export const createTestUserClient = (
	directory = databaseDirectory(),
): tdl.Client => {
	tdl.configure({ tdjson: getTdjson(), verbosityLevel: 1 });
	return tdl.createClient({
		apiId: Number(requireEnv("TELEGRAM_E2E_API_ID")),
		apiHash: requireEnv("TELEGRAM_E2E_API_HASH"),
		databaseDirectory: directory,
		filesDirectory: path.join(directory, "files"),
		useTestDc: true,
		// Keeps the session to a small binlog that fits in a CI secret.
		tdlibParameters: {
			use_message_database: false,
			use_file_database: false,
			use_chat_info_database: false,
		},
	});
};

export const connectTestUser = async (): Promise<tdl.Client> => {
	const client = createTestUserClient();
	await client.login({
		getPhoneNumber: () =>
			Promise.reject(
				new Error("The test user is not logged in; run pnpm e2e:login"),
			),
	});
	return client;
};

// Text of a message as the user sees it; rich messages are flattened to the
// plain text of their blocks.
const plainText = (node: unknown): string => {
	if (Array.isArray(node)) return node.map(plainText).join("");
	if (typeof node !== "object" || node === null) return "";

	const record = node as Record<string, unknown>;
	if (record._ === "richTextPlain") return String(record.text);
	if (record._ === "richTextDiff") return plainText(record.text);

	return Object.entries(record)
		.filter(([key]) => key !== "_")
		.map(([, value]) => plainText(value))
		.join("");
};

export const messageText = (message: Message): string => {
	const { content } = message;
	if (content._ === "messageText") return content.text.text;
	if (content._ === "messageRichMessage") {
		return content.message.blocks.map(plainText).join("\n");
	}
	return "";
};

type MessageFilter = (text: string) => boolean;

const anyMessage: MessageFilter = () => true;

const botChatId = async (client: tdl.Client, bot: string): Promise<number> =>
	(await client.invoke({ _: "searchPublicChat", username: bot })).id;

// Calls `listener` with the text of every new message the bot sends to the
// chat; returns the unsubscribe function.
const onBotMessage = (
	client: tdl.Client,
	chatId: number,
	listener: (text: string) => void,
): (() => void) => {
	const onUpdate = (update: Update) => {
		if (update._ !== "updateNewMessage") return;
		const { message } = update;
		if (message.chat_id !== chatId || message.is_outgoing) return;
		listener(messageText(message));
	};
	client.on("update", onUpdate);
	return () => client.off("update", onUpdate);
};

const nextBotMessage = (
	client: tdl.Client,
	chatId: number,
	matches: MessageFilter,
	timeoutMs: number,
): Promise<string> =>
	new Promise((resolve, reject) => {
		const finish = (settle: () => void) => {
			clearTimeout(timer);
			unsubscribe();
			settle();
		};
		const unsubscribe = onBotMessage(client, chatId, (text) => {
			if (matches(text)) finish(() => resolve(text));
		});
		const timer = setTimeout(
			() =>
				finish(() =>
					reject(new Error(`No matching bot message within ${timeoutMs} ms`)),
				),
			timeoutMs,
		);
	});

/** Resolves with the next message from the bot that `matches`. */
export const waitForBotMessage = async (
	client: tdl.Client,
	bot: string,
	{ matches = anyMessage, timeoutMs = 60_000 } = {},
): Promise<string> =>
	nextBotMessage(client, await botChatId(client, bot), matches, timeoutMs);

/** Rejects if the bot sends a message that `matches` within `durationMs`. */
export const expectNoBotMessage = async (
	client: tdl.Client,
	bot: string,
	{
		matches = anyMessage,
		durationMs,
	}: { matches?: MessageFilter; durationMs: number },
): Promise<void> => {
	const chatId = await botChatId(client, bot);
	return new Promise((resolve, reject) => {
		const unsubscribe = onBotMessage(client, chatId, (text) => {
			if (!matches(text)) return;
			clearTimeout(timer);
			unsubscribe();
			reject(new Error(`Unexpected bot message: ${text}`));
		});
		const timer = setTimeout(() => {
			unsubscribe();
			resolve();
		}, durationMs);
	});
};

const sendContentAndWaitForReply = async (
	client: tdl.Client,
	bot: string,
	content: InputMessageContent,
	{ matches = anyMessage, timeoutMs = 60_000 } = {},
): Promise<string> => {
	const chatId = await botChatId(client, bot);
	// Listen before sending so a fast reply cannot be missed.
	const reply = nextBotMessage(client, chatId, matches, timeoutMs);
	// If sending fails, that error is the one to report, not the reply timeout.
	reply.catch(() => {});

	await client.invoke({
		_: "sendMessage",
		chat_id: chatId,
		input_message_content: content,
	});

	return reply;
};

/**
 * Records what the bot shows in the chat besides messages: whether it showed
 * "typing…", and whether it streamed a draft. `stop()` returns both.
 */
export const watchBotActivity = async (
	client: tdl.Client,
	bot: string,
): Promise<{ stop: () => { typing: boolean; drafts: boolean } }> => {
	const chatId = await botChatId(client, bot);
	const seen = { typing: false, drafts: false };
	const onUpdate = (update: Update) => {
		if (update._ === "updateChatAction" && update.chat_id === chatId) {
			if (update.action._ === "chatActionTyping") seen.typing = true;
		}
		if (update._ === "updatePendingMessage" && update.chat_id === chatId) {
			seen.drafts = true;
		}
	};
	client.on("update", onUpdate);
	return {
		stop: () => {
			client.off("update", onUpdate);
			return seen;
		},
	};
};

/**
 * Sends `text` to the bot and resolves with the emoji the bot reacts to it
 * with.
 */
export const sendAndWaitForReaction = async (
	client: tdl.Client,
	bot: string,
	text: string,
	{ timeoutMs = 60_000 } = {},
): Promise<string> => {
	const chatId = await botChatId(client, bot);
	// The message is sent with a temporary id; its final one comes in an update,
	// which may come before sendMessage returns.
	const finalIds = new Map<number, number>();
	const onUpdate = (update: Update) => {
		if (update._ !== "updateMessageSendSucceeded") return;
		finalIds.set(update.old_message_id, update.message.id);
	};
	client.on("update", onUpdate);
	const pending = await client.invoke({
		_: "sendMessage",
		chat_id: chatId,
		input_message_content: {
			_: "inputMessageText",
			text: { _: "formattedText", text },
		},
	});

	try {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			const messageId = finalIds.get(pending.id);
			if (messageId === undefined) continue;
			const message = await client.invoke({
				_: "getMessage",
				chat_id: chatId,
				message_id: messageId,
			});
			const [reaction] = message.interaction_info?.reactions?.reactions ?? [];
			if (reaction?.type._ === "reactionTypeEmoji") return reaction.type.emoji;
		}
		throw new Error(`No reaction within ${timeoutMs} ms`);
	} finally {
		client.off("update", onUpdate);
	}
};

/** The commands the chat's menu offers for the bot. */
export const botCommands = async (
	client: tdl.Client,
	bot: string,
): Promise<string[]> => {
	const chat = await client.invoke({ _: "searchPublicChat", username: bot });
	if (chat.type._ !== "chatTypePrivate") throw new Error(`${bot} is no bot`);
	const { bot_info } = await client.invoke({
		_: "getUserFullInfo",
		user_id: chat.type.user_id,
	});
	return (bot_info?.commands ?? []).map(({ command }) => command);
};

/** The texts of the newest messages in the chat with the bot, newest first. */
export const recentMessages = async (
	client: tdl.Client,
	bot: string,
	limit = 10,
): Promise<string[]> => {
	const { messages } = await client.invoke({
		_: "getChatHistory",
		chat_id: await botChatId(client, bot),
		from_message_id: 0,
		offset: 0,
		limit,
		only_local: false,
	});
	return messages.flatMap((message) => (message ? [messageText(message)] : []));
};

/** Sends `text` to the bot without waiting for a reply, e.g. a command. */
export const sendToBot = async (
	client: tdl.Client,
	bot: string,
	text: string,
): Promise<void> => {
	await client.invoke({
		_: "sendMessage",
		chat_id: await botChatId(client, bot),
		input_message_content: {
			_: "inputMessageText",
			text: { _: "formattedText", text },
		},
	});
};

/** Sends `text` to the bot and resolves with its next message that `matches`. */
export const sendAndWaitForReply = (
	client: tdl.Client,
	bot: string,
	text: string,
	options: { matches?: MessageFilter; timeoutMs?: number } = {},
): Promise<string> =>
	sendContentAndWaitForReply(
		client,
		bot,
		{ _: "inputMessageText", text: { _: "formattedText", text } },
		options,
	);

/**
 * Sends the image file at `photoPath` as a photo with an optional `caption`
 * and resolves with the bot's next message that `matches`.
 */
export const sendPhotoAndWaitForReply = (
	client: tdl.Client,
	bot: string,
	photoPath: string,
	caption: string,
	options: { matches?: MessageFilter; timeoutMs?: number } = {},
): Promise<string> =>
	sendContentAndWaitForReply(
		client,
		bot,
		{
			_: "inputMessagePhoto",
			photo: {
				_: "inputPhoto",
				photo: { _: "inputFileLocal", path: photoPath },
			},
			caption: { _: "formattedText", text: caption },
		},
		options,
	);

/**
 * Sends the file at `documentPath` as a document (a file, not a photo) with
 * `caption` and resolves with the bot's next message that `matches`.
 */
export const sendDocumentAndWaitForReply = (
	client: tdl.Client,
	bot: string,
	documentPath: string,
	caption: string,
	options: { matches?: MessageFilter; timeoutMs?: number } = {},
): Promise<string> =>
	sendContentAndWaitForReply(
		client,
		bot,
		{
			_: "inputMessageDocument",
			document: {
				_: "inputDocument",
				document: { _: "inputFileLocal", path: documentPath },
			},
			caption: { _: "formattedText", text: caption },
		},
		options,
	);

/**
 * Waits for named documents and the completed text reply, in any order.
 * Listens before sending, and ignores background acknowledgements that do not
 * match. Downloads the actual Telegram attachment, not a local exported file.
 */
export const sendAndWaitForDocument = async (
	client: tdl.Client,
	bot: string,
	input: { text: string } | { documentPath: string; caption: string },
	{
		fileName,
		matches,
		timeoutMs = 120_000,
		additionalFileNames = [],
	}: {
		fileName: string;
		matches: MessageFilter;
		timeoutMs?: number;
		additionalFileNames?: string[];
	},
): Promise<{
	data: Buffer;
	fileName: string;
	mimeType: string;
	reply: string;
	texts: string[];
	additionalDocuments: { data: Buffer; fileName: string; mimeType: string }[];
}> => {
	const chatId = await botChatId(client, bot);
	const texts: string[] = [];
	const fileNames = [fileName, ...additionalFileNames];
	const documents = new Map<string, Message>();
	let reply: string | undefined;
	let unsubscribe = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const received = new Promise<{ reply: string }>((resolve, reject) => {
		const onUpdate = (update: Update) => {
			if (update._ !== "updateNewMessage") return;
			const { message } = update;
			if (message.chat_id !== chatId || message.is_outgoing) return;
			const text = messageText(message);
			if (text) texts.push(text);
			if (text && matches(text)) reply = text;
			if (
				message.content._ === "messageDocument" &&
				fileNames.includes(message.content.document.file_name)
			)
				documents.set(message.content.document.file_name, message);
			if (fileNames.every((name) => documents.has(name)) && reply !== undefined)
				resolve({ reply });
		};
		client.on("update", onUpdate);
		unsubscribe = () => client.off("update", onUpdate);
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`No documents ${fileNames.join(", ")} and completed reply within ${timeoutMs} ms ` +
							`(documents received: ${[...documents.keys()].join(", ")}, reply received: ${reply !== undefined}; texts: ${texts.join(" | ")})`,
					),
				),
			timeoutMs,
		);
	});
	// A send failure owns the error; don't leave a rejected waiter unhandled.
	received.catch(() => {});
	try {
		await client.invoke({
			_: "sendMessage",
			chat_id: chatId,
			input_message_content:
				"text" in input
					? {
							_: "inputMessageText",
							text: { _: "formattedText", text: input.text },
						}
					: {
							_: "inputMessageDocument",
							document: {
								_: "inputDocument",
								document: { _: "inputFileLocal", path: input.documentPath },
							},
							caption: { _: "formattedText", text: input.caption },
						},
		});
		const result = await received;
		const download = async (name: string) => {
			const document = documents.get(name);
			if (document?.content._ !== "messageDocument")
				throw new Error("Expected a Telegram document.");
			const attachment = document.content.document;
			const downloaded = await client.invoke({
				_: "downloadFile",
				file_id: attachment.document.id,
				priority: 32,
				synchronous: true,
			});
			if (!downloaded.local.is_downloading_completed || !downloaded.local.path)
				throw new Error(`Telegram did not finish downloading ${name}.`);
			const data = readFileSync(downloaded.local.path);
			if (data.length !== attachment.document.size)
				throw new Error(`Incomplete Telegram document ${name}.`);
			return {
				data,
				fileName: attachment.file_name,
				mimeType: attachment.mime_type,
			};
		};
		const attachment = await download(fileName);
		const additionalDocuments = await Promise.all(
			additionalFileNames.map(download),
		);
		return {
			...attachment,
			reply: result.reply,
			texts,
			additionalDocuments,
		};
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
};

/**
 * Sends the OGG Opus file at `voicePath` as a voice note and resolves with the
 * bot's next message that `matches`.
 */
export const sendVoiceAndWaitForReply = (
	client: tdl.Client,
	bot: string,
	voicePath: string,
	options: { matches?: MessageFilter; timeoutMs?: number } = {},
): Promise<string> =>
	sendContentAndWaitForReply(
		client,
		bot,
		{
			_: "inputMessageVoiceNote",
			voice_note: {
				_: "inputVoiceNote",
				voice_note: { _: "inputFileLocal", path: voicePath },
			},
		},
		options,
	);
