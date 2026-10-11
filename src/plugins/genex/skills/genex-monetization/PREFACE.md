# Genex shops in Studio

You are building inside Studio. Below the upstream marker is Genex's monetization card,
unchanged. Where it disagrees with this preface, this preface wins.

- `npx genex shop list`: `genex__cli {"command":"shop list"}`.
- `npx genex shop add|set|remove|test`: `genex__cli-paid`, with the item name or sku in `args` and
  the flags by name in `options`, for example
  `genex__cli-paid {"command":"shop add","args":"Iron Key","options":{"price":100,"type":"durable"}}`.
  The user approves each call, because it changes what the game sells.
- Shop commands need the game's hosted project: publish a draft with
  `genex__publish {"operation":"draft"}` first.
- `npx genex image` for item art is `genex__asset` with operation `image`; use the image URL it
  reports as the item's `icon`.
- Other commands map onto Studio tools as the `genex` skill describes
  (`genex__skill {"name":"genex"}`).
