import type { Leaf } from "./store.ts";

// Who hears of each new line of memory, e.g. the chat; the memory itself
// depends on no channel.

let listener: ((leaf: Leaf) => void) | undefined;

export const onLeaf = (callback: (leaf: Leaf) => void): void => {
	listener = callback;
};

/** Called once the leaf is committed. */
export const announceLeaf = (leaf: Leaf): void => listener?.(leaf);
