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

- After every change: `pnpm check` (biome, tsc, and node/pnpm in the Containerfile
  and `packageManager` matching devenv: `pnpm versions`) and `pnpm e2e:smoke`
  (seconds). When the change touches a contract an E2E file covers, also that
  file: `pnpm e2e conversation` runs `e2e/conversation.test.ts`;
  `--grep <pattern>` filters test names.
- The full suite, `pnpm e2e` (a few minutes), runs rarely: before a merge to
  `main`.
- Run these as they are, in the foreground: no redirects, `grep`, `tail` or
  extra shells. The output is one line per test, why each failure failed, and
  the output of the bot behind each failing file; full logs go to
  `tmp/e2e/<file>.log`. `E2E_VERBOSE=1` streams them live.
- Keep the suite short: every bot start and every real wait costs time. Add a
  step to an existing chain (`e2e/conversation.test.ts` is one conversation
  from start to /compact) rather than a new file, and never test the same
  contract twice.
- Every checkout shares one test bot: a run waits for another to finish
  (`state/e2e.lock`). Stop `pnpm dev` first; two processes on one bot token
  conflict (`409: Conflict` in the bot output).
- No unit or mocked tests: E2E drives the real bot in Telegram's test environment
  (`e2e/bot.ts` starts it on an empty session per test).
- Never change a test only to make it pass; tests describe user-facing contracts.

## Config and env

The only deployment is wave-os, in two copies (two agents). It configures each
with a `Config` (`src/config.ts`): passed to `startAgent(config)` from
`src/index.ts`, or else the default export of `house-agents.config.ts`
(gitignored) in the working directory, which `src/main.ts` and `pnpm dev` use.
New options go there, not into new environment variables. E2E runs the agent
through `e2e/agent.ts`.

Secrets stay in the environment: variables live in `.env` (gitignored, loaded by
scripts); never read or print it. First E2E setup: `pnpm e2e:login`.

## Commits

Conventional Commits.
