import type { Context, NextFunction } from "grammy";

// Messages for the agent are handled one after another, in the background, so
// the bot keeps taking updates: a command answers at once, even while the
// agent is still busy with an earlier message.

let queue: Promise<void> = Promise.resolve();

export const inTurn = (ctx: Context, next: NextFunction): Promise<void> => {
	queue = queue.then(next).catch((error) => {
		// Only the cause: the context it comes with holds the bot's token.
		console.error(`Telegram error in update ${ctx.update.update_id}:`, error);
	});
	return Promise.resolve();
};
