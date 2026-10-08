// How a fired prompt reaches the conversation, so the agent tells it from the
// user's own messages.
export const scheduledInput = (prompt: string): string =>
	`<scheduled>\n${prompt}\n</scheduled>`;

export const SCHEDULED_INSTRUCTIONS =
	"Prompts you scheduled (schedule_wakeup, cron_create) come back to you " +
	"wrapped in <scheduled>...</scheduled>; the user did not send them.";
