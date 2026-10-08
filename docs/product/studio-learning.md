# Studio and learning

## The Studio workspace

Studio pairs a separate assistant conversation with Activity. Its assistant explains Studio
state using a bounded view of settings, projects, recent activity and proposals. It is tool-free: chatting here does not
commission a project or grant authority to mutate the harness. It points to waiting suggestions,
never its own. **How it works**, beside its title, explains the loop.

Its composer offers text, images, its own model and effort, and Send/Stop; no project roles, Loop
or tools. Its first message points projects to their own chats; example questions follow. Its own records
appear in Activity, not here.

## Activity and review

Activity orders pending suggestions, **Recent runs**, then **What Harness has learned**.
Restores, restarts and app updates are omitted. The host restores a failed harness update;
failed recovery offers **Reset harness to shipped version** or Quit. Run rows show the project,
request and outcome; expanding shows captures, Play build and Open project chat. Checks stay in
Builds. Empty Activity offers **Start building** or **New project**.
Timed runs start from the project composer's Mode menu; settings live in **Settings → Harness**.

## Learning and instructions

Learning starts on; **Apply suggestions automatically** starts off on fresh installs. The switch
in Activity's header turns all learning on or off. Harness's edits to itself are listed there,
each undoable.
Off, Harness learns nothing new: no review after a run, suggestions, project lessons, recipe
statistics or automatic apply. What it learned stays in use and can be undone; waiting
suggestions can still be applied or discarded. Runs are still recorded.

The installed project-building harness can learn from run evidence and propose reusable changes
to its instructions. Proposed changes, applied changes, checked changes and project-quality
results are distinct. A learning count does not certify a better project. A project chat shows one
plain line about what Harness learned from that build, with **Review in Harness**.

Each proposal carries a plain title and summary written for someone who never reads the
instruction files; older proposals fall back to naming what they change. Suggestions are
included by a check mark and applied or discarded together; the file, the proposer's notes and
the diff (wrapped, with context) stay behind **See the exact edit**, or show directly when the row
has nothing else. Missing plain words are asked for once more. Applied changes say who let them land and keep
their diff and **Undo this change**, which takes back that change alone; later changes and what
Harness learned about each project stay. A suggestion written against instructions that have since
changed is applied on top of them when it still fits, and refused when it does not. **Look for
improvements** appears once runs exist, reviews recent builds and shows the result on the button
(Found, Added or Nothing new). **Settings → Harness** owns automatic application, **Maximum concurrent workers**
(default eight, up to twelve) and **How suggestions are tested**.
Changes land through validated, recoverable host APIs, never by executing a chat reply. The
agent's own edits carry a plain title and summary too.
Code changes are type-checked and started in a copy first; a failing one is refused.

App updates keep the installed harness's edits and report their changes.

## Where to work

[ReviewPanel](../../src/renderer/panels/ReviewPanel.tsx) owns Activity;
[ChatPanel](../../src/renderer/panels/ChatPanel.tsx) handles the separate Studio conversation.
[Harness runtime](../harness-runtime.md) describes the installed runtime and learning boundaries.
Search [Architecture](../agent/architecture.md) for Studio, proposals or host persistence.
[Design](../agent/design.md#studio-hierarchy-and-progressive-disclosure) owns the shared visual hierarchy.
