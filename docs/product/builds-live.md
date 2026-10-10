# Builds and Live

## From a request to a project

Auto edits directly; Loop can delegate workers while the chat leads and reviews. Timed builds
use their working window. Until-satisfied builds finish on verified required
outcomes; time is a safety ceiling. Acceptance persists across workers and restarts. External
blockers pause the run, keeping its checkpoint. User Finish overrides the clock, never the
final judge. Maximum concurrent workers defaults to eight; saved choices stay. [Harness runtime](../harness-runtime.md#goal-completion-and-worker-approvals)
owns completion and recovery details.

An active run opens Builds once; later tab choices are the user's, except that showing a
build from the chat opens Live. Without a plan or run, a stored Builds
choice falls back to Live. A file or image opened from the chat adds a tab named for it until
closed, with Show in Finder for files in the project folder.

## The two views

**Live** runs the browser project in a native view (WebGL and WebGPU); hidden unobserved previews
pause. The strip holds Live/Builds/Assets, Run/Stop, Reload, the sound switch (⌥⌘M; only a shown
Live in front is heard), Full screen (hold Esc to leave) and plugin actions such as Publish (accent
until listed). Stop halts the project until Run or Reload. Slow loads show a halftone loader and
shimmering “Loading project”. An empty scaffold shows “Ready for your first idea” (a computer), or
“Building your project” (a crane) with Watch progress while a run works, Open latest once a build is
ready; the first healthy build then shows itself. Otherwise only the user changes Live (opening a
project, Reload, Open, Make live, a chat request while Live is hidden). A newer healthy build, a
changed project folder (checkpoint, landing, rewind), a chat's show or landing, or a shown build found
broken lights Reload (accent dot, a tooltip naming it), which brings it in. While Live is hidden and
not stopped, all but a new build go in at once. A loaded page alone is not a successful build. The
preview reaches only public library CDNs; Open Project names other hosts.

**Builds** is a graph: You asked, a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node; what reached the build forms the line, the rest
hangs below. An eye marks nodes the reviewers looked at. A new build is “Checking it starts…” until
it has run. Its header shows only time worked. A working node shows its agent's screen and action (“Pressing Space · 3s”). A selected
node opens in place as a card without zooming; an eye opens it on the reviewers' notes. **Follow up in chat** turns the next message into a note to that node's build.
An earlier build opens from its chat card.

The agent tests the project in hidden windows, never in Live. Chat reuses
the lead's frames, which never certify a delivered build. A worker finishing, checks passing,
integration and Live showing a revision are distinct facts; summaries never merge them into
unearned success. Chat shows the delivery's capture and Open and keeps failures visible; Builds
and Studio report missing checks, coverage limits, counts and revisions.

## Continuation and interruption

After a chat-led night, its session takes follow-ups: editing the project, resuming a paused run
with its time left, starting over only when asked. With Loop on, a small change is made directly;
more work reopens the build until checked. One the chat cannot continue, like Ollama's, is answered
as with Loop off, noting it once. **Stop** interrupts work immediately, preserving finished
work; a stopped Loop run shows one Stopped line with Resume, and Builds or a chat request makes its
build live. A crash or restart settles abandoned activity from persisted state; stopped, failed,
incomplete and delivered outcomes stay distinct.

## Where to work

- [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx) selects the stage;
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx) manages Live/Builds/Assets.
- [run-steps](../../src/renderer/run-steps.ts) folds steps; [RunGraph](../../src/renderer/panels/RunGraph.tsx)
  and [RunInspector](../../src/renderer/panels/RunInspector.tsx) draw them.
- [Conversation coordinator](../conversation-coordinator.md): queue, continuation and Stop.
- [Harness runtime](../harness-runtime.md): installed project-building agent boundaries.
- Check [Architecture](../agent/architecture.md) and [Verification](../agent/verification.md)
  before changing a run, preview or recovery contract.
