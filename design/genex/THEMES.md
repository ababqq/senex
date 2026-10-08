# Appearance palettes and interchange

Settings → Appearance owns the app's colors. The renderer applies one semantic palette to
`html`, including all portals, before React mounts. `appearance/themes.ts` defines the pure
model; `appearance/store.ts` persists it under `studio.appearance.v1` in the current Electron
profile. New profiles start in Genex Dark; saved mode/preset choices remain authoritative.
System mode responds to macOS color-scheme changes; explicit Light/Dark ignores them.
The selected light and dark presets, overrides and contrast are independent. Typography is
shared across modes. Defaults and Reset never erase saved custom presets; Remove preset retains
its current colors as overrides. No appearance value changes a project, account or harness.

The five families have ten palettes: Genex, Tokyo Night (Night/Light), Catppuccin (Mocha/Latte),
Rosé Pine (Pine/Dawn), and GitHub (Dark/Light inspired). These are adapted UI palettes, not exact
editor ports. Every dark palette climbs one shared OKLCH lightness ramp from its canvas (sidebar
−2.6, surface +3, menu +4.8, field +6, hover +8.5, divider +5.6, control edge +11.2), so no theme
reads heavier than another; each family keeps its own canonical base, text and accent. Light
accents and status colors are chosen at ≥4.5:1 on every surface rather than left to correction.
Settings uses the app's own sidebar and canvas; other dialogs use the surface step; the menu color
is reserved for menus. Genex Dark uses near-black neutral surfaces, a darker sidebar and an indigo
accent for interactive emphasis. Its composer sits one surface step above the chat; menus,
fields and hover fills continue that neutral ramp. Color is reserved for actions, selection
and status. The color
roles separate canvas, cards, sidebar, floating menus, fields, hover, dividers, control borders,
text, secondary text, accent and three statuses. Optional detail roles set the accent button's
fill, hover and label, the quiet icon colour, the wordmark's colour and shade, the prompt bar's edge,
the Live/Assets switch, the empty-state art, the stage's stripes and their ground, the Builds graph's accent, chip and hover fills and their text, the picker's selector
track and selected segment and its meter colours, and a preset may give the composer menus, the
prompt bar and the selected segment their own shadow; left unset, the app derives each (the fill from the
accent, darkened in OKLCH until white reads 5:1; icons keep each place's own muted ink). Every
dark preset has a distinct sidebar and canvas; Genex Light's sidebar matches its canvas and carries a near-black wordmark shading into navy.
Separators stay quiet; fields use soft control edges. Labeled buttons use a fill without a border.
At default contrast, configured control-border values are applied literally rather than brightened.
Higher contrast remains an explicit user choice. Derived layers mix in Oklab through Chromium's native `color-mix`, keeping the
existing hex token vocabulary and avoiding another color dependency.

Every colour is drawn exactly as the palette sets it: the palette's author owns readability, and
the developer colour tweaker (hidden in code between tuning sessions; see
[the design workflow](../../docs/agent/design.md)) shows each role's WCAG contrast where it is drawn. Every built-in
preset keeps body text at ≥4.5:1; the ported families also keep secondary text, accents, statuses
and button labels there (`appearance.test.ts`). Genex's own presets are tuned by hand in the
tweaker beyond body text (Genex Light's muted `#a0a1a3` reads 2.0:1). Contrast adjusts divider and
control-edge strength; above 50 it also lifts secondary text past its own contrast, up to 2.5 more
at 100. Destructive fills choose black or white labels, and hover shifts the fill away from its
label luminance. Image outlines and the monochrome
wordmark adapt to the active scheme. Project imagery/media backdrops retain their intended colors.

## Genex Dark direction

The September 22 refinement followed the user's feedback that the navy palette was too blue; the
September 23 rework keeps it neutral (chroma .003) and moves every dark family onto the shared ramp
after Settings was reported lighter than the app. References, inspected September 22, 2026:

| Reference | Observed surface relationships | Genex application |
| --- | --- | --- |
| [VS Code Dark Modern](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_modern.json) | Neutral editor `#1f1f1f`, darker sidebar `#181818`, inputs `#313131`; blue is an action/selection accent. | Neutral canvas/sidebar/input anchors with quieter boundaries. |
| [One Dark Pro](https://github.com/Binaryify/OneDark-Pro/blob/master/themes/OneDark-Pro.json) | Editor `#282c34`, sidebar `#21252b`, hover `#2c313a`; secondary controls use subdued fills. | Navigation distinct from content, restrained status hues. |
| [Dracula](https://github.com/dracula/visual-studio-code/blob/master/src/dracula.yml) | Closely related dark surfaces (`#282a36` base) with separate selection and semantic colors. | A small surface family; the accent never fills large backgrounds. |

Genex Dark: sidebar `#0b0b0d` → chat `#0e0d0f` → composer/cards/dialogs `#141416` → menus `#19191b`
→ controls `#1b1c1d` → hover `#212224`. Text `#dee0e2`, secondary text `#a8a9ac`, accent
`#3c44c4`, the Builds graph `#4d7fd6`, icons `#6373bc`, a white wordmark. Dividers `#1f2020` and control edges
`#29292b` stay low emphasis. Tokyo Night keeps its
canonical `#1a1b26`/`#16161e`/`#c0caf5`/`#7aa2f7` but no longer lifts dialogs to Storm's `#24283b`.

## Formats

Copy theme exports DTCG 2025.10 JSON color tokens under `colors`, with `$type: "color"` and
`$value: { colorSpace: "srgb", components: [r,g,b], alpha: 1, hex: "#rrggbb" }`.
`$extensions["app.genex.studio"]` carries version 1, scheme, preset name and contrast.
The portable values are palette inputs, detail roles and shadows included when set; derived colours are recomputed on import.
Genex imports its own role names with opaque sRGB components. This is a documented subset of
DTCG: aliases, nested groups, alternate color spaces and alpha tokens are not supported.
The UI names this input “Genex tokens”; it does not promise a universal token-file importer.

VS Code `.json`/`.jsonc` color themes map `editor.background/foreground`, `foreground`,
`panel.background/border`, `sideBar.background/border`, `dropdown.background/border`,
`editorWidget.background`, `input.background/border`, `list.hoverBackground`,
`descriptionForeground`, `button.background`, `focusBorder`, `terminal.ansiGreen/Yellow/Red`
and `errorForeground`. Hex alpha values flatten over the imported canvas. Unmapped/missing
roles use Genex defaults, syntax tokens are ignored, and `include` themes must be exported with
resolved colors first. Import never installs an extension or reads another file. There is a
128 KB file limit and a 24-preset limit. A scheme mismatch fails visibly instead of overwriting
the other palette. Imports save a named custom preset; invalid files leave settings unchanged.

## Research and attribution (reviewed 2026-09-22)

- [Radix scale roles](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale): distinguish surfaces, borders, fills and text instead of reusing one gray.
- [VS Code color reference](https://code.visualstudio.com/api/references/theme-color): practical ecosystem interoperability through named UI colors, separate from syntax tokens.
- [DTCG 2025.10 color module](https://www.designtokens.org/tr/2025.10/color/): a portable JSON representation of colors; it is not a universal set of UI role names.
- [WCAG non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), “Boundaries”: controls identified by visible text or icons do not require a contrasting hit-area outline. The previous blanket 3:1 correction on every decorative border was inappropriate. Readability and state cues are assessed separately.
- [WCAG contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): 4.5:1 for normal text, measured on the backgrounds where it is used.
- [Tokyo Night](https://github.com/tokyo-night/tokyo-night-vscode-theme): blue-violet neutrals, blue accents, independent light colors.
- [Catppuccin palette](https://catppuccin.com/palette/): Mocha/Latte neutrals with mauve accents.
- [Rosé Pine palette](https://rosepinetheme.com/palette/): Pine/Dawn warm neutrals with iris accents.
- [GitHub themes](https://github.com/primer/github-vscode-theme): restrained gray surfaces and blue interactive roles.

Muted text, boundaries and light status colors are adapted for dense Studio UI readability.
Upstream MIT notices are retained in `THIRD-PARTY-NOTICES.md`, which Forge retains at the app archive root.
No assets or extension code are downloaded at runtime.

## Verification

`npm test -- tests/conformance/appearance.test.ts` covers schema normalization, independent modes,
contrast, persistence shape, DTCG round trips, and JSONC import/rejection behavior.
`node tests/e2e/run-appearance-ui.mjs` exercises the actual Settings dialog in an isolated Chromium
profile: OS mode, keyboard menus, edits, custom presets, reload, import recovery, clipboard fallback,
font roles, actual computed contrast, cursors, resizing, 200% zoom, RTL and reduced motion.
It writes `.studio-dev/appearance-ui/report.json` and captures. The parked renderer disables
background throttling, waits for a paint and requests awake captures; failed captures cannot
reuse an earlier run's report. Clipboard failure is simulated;
the test never overwrites the user's clipboard. The shared gallery plus owned app sessions verify
neighboring controls, sidebar/composer surfaces and native preview occlusion separately.

Keyboard focus uses filled control states rather than an external ring. Text-field carets remain
visible, with a quiet edge change. Active navigation uses the selected accent; composer Send/Stop use the ink fill.
This restrained treatment follows the September 22 user review; it is not a claim of full WCAG
certification. Native project, screen-reader semantics and keyboard navigation are unchanged.
