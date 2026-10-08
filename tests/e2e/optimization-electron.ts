/** Real Electron collector + candidate state machine, with a deterministic fixture worker/critic. */
import { app, BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import assert from "node:assert/strict";
import { ProjectPreview, registerProjectScheme } from "../../src/main/preview.ts";
import { SnapshotEngine } from "../../src/substrate/snapshots.ts";
import { ProjectCandidates } from "../../src/substrate/project-candidate.ts";
import { runOptimization } from "../../src/harness-seed/loop/optimization.ts";
import { optimizationProject, optimizationHTML } from "./optimization-project.mjs";
import type { ProfileSample, Revision } from "../../src/shared/optimization.ts";

/**
 * The source each safety case runs. `missing` takes the inspection away; `uninitialized` leaves
 * the project working and makes the renderer report what a common Renderer reports until its
 * `init()` has resolved, which is the one answer the observer must treat as "come back" and the
 * stage must file as `renderer_not_ready` rather than "this studio cannot profile".
 */
function caseSource(backend: string, testCase: string): string {
  const base = optimizationProject(backend);
  // `inspect()` that answers nothing, not a MISSING inspect(): under the M4 shim `window.__studio`
  // is a merging facade, so a method the project does not define is filled in from the hook and a
  // deleted `inspect` is no longer absent. What is still absent is a renderer to inspect.
  if (testCase === "missing") return base.replace("inspect:()=>({scene,renderer,camera})", "inspect:()=>({})");
  if (testCase === "uninitialized")
    return base.replace(
      "};draw();window.fixtureReady=true;",
      "};renderer.hasInitialized=()=>false;draw();window.fixtureReady=true;",
    );
  return base;
}

const repo = process.env.AG931_REPO!,
  output = process.env.AG931_OUTPUT!;
const root = mkdtempSync(path.join(os.tmpdir(), "ag931-gpu-"));
app.setPath("userData", path.join(root, "electron"));
registerProjectScheme();
app.on("window-all-closed", () => {}); // each backend disposes its own isolated window

async function main() {
  await app.whenReady();
  console.log("Optimization Electron fixture ready");
  const all: unknown[] = [];
  try {
    for (const backend of ["webgl", "webgpu", "fallback"]) {
      // `uninitialized` is meaningless on webgl: only a common Renderer has `hasInitialized`, and
      // only that one can be armed against before its init() has resolved (M4.9).
      for (const testCase of process.env.AG931_SAFETY_ONLY
        ? backend === "webgl"
          ? ["noop", "fidelity", "cancel", "missing"]
          : ["noop", "fidelity", "cancel", "missing", "uninitialized"]
        : ["improve"]) {
        const live = path.join(root, `${backend}-${testCase}`);
        await mkdir(path.join(live, "src"), { recursive: true });
        await writeFile(path.join(live, "index.html"), optimizationHTML);
        await writeFile(path.join(live, "src/main.js"), caseSource(backend, testCase));
        const snapshots = new SnapshotEngine([{ name: "fixture", dir: live }]);
        await snapshots.init();
        const baseline = await snapshots.snapshot({
          scope: "game",
          projectWorkspace: "fixture",
          reason: "fixture",
          healthy: true,
        });
        const registry = new ProjectCandidates(snapshots, path.join(root, `${backend}-scratch`));
        const win = new BrowserWindow({
          width: 960,
          height: 600,
          show: false,
          focusable: false,
          skipTaskbar: true,
          webPreferences: {},
        });
        const port = new ProjectPreview({
          offscreen: true,
          projectsRoot: root,
          vendorDir: path.join(repo, "dist/resources/vendor"),
          partition: `optimization-${backend}-${testCase}`,
        });
        port.attachTo(win, { x: 0, y: 0, width: 960, height: 600 });
        console.log("OFFSCREEN", port.view?.webContents.isOffscreen());
        let loaded: { candidateId: string; revision: Revision } | null = null;
        const runId = `run_${backend}_${testCase}`;
        let baseImage: string | null = null;
        const artifacts = path.join(output, backend, testCase);
        await mkdir(artifacts, { recursive: true });
        const events: unknown[] = [];
        const save = async (name: string, data: Buffer) => {
          const file = path.join(artifacts, name);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, data);
          return file;
        };
        const ready = async () => {
          for (let i = 0; i < 100; i++) {
            if (await port.evaluate("window.fixtureReady===true")) return;
            await new Promise((r) => setTimeout(r, 100));
          }
          throw new Error(JSON.stringify(port.consoleEntries()));
        };
        const ctx: any = {
          workspace: path.join(repo, "dist/resources/harness-seed"),
          threadId: "fixture",
          cancelled: false,
          setStatus() {},
          notify(type: string, p: unknown) {
            if (type === "run.optimization") console.log(backend, type, JSON.stringify(p));
          },
          async call(method: string, p: any = {}) {
            switch (method) {
              case "run.artifact":
                return save(p.name, Buffer.from(p.base64, "base64"));
              case "artifact.write":
                return save("journal.json", Buffer.from(JSON.stringify(p.value)));
              case "events.append":
                events.push(...structuredClone(p.batch));
                return true;
              case "optimization.open":
                return registry.open("fixture", runId, baseline.snapshot_id, baseline.git.game!);
              case "optimization.freeze":
                return registry.freeze(p.candidateId);
              case "optimization.close":
                return registry.close(p.candidateId);
              case "optimization.promote":
                return registry.promote(p.candidateId, p.expectedLive, p.verifiedCandidate, p.resultArtifact);
              case "optimization.reconcile":
                return registry.reconcile("fixture", p.baseline, p.candidate);
              case "project.write": {
                const file = await registry.file(p.candidateId, "fixture", p.file, true);
                await mkdir(path.dirname(file), { recursive: true });
                await writeFile(file, p.contents);
                return { bytes: p.contents.length };
              }
              case "preview.acquire":
                return { handle: "stage" };
              case "preview.release":
                await port.profile({ action: "end", sessionId: "none" });
                return true;
              case "preview.load": {
                if (!p.handle) return true;
                const root = p.candidateId ? (await registry.source(p.candidateId, p.revision)).root : p.root;
                await port.load("fixture", "index.html", root);
                await ready();
                loaded = p.candidateId ? { candidateId: p.candidateId, revision: p.revision } : null;
                return true;
              }
              case "preview.reload":
                await port.reload();
                await ready();
                return true;
              case "preview.status":
                return port.status();
              case "preview.call":
                return p.handle ? port.studioCall(p.method, p.arg) : true;
              case "preview.input":
                return port.input(p.actions ?? []);
              case "preview.state":
                return port.studioState();
              case "preview.console":
                return port.consoleEntries();
              case "preview.gpuErrors":
                return port.gpuErrors();
              case "preview.evaluate":
                return port.evaluate(p.expression);
              case "preview.profile": {
                if (p.action === "begin") {
                  assert.equal(loaded?.revision.commit, p.expectedRevision.commit);
                  await registry.source(loaded!.candidateId, p.expectedRevision);
                }
                const observation = (await port.profile(p)) as any;
                if (observation?.state === "unavailable")
                  console.log(
                    "PROFILE FAILURE",
                    JSON.stringify({
                      observation,
                      windowVisible: win.isVisible(),
                      state: await port.studioState(),
                      visibility: await port.evaluate("document.visibilityState"),
                    }),
                  );
                return observation;
              }
              case "preview.screenshot": {
                const shot = await port.screenshotWithStats(80, { page: p.page });
                const file = await save(`${p.label}.jpg`, shot.jpeg);
                return { path: file, base64: shot.jpeg.toString("base64"), bytes: shot.jpeg.length, stats: shot.stats };
              }
              case "preview.diff":
                return (await port.diffImages(p.a, p.b)).diff;
              default:
                throw new Error(`unexpected fixture RPC ${method}`);
            }
          },
        };
        const result = await runOptimization(ctx, {
          threadId: "fixture",
          run: {
            runId,
            project: "fixture",
            goal: "Preserve 64 blocks and HUD; remove redundant draw calls",
            budgets: { wallClockMs: 6_000_000 },
          },
          journal: {},
          baselineSnapshot: baseline,
          baselineVerified: true,
          baselineEvidence: { ok: true, shots: [] },
          deadline: Date.now() + 600_000,
          quality: async (_ctx: any, { evidence }: any) => evidence.ok && evidence.state.entities === 64,
          services: {
            worker: async ({ candidate, brief }: any) => {
              assert.match(brief, /drawCalls/);
              assert.match(brief, /WebGL|common/);
              if (testCase === "noop") return;
              await writeFile(
                path.join(candidate.root, "src/main.js"),
                optimizationProject(backend, true).replace(
                  "0x61cde8",
                  testCase === "fidelity" ? "0xff0000" : "0x61cde8",
                ),
              );
              if (testCase === "cancel") ctx.cancelled = true;
            },
            preserve: async (_ctx: any, { baseline: before, candidate: after }: any) => {
              assert.deepEqual(before.state, after.state, "deterministic state preserved");
              const beforeShot = before.shots.find((s: any) => s.camera === "default"),
                afterShot = after.shots.find((s: any) => s.camera === "default");
              const difference = (await port.diffImages(beforeShot.path, afterShot.path)).diff;
              if (testCase === "fidelity") {
                assert.ok(difference.diffFraction > 0.01, "deliberate visual regression is visible in real pixels");
                return {
                  status: "regressed",
                  reasons: ["Real pixel comparison detected changed appearance"],
                  summary: "Reject fidelity change",
                };
              }
              assert.ok(difference.diffFraction < 0.001, `same appearance: ${JSON.stringify(difference)}`);
              baseImage = beforeShot.path;
              return {
                status: "preserved",
                reasons: ["Independent pixel comparison and deterministic state matched"],
                summary: "64 blocks batched without changing content or HUD",
              };
            },
          },
        } as never);
        await save("events.json", Buffer.from(JSON.stringify(events, null, 2)));
        await save("result.json", Buffer.from(JSON.stringify(result, null, 2)));
        assert.equal(win.isVisible(), false, "private optimization window was never shown");
        if (testCase !== "improve") {
          const expected = {
            noop: "no_improvement",
            fidelity: "no_improvement",
            cancel: "interrupted",
            missing: "skipped",
            uninitialized: "skipped",
          }[testCase];
          assert.equal(result.outcome, expected, `${backend}/${testCase}: ${result.reason}`);
          // A renderer that has not finished init() is a WebGPU project still booting, not a studio
          // that cannot profile: its own reason code, and the baseline untouched either way.
          if (testCase === "uninitialized")
            assert.equal(
              result.reasonCode,
              "renderer_not_ready",
              `${backend}/uninitialized: ${result.reasonCode} — ${result.reason}`,
            );
          assert.equal(result.candidateAdopted, false);
          assert.equal(
            (await registry.revision("fixture")).tree,
            result.baseline?.tree ?? (await registry.revision("fixture")).tree,
          );
          assert.equal(
            await readFile(path.join(live, "src/main.js"), "utf8"),
            caseSource(backend, testCase),
            "failure preserves the full baseline source",
          );
          all.push({ backend, testCase, result: result.outcome, reason: result.reason });
          console.log(`${backend}/${testCase}: ${result.outcome}, baseline preserved`);
          port.destroy();
          win.destroy();
          continue;
        }
        assert.equal(result.outcome, "improved", `${backend}: ${result.reason}`);
        const first = result.scenarios[0].before[0] as ProfileSample;
        assert.equal(first.backend, backend === "webgpu" ? "webgpu" : "webgl", "fallback cannot pass as WebGPU");
        assert.equal(first.inventory.instances, 0);
        assert.equal(result.scenarios[0].after[0].inventory.instances, 64);
        // The 64 boxes submit 768 triangles; HUD adds two, which must be excluded. Common
        // renderer's QuadMesh output pass adds one full-screen triangle on BOTH sides.
        assert.equal(first.metrics.triangles!.value!, backend === "webgl" ? 768 : 769);
        assert.equal(first.metrics.drawCalls!.value!, backend === "webgl" ? 64 : 65);
        assert.equal(result.scenarios[0].after[0].metrics.drawCalls.value, backend === "webgl" ? 1 : 2);
        assert.equal(result.scenarios[0].after[0].metrics.triangles.value, first.metrics.triangles!.value!);
        assert.ok((await readFile(path.join(live, "src/main.js"), "utf8")).includes("InstancedMesh"));
        all.push({
          backend,
          testCase,
          actualBackend: first.backend,
          result: result.outcome,
          baselineImage: baseImage,
          before: first.metrics,
          after: result.scenarios[0].after[0].metrics,
        });
        console.log(`${backend}: real ${first.backend}, ${result.outcome}`);
        port.destroy();
        win.destroy();
      }
    }
    await writeFile(
      path.join(output, "summary.json"),
      JSON.stringify(
        {
          passed: true,
          fixture: "custom runtime; real collector and candidate coordinator; scripted worker/pixel critic",
          cases: all,
        },
        null,
        2,
      ),
    );
    app.exit(0);
  } catch (error) {
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, "summary.json"),
      JSON.stringify({ passed: false, cases: all, error: String(error) }, null, 2),
    );
    console.error(error);
    app.exit(1);
  }
}
void main();
