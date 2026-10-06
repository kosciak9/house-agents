import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getTdjson } from "prebuilt-tdlib";
import * as tdl from "tdl";
import type { message as Message, Update } from "tdlib-types";

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

export const sendAndWaitForReply = async (
	client: tdl.Client,
	bot: string,
	text: string,
	timeoutMs = 60_000,
): Promise<string> => {
	const chat = await client.invoke({ _: "searchPublicChat", username: bot });

	const reply = new Promise<string>((resolve, reject) => {
		const finish = (settle: () => void) => {
			clearTimeout(timer);
			client.off("update", onUpdate);
			settle();
		};

		const onUpdate = (update: Update) => {
			if (update._ !== "updateNewMessage") return;
			const { message } = update;
			if (message.chat_id !== chat.id || message.is_outgoing) return;
			finish(() => resolve(messageText(message)));
		};

		const timer = setTimeout(
			() =>
				finish(() =>
					reject(new Error(`No reply from @${bot} within ${timeoutMs} ms`)),
				),
			timeoutMs,
		);

		// Listen before sending so a fast reply cannot be missed.
		client.on("update", onUpdate);
	});

	await client.invoke({
		_: "sendMessage",
		chat_id: chat.id,
		input_message_content: {
			_: "inputMessageText",
			text: { _: "formattedText", text },
		},
	});

	return reply;
};
