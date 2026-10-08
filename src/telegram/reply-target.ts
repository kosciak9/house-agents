// The user's message the agent's next answer is for: a reaction lands on it.
// The first answer after it takes it, so a later turn (a scheduled prompt) has
// none.
let target: number | undefined;

export const setReplyTarget = (messageId: number): void => {
	target = messageId;
};

export const takeReplyTarget = (): number | undefined => {
	const messageId = target;
	target = undefined;
	return messageId;
};
