// What the latest messages of the chat said, by id: a reaction names only the
// message it lands on, and a reply may point at one with no text of its own
// (a voice message). Kept in memory, so after a restart older messages are
// unknown.
const LIMIT = 500;

export type Said = { from: "user" | "agent"; text: string };

const said = new Map<number, Said>();

export const remember = (messageId: number, entry: Said): void => {
	said.delete(messageId);
	said.set(messageId, entry);
	for (const oldest of said.keys()) {
		if (said.size <= LIMIT) break;
		said.delete(oldest);
	}
};

export const recall = (messageId: number): Said | undefined =>
	said.get(messageId);
