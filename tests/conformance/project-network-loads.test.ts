/**
 * What the Open Project sheet and a builder's validate call say about a page that loads code from
 * the network. The preview reaches only the well-known public CDNs (preview-network.ts); a page
 * that needs any other host is told so, and a CDN-only page is not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { networkLoads, unreachableLoads } from "../../src/substrate/project-workspace.ts";

const page = (body: string) => `<!doctype html><html><head>${body}</head><body></body></html>`;

describe("network loads of a project page", () => {
  it("names every host the page loads code or styles from", () => {
    const html = page(`
      <script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
      <script src="https://attacker.example/tracker.js"></script>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
      <script type="module">import x from "https://esm.sh/lodash-es";</script>`);
    assert.deepEqual(networkLoads(html).sort(), [
      "attacker.example",
      "cdn.jsdelivr.net",
      "esm.sh",
      "fonts.googleapis.com",
    ]);
  });

  it("flags only the hosts the preview cannot reach", () => {
    const cdnOnly = page(`
      <script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.170.0/build/three.module.js"}}</script>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">`);
    assert.deepEqual(unreachableLoads(cdnOnly), []);
    const mixed = page(`<script src="https://cdnjs.cloudflare.com/ajax/libs/howler/2.2.4/howler.min.js"></script>
      <script src="//static.example.org/project.js"></script>`);
    assert.deepEqual(unreachableLoads(mixed), ["static.example.org"]);
  });
});
