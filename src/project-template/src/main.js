/** Empty project: the page shell and the studio instrumentation, with no content or behaviour. */
import { installStudio } from "./studio.js";

// ── FACET WIRING ──
// (facet imports and initialization go here)
// ── END FACET WIRING ──

const app = document.getElementById("app");

installStudio({
  // Back to a known state for this seed: empty the store, load the fixtures, return to the first screen.
  reset() {},
  // What the project holds, as numbers and short strings a check can compare: items, selection, route.
  probes() {
    return { phase: "empty", elements: app.querySelectorAll("*").length };
  },
  // Named screens the critic photographs: { list: () => navigate("#/list"), empty: () => store.clear() }.
  views: {},
  // Workflows the generic run cannot reach: { "add-and-remove": async () => { … return { items: 0 }; } }.
  demos: {},
});
