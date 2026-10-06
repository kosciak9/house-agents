// Logs the test user in on Telegram's test DC (TDLib asks for the phone
// number, code and password in the console) and prints the values to store as
// secrets. Usage: pnpm e2e:login
import {
	createTestUserClient,
	LOCAL_DATABASE_DIR,
	packSession,
} from "./client.ts";

const client = createTestUserClient(LOCAL_DATABASE_DIR);
await client.login();

const me = await client.invoke({ _: "getMe" });
// Closing flushes the session to disk before it is packed.
await client.close();

console.log("\nStore these as secrets:");
console.log(`TELEGRAM_E2E_SESSION=${packSession(LOCAL_DATABASE_DIR)}`);
console.log(`TELEGRAM_CHAT_ID=${me.id} # the bot's chat with this test user`);
