import type { UsageState } from "@earendil-works/pi-durable";

import { addUsage, emptyUsage } from "../agent/usage.ts";

const tokens = (value: number): string => value.toLocaleString("pl-PL");
const dollars = (value: number): string => `$${value.toFixed(6)}`;

/** Costs are summed per request by pi-ai, including its context-price tiers. */
export const usageText = (state: UsageState, current: boolean): string => {
	const total = emptyUsage();
	const unpriced: string[] = [];
	for (const [name, usage] of [
		...Object.entries(state.models),
		...Object.entries(state.tools),
	]) {
		addUsage(total, usage);
		if (usage.totalTokens > 0 && usage.cost.total === 0) unpriced.push(name);
	}
	return [
		current
			? "Bieżąca sesja — od ostatniego /compact"
			: "Całkowite zużycie agenta",
		"Agent, subagenci i obsługa pamięci.",
		"",
		`Input: ${tokens(total.input)} tokenów · ${dollars(total.cost.input)}`,
		`Output: ${tokens(total.output)} tokenów · ${dollars(total.cost.output)}`,
		`Cache read: ${tokens(total.cacheRead)} tokenów · ${dollars(total.cost.cacheRead)}`,
		`Cache write: ${tokens(total.cacheWrite)} tokenów · ${dollars(total.cost.cacheWrite)}`,
		`Razem: ${tokens(total.totalTokens)} tokenów`,
		`Koszt szacunkowy (USD): ${dollars(total.cost.total)}${unpriced.length > 0 ? " (niepełny)" : ""}`,
		...(unpriced.length > 0
			? [
					`Brak wyceny: ${unpriced.join(", ")}. Nie oznacza to darmowego użycia.`,
				]
			: []),
		"",
		"Szacunek według stawek w definicjach modeli, nie rachunek za abonament.",
		"Wywołania pamięci w tle są liczone od wdrożenia Diagnostics usage.",
	].join("\n");
};
