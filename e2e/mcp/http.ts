import { spawn } from "node:child_process";

/** How the bot starts the test MCP server (`server.ts`) itself, over stdio. */
export const STDIO_SERVER = {
	command: process.execPath,
	args: ["--import", "tsx", "e2e/mcp/server.ts", "stdio"],
};

export type RunningMcpServer = {
	url: string;
	stop: () => void;
};

/** Runs the test MCP server over HTTP in its own process; see `server.ts`. */
export const startHttpMcpServer = (
	env: Record<string, string>,
): Promise<RunningMcpServer> => {
	const child = spawn(
		process.execPath,
		["--import", "tsx", "e2e/mcp/server.ts", "http"],
		{ env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] },
	);

	return new Promise((resolve, reject) => {
		child.stdout.on("data", (chunk: Buffer) => {
			const port = /listening on (\d+)/.exec(chunk.toString())?.[1];
			if (!port) return;
			resolve({
				url: `http://127.0.0.1:${port}/mcp`,
				stop: () => child.kill(),
			});
		});
		child.once("exit", (code) =>
			reject(new Error(`MCP server exited (${code})`)),
		);
	});
};
