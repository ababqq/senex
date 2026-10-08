# Security policy

Genex runs AI agents, native plugin code and an agent-editable harness on your Mac, so
we treat sandbox and trust bugs as serious even in pre-release.

## Reporting a vulnerability

Email [team@genex.games](mailto:team@genex.games) with the subject “Genex security report”.
If GitHub private reporting is enabled on the repository, you can also use its **Security** tab
and choose **Report a vulnerability**. Please do not open a public issue, pull request or
discussion for a suspected vulnerability. Do not include credentials or personal project files;
use a minimal reproduction with synthetic data.

Include what you found, the steps or a proof of concept, the commit or build you tested, and
the impact you expect. You will get an acknowledgement within a week. We will keep you updated
while we fix it, agree on disclosure timing with you, and credit you in the advisory unless you
ask us not to.

There is no bug bounty.

## Scope

In scope, on the current `dev` and `main` branches:

- **Sandbox escapes.** Anything that lets the in-app harness, a project build, a builder agent or a
  plugin backend write outside its allowed folders, read denied secret paths, or run a process
  outside `ProcessSandbox`.
- **Credential exposure.** Provider, Genex or plugin credentials reaching the renderer, the event
  log, logs, diagnostics, prompts, projects or another plugin.
- **Plugin and MCP trust.** Installing, updating, enabling or approving a plugin or MCP server
  without the confirmation the host promises; a catalog entry impersonating an official
  publisher; capability expansion without re-consent.
- **Renderer and preview isolation.** A project page or plugin panel reaching Node, Electron, main
  or preload APIs, or calling Studio beyond the named calls in `src/shared/studio-api.ts`.
- **Path and git safety.** Harness RPC path parameters escaping their owned root, or destructive
  git operations on a user's project folder without a snapshot.

Out of scope:

- Trusted native plugin code doing what native code can do: process isolation does not sandbox
  a plugin you chose to trust ([plugin host contract](docs/plugins.md)).
- Vulnerabilities in Claude Code, Codex, Ollama, Blender or Electron themselves; report those to
  their vendors. Studio's handling of them is in scope.
- Anything that needs an already compromised user account or Mac.
- Model output quality, prompt-injection that stays inside the documented sandbox, and denial of
  service by a local user against their own app.

## Supported versions

Only the latest `dev` and `main` are supported. There are no released builds yet.
