// Wall-clock times ("YYYY-MM-DD HH:MM") in an IANA time zone, which the
// agent and the guard read and write, while the process may run in another
// one (UTC).

const parts = (time: number, timeZone: string) => {
	const values = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
			.formatToParts(new Date(time))
			.map((part) => [part.type, part.value]),
	);
	return values as Record<
		"year" | "month" | "day" | "hour" | "minute" | "second",
		string
	>;
};

export const toWall = (time: number, timeZone: string): string => {
	const { year, month, day, hour, minute } = parts(time, timeZone);
	return `${year}-${month}-${day} ${hour}:${minute}`;
};

// How far `timeZone` is ahead of UTC at `time`.
const offset = (time: number, timeZone: string): number => {
	const { year, month, day, hour, minute, second } = parts(time, timeZone);
	return (
		Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) -
		Math.floor(time / 1000) * 1000
	);
};

/** The moment of a wall-clock time, seconds optional; `NaN` for anything else. */
export const fromWall = (wall: string, timeZone: string): number => {
	const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/.exec(
		wall.trim(),
	);
	if (!match) return Number.NaN;
	const utc = Date.parse(`${match[1]}T${match[2]}${match[3] ?? ":00"}Z`);
	if (Number.isNaN(utc)) return Number.NaN;
	// The offset at the guess is right except next to a DST change.
	const guess = utc - offset(utc, timeZone);
	const time = utc - offset(guess, timeZone);
	// Not a real date, e.g. 30 February.
	return toWall(time, timeZone).slice(0, 10) === match[1] ? time : Number.NaN;
};
