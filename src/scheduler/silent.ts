// A scheduled prompt often has nothing worth telling the user (a check that
// found nothing). The agent then answers with just this marker, and channels
// deliver nothing for it.
export const NO_REPLY = "NO_REPLY";

// Tolerates the quotes, emphasis and punctuation models wrap it in.
const silent = new RegExp(`^[\\s"'\`*_.!]*${NO_REPLY}[\\s"'\`*_.!]*$`);

/** Whether a final response is the marker alone: nothing to deliver. */
export const isSilentReply = (text: string): boolean => silent.test(text);

// How a fired prompt reaches the conversation, so the agent tells it from the
// user's own messages.
export const scheduledInput = (prompt: string): string =>
	`<scheduled>\n${prompt}\n</scheduled>`;

export const SCHEDULED_INSTRUCTIONS =
	"Prompts you scheduled (schedule_wakeup, cron_create) come back to you " +
	"wrapped in <scheduled>...</scheduled>; the user did not send them. When " +
	"one leaves nothing worth telling the user, end your turn with exactly " +
	`${NO_REPLY} and nothing reaches them. Use ${NO_REPLY} only for those turns.`;
