# house-agents

A house assistant for one person, talking through Telegram.

There is one user and one conversation, kept forever: the bot serves a single
chat and never starts another thread. Everything happens in that thread —
text, photos and voice notes in, replies out — and the assistant remembers
what matters from it long after the context is reset.

It is built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable),
which keeps the conversation durable across restarts. On top of it:

- scheduled wake-ups, one-off and recurring, that come back into the same
  conversation;
- long-term memory beyond a single context;
- voice notes transcribed with Whisper;
- tools from MCP servers, each agent allowed only the ones it is given;
- subagents that take tasks in the background and report back to the thread.

Telegram is an adapter at the edge; the core does not depend on it.

## Container

The image (`Containerfile`) runs the agent in `/data` as the `node` user
(uid 1000). It takes:

- `/data/house-agents.config.ts`: the `Config` (`src/config.ts`) as its
  default export. It is read once at start, so it can be mounted read-only;
  it may import types only, as nothing else resolves from there.
- `/data/state`: everything the agent keeps. Mount a volume here; the image
  creates the directory owned by `node`, so a new named volume starts
  writable.
- The environment: `TELEGRAM_BOT_TOKEN`, plus whatever secrets the config
  reads from `process.env` itself.

```sh
podman run -d --name house-agents \
  --env-file agent.env \
  -v ./house-agents.config.ts:/data/house-agents.config.ts:ro \
  -v house-agents-state:/data/state \
  ghcr.io/<owner>/house-agents:latest
```

MCP servers started over stdio run inside the container, which is Alpine
(musl) with only Node (`npx` included); anything else, or anything built
for glibc, is better reached by `url`. The Whisper endpoint and those URLs
must be reachable from the container.

### What to keep

All of it is in `/data/state`:

| File | What it holds | If lost |
| --- | --- | --- |
| `session.sqlite` (with `-wal`, `-shm`) | The conversation, long-term memory, schedules and wake-ups | Everything the agent knows and has planned |
| `auth.json` | Model provider logins (`/login`) | Log in again |
| `mcp-oauth.json` | MCP servers' OAuth tokens (`/mcp_login`) | Log in to them again |

Back up the whole directory. The database is in WAL mode, so copy it while
the container is stopped, or with `sqlite3 session.sqlite ".backup …"`
while it runs. The two JSON files hold credentials; keep backups of them as
private as the secrets in the environment.

## License

MIT
