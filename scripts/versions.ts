// Node and pnpm in the image must be the ones devenv gives (`node` and `pnpm`
// on PATH in its shell), and pnpm the one `packageManager` names.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const containerfile = readFileSync("Containerfile", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

const versions = {
	node: {
		devenv: execFileSync("node", ["--version"], { encoding: "utf8" })
			.trim()
			.replace(/^v/, ""),
		Containerfile: [...containerfile.matchAll(/node:(\S+?)-slim@/g)].map(
			(match) => match[1],
		),
	},
	pnpm: {
		devenv: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
		Containerfile: [...containerfile.matchAll(/pnpm-(\S+?)\.tgz/g)].map(
			(match) => match[1],
		),
		packageManager: [packageJson.packageManager?.replace(/^pnpm@/, "")],
	},
};

let drift = false;
for (const [tool, { devenv, ...others }] of Object.entries(versions)) {
	for (const [where, found] of Object.entries(others)) {
		if (found.length > 0 && found.every((version) => version === devenv)) {
			continue;
		}
		drift = true;
		console.error(
			`${tool}: devenv has ${devenv}, ${where} has ${found.join(", ") || "none"}`,
		);
	}
}
if (drift) process.exit(1);
console.log(`node ${versions.node.devenv}, pnpm ${versions.pnpm.devenv}`);
