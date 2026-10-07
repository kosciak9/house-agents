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

## License

MIT
