# AGENTS.md

House assistant on `@earendil-works/pi-durable`, talking through Telegram (grammY).

Single user, single thread, forever: there is exactly one conversation (the root).
Subagents may run in their own conversations, but they never replace that one
thread. Don't design for multiple users, chats or parallel threads.

## Code

- No classes: functions plus module singletons; feature folders in `src/`.
- pi-durable is the core; build around it following its architecture. Use its
  primitives (tasks, documents, inbox, `conversation.submit`) instead of parallel
  runtimes, stores or queues. Channels like Telegram are adapters at the edge;
  the core never depends on them.

## Verify

- After every change: `pnpm check` (biome + tsc) and `pnpm e2e:smoke`.
- After a larger set of changes: `pnpm e2e:test` (full E2E, several minutes,
  inside `devenv shell` for the voice test).
- One file or test: `pnpm e2e:test memory` (`e2e/memory.test.ts`), several
  names at once, `--grep <pattern>` for test names.
- Run these as they are: no redirects, `grep` or `tail` needed. The output is
  one line per test, why each failure failed, and the output of the bot behind
  each failing file; full logs go to `tmp/e2e/<file>.log`. `E2E_VERBOSE=1`
  streams them live.
- Every checkout shares one test bot: a run waits for another to finish
  (`state/e2e.lock`). Stop `pnpm dev` first; two processes on one bot token
  conflict (`409: Conflict` in the bot output).
- No unit or mocked tests: E2E drives the real bot in Telegram's test environment
  (`e2e/bot.ts` starts it on an empty session per test).
- Never change a test only to make it pass; tests describe user-facing contracts.

## Env

Variables live in `.env` (gitignored, loaded by scripts); never read or print it.
First E2E setup: `pnpm e2e:login`.

## Commits

Conventional Commits.
