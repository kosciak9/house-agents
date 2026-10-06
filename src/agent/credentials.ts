import fs from "node:fs/promises";
import path from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

import { config, stateFile } from "../config.ts";

// E2E keeps it outside its throwaway state, so tests sign in with the real
// accounts; the login test points it at its own file instead.
const CREDENTIALS_FILE = config().credentialsFile ?? stateFile("auth.json");

type Credentials = Record<string, Credential>;

const isMissingFile = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ENOENT";

const readAll = async (): Promise<Credentials> => {
	try {
		return JSON.parse(await fs.readFile(CREDENTIALS_FILE, "utf8"));
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw error;
	}
};

const writeAll = async (data: Credentials): Promise<void> => {
	await fs.mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
	await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(data, null, 2), {
		mode: 0o600,
	});
};

const withProvider = (
	data: Credentials,
	provider: string,
	credential: Credential | undefined,
): Credentials => {
	const { [provider]: _removed, ...rest } = data;
	return credential === undefined ? rest : { ...rest, [provider]: credential };
};

export const credentials: CredentialStore = {
	read: async (provider) => (await readAll())[provider],

	modify: async (provider, fn) => {
		const data = await readAll();
		const next = await fn(data[provider]);
		await writeAll(withProvider(data, provider, next));
		return next;
	},

	delete: async (provider) => {
		await writeAll(withProvider(await readAll(), provider, undefined));
	},

	list: async () =>
		Object.entries(await readAll()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		})),
};
