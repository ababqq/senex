# Genex publishing in Studio

You are building inside Studio. Below the upstream marker is Genex's publishing card,
unchanged. Where it disagrees with this preface, this preface wins.

- Publishing is one step: `genex__publish {"operation":"gallery"}` exports the game, updates its
  draft page and makes that same build the public version (`npx genex publish` the first time,
  `preview` then `promote` after). Use it when the user wants the game published or online.
  `npx genex preview` alone is `genex__publish {"operation":"draft"}`: an unlisted test build that
  leaves the public version as it is. Each asks the user first and returns a job: follow it with
  `genex__publish-status {"operation":"wait","jobId":"<jobId>"}`, then give the user the operation’s
  reported link verbatim: `galleryUrl` for a public release, `draftUrl` for a draft. Do not
  construct a URL or report a draft link as the public release. If the job has not succeeded,
  report its actual state rather than claiming publication.
- Studio exports and uploads the game itself. Glue step 3 (the CLI as a dev dependency) and
  `init --convert` do not apply, and `npx genex pull` is not available. Glue steps 1 and 2 still
  apply; for step 2 read `genex__skill {"name":"genex-threejs-embed-auth"}`.
- The preflight lines arrive in `genex__publish-status` as warnings. Treat them as the card says.
- `npx genex doctor` is `genex__cli {"command":"doctor"}`. Other commands map onto Studio tools as
  the `genex` skill describes (`genex__skill {"name":"genex"}`).
