/**
 * Model recommendations.
 *
 * The catalog is data the user acts on: it decides which model the studio installs and defaults
 * to. Two ways it can lie, both of which happened before these tests existed:
 *   - it recommended a model that had been superseded (and, once deleted, told the user to
 *     re-download it);
 *   - the fit rule was tuned for discrete GPUs and declared the studio's own verified default
 *     model too large for the machine it was measured on.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogModels,
  fitFor,
  recommendModels,
  supersededBy,
  tiers,
  tierFor,
  type HardwareInfo,
} from "../../src/substrate/hardware.ts";

/** A machine fixture built the way detectHardware() builds one, so the fit budget matches. */
function machine(ramGb: number, appleSilicon: boolean): HardwareInfo {
  return {
    cpu: appleSilicon ? "Apple M2 Max" : "Intel Core i9",
    ramBytes: ramGb * 1024 ** 3,
    ramGb,
    usableModelGb: Math.round(ramGb * (appleSilicon ? 0.72 : 2 / 3) * 10) / 10,
    platform: appleSilicon ? "darwin" : "linux",
    arch: appleSilicon ? "arm64" : "x64",
    appleSilicon,
  };
}

describe("model catalog", () => {
  it("every tier's first-ranked model fits the machine that tier describes", async () => {
    // A Best fit the studio cannot run is worse than none: it is confident, and wrong.
    for (const tier of tiers()) {
      const { defaultModel, picks } = await recommendModels(machine(tier.minRamGb, true));
      assert.equal(
        defaultModel,
        tier.picks[0],
        `${tier.label}: its first-ranked model ${tier.picks[0]} does not fit — ${picks[0]?.reason}`,
      );
    }
  });

  it("ranks every tier with real catalog models and short, displayable lines", () => {
    const models = catalogModels();
    for (const tier of tiers())
      for (const id of tier.picks) assert.ok(models[id], `${tier.label} ranks unknown model ${id}`);
    for (const [id, model] of Object.entries(models)) {
      assert.ok(model.about.length > 0 && model.about.length <= 60, `${id}: about must be one short line`);
      assert.ok(model.sizeGb > 0, `${id}: size`);
      if (model.mlx) assert.ok(models[model.mlx]?.appleSilicon, `${id}: its MLX sibling must be Apple-Silicon only`);
    }
  });

  it("recommends Bonsai PQ2_0 by default on a 32 GB Apple Silicon Mac", async () => {
    const { defaultModel, hardware, picks } = await recommendModels(machine(32, true));
    assert.equal(defaultModel, "bonsai-2:27b-pq2_0");
    assert.equal(picks[0]?.model, defaultModel);
    assert.ok(hardware.usableModelGb >= 23, `Metal is handed ~76% of unified memory, got ${hardware.usableModelGb}`);
  });

  it("makes Qwen 3.5 122B the Best fit on 128 GB and larger Apple Silicon Macs", async () => {
    for (const ram of [128, 192]) {
      const { defaultModel, picks } = await recommendModels(machine(ram, true));
      assert.equal(defaultModel, "qwen3.5:122b");
      assert.ok(picks[0]?.vision && picks[0].tools, "the large-Mac Best fit must build and see the project");
    }
  });

  it("shows one build per model: MLX on Apple Silicon, the portable build elsewhere", async () => {
    const apple = await recommendModels(machine(64, true));
    const appleIds = [...apple.picks, ...apple.more].map((p) => p.model);
    assert.ok(appleIds.includes("qwen3.8:27b-mlx"));
    assert.ok(!appleIds.includes("qwen3.8:27b"), "the GGUF sibling is hidden where the MLX build runs");

    const other = await recommendModels(machine(64, false));
    const otherIds = [...other.picks, ...other.more].map((p) => p.model);
    assert.ok(otherIds.includes("qwen3.8:27b"));
    assert.ok(!otherIds.some((id) => id.includes("-mlx")), "an MLX build was offered to a non-Apple machine");
    assert.ok(!other.defaultModel?.includes("-mlx"));
  });

  it("puts every other runnable model under More models, with the Mac it needs", async () => {
    const { picks, more } = await recommendModels(machine(32, true));
    assert.ok(picks.every((p) => p.fits));
    const ids = new Set(picks.map((p) => p.model));
    assert.ok(
      more.every((p) => !ids.has(p.model)),
      "a model appears in both lists",
    );
    assert.deepEqual(
      more.map((p) => p.sizeGb),
      [...more.map((p) => p.sizeGb)].sort((a, b) => a - b),
      "More models is smallest first",
    );
    const big = more.find((p) => p.model === "qwen3.5:122b");
    assert.equal(big?.fits, false);
    assert.equal(big?.needsRamGb, 128);
    assert.equal(more.find((p) => p.model === "gemma4:31b")?.needsRamGb, 36);
    assert.equal(more.find((p) => p.model === "qwen3.8-flash-next:125b-mlx")?.needsRamGb, 192);
  });

  it("judges any looked-up size with the same fit rule", () => {
    const fit = fitFor(6.6, machine(32, true));
    assert.equal(fit.fits, true);
    assert.equal(fit.needGb, 8.9);
    assert.equal(fitFor(600, machine(32, true)).needsRamGb, null, "nothing common holds it");
  });

  it("flags a superseded install rather than leaving the user on an old model", () => {
    assert.equal(supersededBy("qwen3.6:27b"), "qwen3.8:27b");
    assert.equal(supersededBy("qwen3.8:27b-mlx"), null, "the current default is not stale");
  });

  it("never offers a superseded model", () => {
    // A stale flag that redirects to something also stale sends the user on a pointless download.
    for (const id of Object.keys(catalogModels()))
      assert.equal(supersededBy(id), null, `${id} is offered but marked superseded`);
  });

  it("picks the tier the machine actually meets", () => {
    assert.equal(tierFor(32).minRamGb, 32);
    assert.equal(tierFor(16).minRamGb, 16);
    assert.equal(tierFor(192).minRamGb, 192);
    assert.ok(tierFor(8).minRamGb <= 8);
  });
});

it("offers both Bonsai packings on supported Macs and neither on 8 GB or other hardware", async () => {
  const supported = await recommendModels(machine(16, true));
  assert.deepEqual(
    supported.picks.filter((p) => p.engine === "bonsai").map((p) => p.model),
    ["bonsai-2:27b-pq2_0", "bonsai-2:27b-ptq1_0"],
  );
  for (const hw of [machine(8, true), machine(32, false)]) {
    const { picks, more } = await recommendModels(hw);
    assert.equal(
      [...picks, ...more].some((p) => p.engine === "bonsai"),
      false,
    );
  }
});
