import type { Leaf } from "./store.ts";

// Who hears of the lines of memory each session leaves, e.g. the chat; the
// memory itself depends on no channel.

let listener: ((leaves: readonly Leaf[]) => void) | undefined;

export const onSession = (
	callback: (leaves: readonly Leaf[]) => void,
): void => {
	listener = callback;
};

/** Called once the lines of a session are committed. */
export const announceSession = (leaves: readonly Leaf[]): void =>
	listener?.(leaves);
