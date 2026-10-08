# Workspace and projects

## What the user sees

The sidebar contains Search, Notifications, New project, Plugins, Harness, Settings, the Projects
library and, once an update waits, **Relaunch to update** (Linux: **Download**); only projects
scroll. Pinned projects come first, then recent activity. Every launch opens **home** (also the wordmark): nothing
selected, one composer over an optional dithered picture. A project opens its conversation beside
the stage (Live, Builds once planned, Assets); Harness opens its conversation and Activity;
Plugins fills the workspace.

Settings is a modal: Model Providers, Local Models, Appearance, Projects, Harness, Permissions,
Privacy and About. Narrow windows use a drawer; wide ones remember the sidebar.

The bell keeps questions, plans and permission requests until answered, then build endings and
sign-outs; a count marks waiting work, a dot unread news. Rows open where the answer lives;
unfocused, macOS notifications and the Dock badge carry them.

## First launch

An empty, never-welcomed profile opens a full-window welcome: a prompt plays through Plan your
project, Build with workers and Reviewers test it, then Claude Code, ChatGPT or a local model connects. Skip or
Start building opens home; a typed idea waits in its composer.

Then a bottom-right Genex Tools card offers **Connect Genex plugin** once.

If the process sandbox cannot start, the window shows **Set up the protected workspace**: what
is missing, commands to copy, Retry.

## Main actions

- **Home's first message** starts a project the model names, where the chip says; duplicates
  never overwrite projects. A greeting stays **Untitled project** until an idea. **New project**, the Projects **+** and Command-N open home.
- **Settings → Projects** moves new projects to another empty folder (default `~/AI Projects`).
- **Settings → Privacy**: Share build metrics (off by default), See what would be sent and
  Delete what I shared ([PRIVACY](../../PRIVACY.md)).
- Home's **Open a folder…** inspects a folder before anything is written; the sheet trusts its
  Claude settings and hooks unless switched off.
- A project's menu offers Rename, Pin/Unpin, Change image and Delete. Renaming changes the
  title, not the folder. Delete removes the library entry, keeping files and history; active
  work blocks it; reopening its folder restores it.
- The chat header shows the title, Show in Finder, Terminal and ⋯ (Export project…, Rename);
  Harness and unbound drafts have no Export. Search reaches older and unbound chats.
- Command-B toggles navigation; Command-K searches; Command-2 opens Harness; Command-1
  returns to the last project chat.

## State and appearance

A project's folder owns its identity. Rollback first snapshots adopted folders and refuses changed
branches, commits or merges. External chat links open project documents/media; executables appear
in Finder. Snapshots and links use raw bytes, Git hooks and filters off; LFS pointers stay
pointers. [Design](../agent/design.md#studio-hierarchy-and-progressive-disclosure)
covers sphere/uploaded covers. Unsent text survives loading; hidden workspaces ignore keys.

The live project is a native view outside React: drawers, dialogs, Plugins, Builds, Assets and the
Genex card occlude it; a desktop capture cannot prove the project works.

## Where to work

- [Shell](../../src/renderer/shell): navigation, [home](../../src/renderer/shell/HomeScreen.tsx),
  selected conversation, stage and the [notification feed](../../src/renderer/notifications.ts).
- [Onboarding](../../src/renderer/onboarding/Onboarding.tsx): first launch.
- [Chat header](../../src/renderer/panels/ChatHeader.tsx) and
  [Settings](../../src/renderer/panels/SettingsDialog.tsx): workspace actions.
- [Architecture](../agent/architecture.md) covers library persistence, the native preview and
  boot state; the [Feature Map](../agent/feature-map.md) lists selectors and checks.
