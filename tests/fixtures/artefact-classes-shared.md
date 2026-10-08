## Known artefact classes — scan every camera for each before you list defects

Report a hit with its class name in square brackets, then what and where and which camera
(e.g. `[overflow] the "Billing address" label runs under the toggle on its right — camSettings`).
A defect in a known class becomes the catalogue check for that class; a defect outside the list is
described in full.

- `[unstyled]` the browser's defaults showing through: a serif body, blue underlined links on a page
  that is not a document, grey system buttons, no spacing between blocks, a form that is a column
  of bare inputs. Nothing says someone designed it.
- `[overflow]` text or controls clipped, overlapping or running past their container or the window:
  a label under a button, a truncated heading with no way to read it, a table that pushes the page
  sideways, a modal taller than the screen.
- `[placeholder]` lorem ipsum, "TODO", "Untitled", "foo", "Item 1 / Item 2", broken-image icons or an
  empty grey box standing in for content that should be there.
- `[raw-data]` something internal shown to a person: `undefined`, `NaN`, `[object Object]`, an
  untranslated key, an id where a name belongs, an ISO timestamp where a date belongs, a stack trace.
- `[no-state]` a screen with no answer for the case it is in: blank where an empty list needs
  a message and a next step, a spinner with nothing behind it, an error shown as a console message
  and not on the screen, a button that stays enabled while it works.
- `[low-contrast]` text that is hard to read against its background, light grey on white, a
  placeholder doing the work of a label, an icon that disappears on a coloured bar.
- `[inconsistent]` the same kind of element drawn several ways: three button styles, two corner
  radii, mixed spacing, a heading that changes size from one view to the next.
- `[false-affordance]` something that looks operable and is not (a card that looks like a link, a
  grey button that is always disabled), or something operable that looks like plain text.
- `[duplicate-overlay]` the same control or readout drawn twice; overlapping or misaligned overlays,
  toasts or modals; a `user:view` frame showing UI the canvas frame lacks.
- `[dead-input]` state that shows the scripted controls did nothing: the numbers the PROJECT line
  names as this project's input evidence are unchanged between the early state and the late one.
  Never report it when the PROJECT line says the class does not apply to this project.
- `[haze-plane]` translucent horizontal
  planes or additive bands cutting through geometry: objects look "filled with water" up to a line, a
  milky layer floats at a fixed height.
- `[light-cone]` visible volumetric cones,
  pyramids or "huts" over lamps.
- `[moire]` shimmer or stripes on fine
  repeating textures (ceilings, grilles, skies).
- `[floating]` props, characters or
  enemies hovering above or sunk into the floor.
- `[primitive]` a weapon, prop or
  character that is an untextured box/capsule with no silhouette.
- `[no-hands]` a first-person view with no arms or hands holding the
  weapon or tool.
- `[noise-as-texture]` tiling noise
  standing in for a material.
- `[z-fight]` flickering or striped
  coplanar surfaces.
- `[blown]` highlights or light pools
  clipped to white; a washed-out frame with no black point.
- `[blob]` something organic — a tree
  canopy, a bush, hay, an animal, smoke — built as a smooth or faceted solid (sphere, icosahedron,
  capsule, lump) so it reads as a boulder, an egg or a loaf: no leaf silhouette, no light through
  it, no parts. A tree whose crown is a ball on a post is a `[blob]` whatever texture is on it.
