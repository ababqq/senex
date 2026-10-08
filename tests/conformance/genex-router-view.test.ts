/**
 * The Plugins page as the router shows it: the router's own name and line on Genex's row and page,
 * its picture (eight routed tools on a 2×2 board that is never empty), and the Marketplace that is
 * still to come.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { MoreView, moreView } from "../../src/renderer/panels/plugins/labels.ts";
import { shownDescription, shownName } from "../../src/renderer/panels/plugins/labels.ts";
import { BOARD_CELLS, boardMoves, pieceFrames } from "../../src/renderer/panels/plugins/genex/router-icon.ts";
import { ICON_TOOLS, ROUTED_TOOLS } from "../../src/renderer/panels/plugins/genex/routed-tools.ts";
import { GENEX_WORDS } from "../../src/renderer/words.ts";

const plugin = (id: string, name: string, description: string): PluginInfo =>
  ({ manifest: { id, name, description, publisher: "Someone" } }) as unknown as PluginInfo;

describe("Genex's row and page name the router", () => {
  it("shows Genex as the project dev tools router, with the tools it routes on its line", () => {
    const genex = plugin(GENEX_PLUGIN_ID, "Genex Tools", "3D models, characters, sound and art…");
    assert.equal(shownName(genex), "Project dev tools router");
    assert.equal(shownDescription(genex), GENEX_WORDS.router.description);
    assert.match(shownDescription(genex), /^Genex · .*Meshy/);
  });

  it("leaves every other plugin's own name and description alone", () => {
    const blender = plugin("blender", "Local Blender", "Model 3D assets with Blender on this Mac.");
    assert.equal(shownName(blender), "Local Blender");
    assert.equal(shownDescription(blender), "Model 3D assets with Blender on this Mac.");
  });
});

describe("the router's picture", () => {
  const moves = boardMoves(ICON_TOOLS.length);

  /** Where every piece is after each move, replaying the moves from the start cells. */
  const replay = (): Array<Map<number, readonly [number, number]>> => {
    const at = new Map<number, readonly [number, number]>(BOARD_CELLS.map((cell, piece) => [piece, cell]));
    const boards: Array<Map<number, readonly [number, number]>> = [];
    for (const move of moves) {
      for (const step of move) at.set(step.piece, step.to);
      boards.push(new Map(at));
    }
    return boards;
  };
  const onBoard = (cell: readonly [number, number]): boolean =>
    cell[0] >= 0 && cell[0] <= 1 && cell[1] >= 0 && cell[1] <= 1;

  it("is never empty: after every move exactly four tools fill the four cells", () => {
    for (const board of replay()) {
      const filled = [...board.values()].filter(onBoard).map((c) => c.join(","));
      assert.equal(filled.length, 4);
      assert.equal(new Set(filled).size, 4);
    }
  });

  it("brings every routed tool onto the board, and ends where it began so the loop has no seam", () => {
    const boards = replay();
    const seen = new Set<number>();
    for (const board of boards) for (const [piece, cell] of board) if (onBoard(cell)) seen.add(piece);
    assert.equal(seen.size, ICON_TOOLS.length);
    const last = boards.at(-1);
    for (const [piece, cell] of BOARD_CELLS.entries()) assert.deepEqual(last?.get(piece), cell);
  });

  it("gives each tool a timeline from 0 to 1 that starts and ends in the same place", () => {
    const frames = pieceFrames(ICON_TOOLS.length);
    assert.equal(frames.length, ICON_TOOLS.length);
    for (const timeline of frames) {
      assert.equal(timeline[0]?.offset, 0);
      assert.equal(timeline.at(-1)?.offset, 1);
      const offsets = timeline.map((frame) => frame.offset);
      assert.deepEqual(
        offsets,
        [...offsets].sort((a, b) => a - b),
      );
      assert.equal(new Set(offsets).size, offsets.length);
      assert.deepEqual(timeline.at(-1)?.cell, timeline[0]?.cell);
    }
  });

  it("only jumps while a tool is off the board, never across it", () => {
    for (const timeline of pieceFrames(ICON_TOOLS.length))
      for (const [i, frame] of timeline.entries()) {
        if (!frame.jump) continue;
        assert.ok(!onBoard(frame.cell), "a jump starts off the board");
        const next = timeline[i + 1];
        assert.ok(next && !onBoard(next.cell), "and lands off the board");
      }
  });

  it("draws only tools the router really routes", () => {
    const routed = new Set(ROUTED_TOOLS.map((t) => t.id));
    for (const id of ICON_TOOLS) assert.ok(routed.has(id), id);
  });
});

describe("the Marketplace below the MCP servers", () => {
  const index = { entries: [], updates: [], studioVersion: "1.0.0" } as never;
  it("is coming soon while the catalog has nothing you don't have", () => {
    assert.equal(moreView({ index, entries: 0, releases: 0 }), MoreView.Soon);
  });
  it("lists what the catalog offers once it has something new", () => {
    assert.equal(moreView({ index, entries: 1, releases: 0 }), MoreView.List);
  });
  it("stays coming soon while the catalog loads or can't be read: nothing else shows there yet", () => {
    assert.equal(moreView({ index: null, entries: 0, releases: 0 }), MoreView.Soon);
    const failed = { ...(index as object), error: "offline" } as never;
    assert.equal(moreView({ index: failed, entries: 0, releases: 0 }), MoreView.Soon);
  });
});
