# Genex player identity in Studio

You are building inside Studio. Below the upstream marker is Genex's embed-auth card,
unchanged. Where it disagrees with this preface, this preface wins.

## Where each part can be tested

- Studio's preview opens a game that uses `@genex-ai/embed-sdk` in local test mode
  (`?genex_local_test=1`) for you. Rendering, controls, HUD and feel can be checked there.
  Sign-in, saves, leaderboards and multiplayer cannot: that is expected, not a bug to chase.
- The owner can try sign-in and multiplayer on the published Genex draft: build the game, add the
  package with `genex__package {"package":"@genex-ai/embed-sdk"}`, publish a draft with
  `genex__publish {"operation":"draft"}`, wait with `genex__publish-status`, then hand the draft
  link to the user. Label your evidence as the card asks.
- Server saves never persist on the draft: loads and saves resolve `{ staging: true }` there by
  design, as the card says. They persist only once the game is published to the gallery, which
  happens only when the user wants it public. Keep the card's localStorage fallback.
- Studio installs the version it pins. Never run `npm i` for this package yourself.
- A game made from Studio's template has no `package.json` (it loads three.js through an import
  map), so it cannot add the SDK. Tell the user player identity needs a game with its own package
  manager and build; never copy the SDK into the game by hand.

## Config without `genex init`

Studio never runs `genex init`, so the game starts without `src/genex.config.ts` or `.env`, and
"re-run `genex init`" is not available. After the first draft, `genex__publish-status` reports the
game's `slug`. Write the config yourself, then publish a new draft:

```ts
// src/genex.config.ts
export const GENEX = {
  slug: "<the slug genex__publish-status reported>",
  apiUrl: "https://api.genex.games",
  dashboardOrigins: ["https://genex.games"],
} as const;
```

## Commands

`genex preview` is `genex__publish {"operation":"draft"}`, and the update nudge the card mentions
does not apply: Studio pins its Genex packages. Other commands map onto Studio tools as the
`genex` skill describes (`genex__skill {"name":"genex"}`).
