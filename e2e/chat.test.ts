// Contract: what the agent hears from the chat besides single messages.
// Messages sent within three seconds of each other reach it as one input; a
// reply comes with the message it answers; a reaction starts no turn, but the
// next message tells it which emoji landed on which of its messages. The scripted model (`e2e/scripted-model.ts`)
// repeats what it was given, so this tests the adapter, not a model's
// judgement. Runs its own bot process on an empty session.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Client } from "tdl";

import { type RunningBot, startBot } from "./bot.ts";
import { SCRIPTED_MODEL, say, script } from "./scripted-model.ts";
import {
	botUsername,
	connectTestUser,
	expectNoBotMessage,
	newestBotMessage,
	reactInBotChat,
	replyToBot,
	sendAndWaitForReply,
	sendToBot,
	waitForBotMessage,
} from "./telegram/client.ts";

const MINUTE = 60_000;

// Unique per run, so a message from an earlier run never satisfies this one.
const runId = Date.now().toString(36).toUpperCase();
const second = `SECOND-${runId}`;
const ok = `OK-${runId}`;

let runningBot: RunningBot;
let client: Client;
let bot: string;

before(async () => {
	runningBot = await startBot({ model: SCRIPTED_MODEL });
	client = await connectTestUser();
	bot = botUsername();
});

after(async () => {
	await client?.close();
	await runningBot?.stop();
});

test("chat: batched messages, replies and reactions", {
	timeout: 3 * MINUTE,
}, async (t) => {
	await t.test("hears messages sent together as one", async () => {
		// Apart, the first would be answered before the second came, with
		// nothing to repeat.
		const reply = waitForBotMessage(client, bot, { timeoutMs: MINUTE });
		await sendToBot(client, bot, script(say("{{match:SECOND-\\w+}}")));
		await sendToBot(client, bot, second);
		assert.equal(await reply, second);
	});

	await t.test("hears which message a reply answers", async () => {
		await sendAndWaitForReply(
			client,
			bot,
			script(
				say(ok),
				say('{{match:replies to your message: "[^"]*"}}'),
				say('{{match:reacted with \\S+ to your message: "[^"]*"}}'),
			),
			{ matches: (text) => text === ok },
		);
		const { id } = await newestBotMessage(client, bot);
		const reply = waitForBotMessage(client, bot, { timeoutMs: MINUTE });
		await replyToBot(client, bot, id, "Co tu napisałeś?");
		assert.equal(await reply, `replies to your message: "${ok}"`);
	});

	await t.test("hears a reaction with the next message", async () => {
		const { id } = await newestBotMessage(client, bot);
		// The newest is the answer to the reply; the one before it says OK.
		await reactInBotChat(client, bot, id, "🔥");
		// Past the debounce: a turn it started would have answered by then.
		await expectNoBotMessage(client, bot, { durationMs: 6_000 });
		assert.match(
			await sendAndWaitForReply(client, bot, "A teraz?", { timeoutMs: MINUTE }),
			/^reacted with 🔥 to your message: "replies to/,
		);
	});
});
