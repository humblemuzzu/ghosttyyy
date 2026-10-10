import { cacheHit, cacheSavings, type Dataset, type Summary } from "./aggregate";
import { compact, duration, int, money, pct } from "./draw";
import { A, T, U } from "./parse";
import { modelLabel } from "./widgets";

function tableMd(head: string[], rows: string[][]): string[] {
	return [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)];
}

/** The range as plain markdown, for `/stats export` and non-interactive runs. */
export function markdownReport(ds: Dataset, s: Summary): string {
	const save = cacheSavings(s.models);
	const calls = [...s.tools.values()].reduce((a, t) => a + t[T.calls], 0);
	const lines = [
		`# pi stats · ${s.label}`,
		"",
		`${s.days[0]} → ${s.days[s.days.length - 1]} · generated ${new Date(ds.generatedAt).toLocaleString("en-US")}`,
		"",
		...tableMd(["", ""], [
			["Cost (API prices)", `${money(s.cost)} (main ${money(s.usage[U.cost])}, agents ${money(s.agentTotal[A.cost])})`],
			["Tokens", `${compact(s.tokens)} (cache read ${compact(s.usage[U.cacheRead] + s.agentTotal[A.cacheRead])}, output ${compact(s.usage[U.output] + s.agentTotal[A.output])})`],
			["Cache hit (main sessions)", `${pct(cacheHit(s.usage))}, net saved ${money(save.saved - save.premium)}`],
			["Cache busts", `${int(s.usage[U.busts])} (${int(s.usage[U.idleBusts])} idle), rewrites ${money(s.usage[U.bustCost])}`],
			["Active days", `${s.activeDays} of ${s.days.length}`],
			["Sessions / prompts / turns", `${int(s.sessions.length)} / ${int(s.prompts)} / ${int(s.usage[U.turns])}`],
			["Time with pi", duration(s.activeMs)],
			["Agent runs", `${int(s.agentTotal[A.runs])}, ${int(s.agentTotal[A.turns])} turns`],
			["Tool calls", `${int(calls)}`],
			["Commits", `${int(s.commits.length)} (${int(s.piCommits)} with pi)`],
			["Streak", `${ds.lifetime.currentStreak} days (best ${ds.lifetime.longestStreak})`],
		]),
		"",
		"## Models",
		"",
		...tableMd(["Model", "Cost", "Turns", "Cache hit"], [...s.models].sort((a, b) => b[1][U.cost] - a[1][U.cost]).slice(0, 12).map(([k, u]) => [modelLabel(k), money(u[U.cost]), int(u[U.turns]), pct(cacheHit(u))])),
		"",
		"## Agents",
		"",
		...tableMd(["Agent", "Runs", "Cost", "Turns"], [...s.agents].sort((a, b) => b[1][A.cost] - a[1][A.cost]).map(([k, a]) => [k, int(a[A.runs]), money(a[A.cost]), int(a[A.turns])])),
		"",
		"## Projects",
		"",
		...tableMd(["Project", "Cost", "Sessions", "Commits", "With pi"], s.projects.slice(0, 15).map((p) => [p.name, money(p.cost), int(p.sessions), int(p.commits), int(p.piCommits)])),
		"",
	];
	return lines.join("\n");
}
