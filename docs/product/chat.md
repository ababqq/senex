# Chat and questions

## What the user sees

Each project has one conversation. User messages are soft right-aligned bubbles, their images
above; long ones fold with Show more/Show less. Replies are Markdown prose. Any file the chat
names that exists is a link: project Markdown and images open beside the chat, others in their app
(programs only shown). Empty chat is blank. Only the prompt bar writes and sends; a pasted image
adds the picture, not its file name.

The chat's own work shows a short truthful status, its elapsed time beside it; waiting for an
answer is static. A running build is not the chat working: it is one card
(time used of its hours, what happens now, Builds), nothing under it. No duplicate Stop
controls or narration.

Neighboring tools group under a muted **Worked on N steps** disclosure of truncated rows;
failures stay visible. Delivered assets are previews that open on click, with Open in
Assets on hover. Build updates use a short status and See it;
a finished build is that card with Open; it opens Builds; checks stay in Builds and Studio.
What Studio learned is one line with **Review in Studio**; builds that taught nothing add none.
The [design specification](../agent/design.md#chat-reading-and-activity) owns exact values.

## Questions and plans

Replies get current plugin, account, MCP and template facts each turn; asking about plugins
never resumes a build.

- A real `ask_user` question opens the question panel: options plus a typed-answer row. Choosing alone does not submit; Send answer confirms. Chat about this puts it aside
  for the composer; any reply settles it. Progress is never a question; an unsaid project or look
  before a build is.
- Permission requests need an explicit answer and stay pinned above the composer, even with
  their page unloaded. Worker plugin questions appear in the owning run’s conversation,
  cancelled with their worker. Plugins ask Approve or Decline; Claude asks **Allow**, the grant it offers
  (**Always allow …**) or **Deny**, or takes words instead; a plan leaving Plan is approved
  into a mode. Stop, the turn's end or a restart withdraws one.
- A project reply's one-line `bash` block offers **Run** and **Copy**; output shows below and
  reaches the agent unseen, reopening no build.
- **Plan mode** (Add's bulb) is a one-message choice: the plan is Markdown with **Approve**,
  **Make changes** and **Cancel**; only Approve starts it, and a revision needs fresh approval.
  Failed generation offers Choose model, Model providers, Try again and Dismiss.

## Sending, waiting and history

A sent message shows at once: in an idle chat as the next bubble, **Sending** until saved.
While the chat works it joins that turn, **Sending…** until the agent reads it, then sits where
it was read. During a build the same session leads it, takes it at once and answers here, as after it.
Otherwise (a picture, another model) it waits as **Queued** with Remove, then moves in. During work, a
sendable draft shows Send; otherwise the same action becomes Stop, and the status reads
Stopping until the work ends; after five seconds Stop works again. Stop hands over to
the oldest queued message; the stopped build then shows only its result, else Stopped once, with
Resume. A message cut off by a quit is retried once, then left for the user to resend.

**Rewind** sits beside every sent bubble (on hover or focus) unless the chat answers; a running
build stops first, cutting off any answer under way. That message and all after it leave the
chat and model context (the log keeps them); the next answer starts a fresh session; the message
returns to the composer with its pictures and waiting follow-ups. **Restore project files** returns
the folder to its checkpoint before that message, off at first if files changed outside the
chat; otherwise one line says why only the conversation rewinds.

History is paged and windowed; media loads lazily. Streamed replies grow smoothly
and stay until saved. Reading older messages stops following live output.

## Where to work

[ChatPanel](../../src/renderer/panels/ChatPanel.tsx) feeds the transcript,
[chat components](../../src/renderer/chat) draw it and
[PromptBar](../../src/renderer/ui/PromptBar.tsx) owns writing.
Queue and session internals: [conversation coordinator](../conversation-coordinator.md); workers
and build results: [Builds and Live](builds-live.md).
