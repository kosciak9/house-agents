import { defineExtension, section } from "@earendil-works/pi-durable";

// A turn ends in a message, a reaction or nothing. The agent picks by what its
// final response is: plain text, a single emoji, or this marker alone.
export const NO_REPLY = "NO_REPLY";

export type Ending =
	| { kind: "message"; markdown: string }
	| { kind: "reaction"; emoji: string }
	| { kind: "silent" };

// Tolerates the quotes, emphasis and punctuation models wrap it in.
const silent = new RegExp(`^[\\s"'\`*_.!]*${NO_REPLY}[\\s"'\`*_.!]*$`);

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const isSingleEmoji = (text: string): boolean => {
	const [first, ...rest] = graphemes.segment(text);
	return (
		first !== undefined &&
		rest.length === 0 &&
		/\p{Extended_Pictographic}/u.test(first.segment)
	);
};

/** How a final response ends the turn. */
export const endingOf = (text: string): Ending => {
	const trimmed = text.trim();
	if (silent.test(trimmed)) return { kind: "silent" };
	if (isSingleEmoji(trimmed)) return { kind: "reaction", emoji: trimmed };
	return { kind: "message", markdown: trimmed };
};

const ENDINGS_INSTRUCTIONS = [
	"Every turn of yours ends in one of three ways:",
	"- a message: your answer as text;",
	"- a reaction: your whole answer is one emoji, e.g. 👍 ❤️ 🔥 🙏 👌. The " +
		"user's message gets it as a reaction and no message is sent. Use it " +
		"when their message needs no words back, e.g. thanks or an okay;",
	`- nothing: your whole answer is exactly ${NO_REPLY} and nothing reaches ` +
		"the user. Use it only for scheduled prompts that leave nothing worth " +
		"telling them.",
].join("\n");

export const EndingsExtension = defineExtension({
	name: "endings",
	sections: [section("endings", () => ENDINGS_INSTRUCTIONS)],
});
