// The shape of OptMem's memory (github.com/VictorTaelin/OptMem), as pure math
// over leaf ids. Leaves, one line per past session, form an append-only log.
// A block is an aligned power-of-two range [lo, hi) of it, summarized into one
// line from the lines of its halves [lo, mid) and [mid, hi), so the blocks
// form a binary tree over the log.

export type Block = { lo: number; hi: number };

/** Longest leaf or summary, in UTF-8 bytes. */
export const ENTRY_BYTES = 280;

/** How many blocks of each size are summarized, keyed by size. */
export type Levels = Readonly<Record<string, number>>;

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** `#lo-hi` as the agent sees it: inclusive at both ends. */
export const formatBlock = ({ lo, hi }: Block): string =>
	hi - lo === 1 ? `#${lo}` : `#${lo}-${hi - 1}`;

/** Parses `lo-hi` (inclusive, optional `#`) into an aligned power-of-two block. */
export const parseBlock = (id: string): Block | undefined => {
	const match = /^#?(\d+)-(\d+)$/.exec(id.trim());
	if (!match) return undefined;
	const lo = Number(match[1]);
	const hi = Number(match[2]) + 1;
	const size = hi - lo;
	if (size < 2 || (size & (size - 1)) !== 0 || lo % size !== 0) {
		return undefined;
	}
	return { lo, hi };
};

/** Collapses whitespace and cuts `text` to one entry, on a character boundary. */
export const fitEntry = (text: string): string => {
	let line = text.replace(/\s+/g, " ").trim();
	while (byteLength(line) > ENTRY_BYTES) {
		line = `${[...line].slice(0, -2).join("").trimEnd()}…`;
	}
	return line;
};

// Tiles [0, count) with aligned power-of-two blocks, keeping a block whole iff
// its size is at most `alpha` times its age: detail decays with age.
const tile = (count: number, alpha: number): Block[] => {
	let root = 1;
	while (root < count) root *= 2;
	const out: Block[] = [];
	const stack: Block[] = [{ lo: 0, hi: root }];
	while (stack.length > 0) {
		const block = stack.pop() as Block;
		if (block.lo >= count) continue;
		const size = block.hi - block.lo;
		if (size > 1 && (block.hi > count || size > alpha * (count - block.lo))) {
			const mid = (block.lo + block.hi) / 2;
			stack.push({ lo: mid, hi: block.hi }, { lo: block.lo, hi: mid });
		} else {
			out.push(block);
		}
	}
	return out.sort((a, b) => a.lo - b.lo);
};

/**
 * At most `budget` blocks covering [0, count), oldest first: recent memories
 * stay verbatim, old ones collapse into summaries. Nothing is summarized when
 * every memory fits.
 */
export const cover = (count: number, budget: number): Block[] => {
	if (count <= budget) {
		return Array.from({ length: count }, (_, lo) => ({ lo, hi: lo + 1 }));
	}
	let low = 0;
	let high = 1;
	for (let step = 0; step < 60; step++) {
		const mid = (low + high) / 2;
		if (tile(count, mid).length > budget) low = mid;
		else high = mid;
	}
	const out = tile(count, high);
	// Sizes jump in powers of two, so lines may be left over: spend them on the
	// newest blocks, where detail is worth most.
	while (out.length < budget) {
		let index = -1;
		for (let i = out.length - 1; i >= 0; i--) {
			if (out[i].hi - out[i].lo > 1) {
				index = i;
				break;
			}
		}
		if (index < 0) break;
		const { lo, hi } = out[index];
		const mid = (lo + hi) / 2;
		out.splice(index, 1, { lo, hi: mid }, { lo: mid, hi });
	}
	return out;
};

/**
 * The next block to summarize, smallest first: each level holds a dense
 * prefix, so the next of a level is its count. Smallest first guarantees a
 * block's halves are summarized before it.
 */
export const nextPending = (
	count: number,
	levels: Levels,
): Block | undefined => {
	for (let size = 2; size <= count; size *= 2) {
		const done = levels[size] ?? 0;
		if (done < Math.floor(count / size)) {
			return { lo: done * size, hi: (done + 1) * size };
		}
	}
	return undefined;
};

export const isSummarized = (block: Block, levels: Levels): boolean =>
	block.lo / (block.hi - block.lo) < (levels[block.hi - block.lo] ?? 0);
