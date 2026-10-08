/**
 * The prober's small pure rules, ported from genex-demo with their tests: the probe budget (a probe
 * always writes its evidence inside the grader's deadline), the capture breaker (a dead screenshot
 * path stops costing wall clock), the capture lane (a timed-out capture cannot overlap the next),
 * WebGL context losses a project survived, the reviewed dark phase, and the boot observation codes.
 * No browser, no real clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { classifyBootObservation, diagnosticUrl } from "../../scripts/evals/prober/boot-observation.ts";
import { createCaptureLane } from "../../scripts/evals/prober/canvas-capture.ts";
import {
  CAPTURE_FAILURE_STREAK,
  CAPTURE_PROBE_TIMEOUT_MS,
  CAPTURE_RETRY_EVERY_MS,
  CAPTURE_TIME_BUDGET_MS,
  captureBreakerSentence,
  captureBreakerSummary,
  createCaptureBreaker,
  recordShot,
  shouldAttempt,
} from "../../scripts/evals/prober/capture-breaker.ts";
import { CONTEXT_LOSS_SURVIVAL_MS, classifyContextLosses } from "../../scripts/evals/prober/context-loss.ts";
import { darkPhaseAcceptance } from "../../scripts/evals/prober/dark-phase.ts";
import { exposureReport } from "../../scripts/evals/prober/frames.ts";
import {
  ACT_TIMEOUT_FAST_MS,
  ACT_TIMEOUT_MS,
  actTimeoutFor,
  budgetSentence,
  createResponsiveness,
  EVAL_TIMEOUT_FAST_MS,
  EVAL_TIMEOUT_MS,
  evalTimeoutFor,
  isUnresponsive,
  LOOK_RESERVE_MS,
  PROBE_BUDGET_MARGIN_MS,
  PROBE_DEADLINE_FACTOR,
  planSoak,
  PRE_SOAK_ALLOWANCE_MS,
  probeBudgetMs,
  recordRead,
  shouldRunLook,
  TEARDOWN_RESERVE_MS,
  UNRESPONSIVE_STREAK,
} from "../../scripts/evals/prober/probe-budget.ts";
import { ProbePhase } from "../../scripts/evals/vocabulary.ts";

/** The soak the full prober's L1 floor is defined against (§8.2). */
const SPEC_SOAK_MS = 300_000;

/* ------------------------------------------------------------------ budget */

test("the probe budget leaves at least the readout margin below the grader deadline", () => {
  assert.ok(probeBudgetMs(SPEC_SOAK_MS) + PROBE_BUDGET_MARGIN_MS <= SPEC_SOAK_MS * PROBE_DEADLINE_FACTOR);
  assert.equal(probeBudgetMs(300_000), 1_080_000);
});

test("a short soak's budget never falls below the soak plus the fixed phases and reserves (the floor)", () => {
  for (const soakMs of [0, 30_000, 60_000, 120_000]) {
    const floor = soakMs + PRE_SOAK_ALLOWANCE_MS + LOOK_RESERVE_MS + TEARDOWN_RESERVE_MS;
    assert.equal(probeBudgetMs(soakMs), floor, `${soakMs}`);
    // Once the phases before the soak spent their allowance, the soak still runs in full.
    const left = probeBudgetMs(soakMs) - PRE_SOAK_ALLOWANCE_MS;
    assert.equal(shouldRunLook(left, soakMs, false).run, true, `${soakMs}`);
    assert.deepEqual(planSoak(left - LOOK_RESERVE_MS, soakMs), { soakMs, shortenedByMs: 0, why: null });
  }
  assert.equal(probeBudgetMs(SPEC_SOAK_MS), SPEC_SOAK_MS * PROBE_DEADLINE_FACTOR - PROBE_BUDGET_MARGIN_MS);
});

test("a soak that fits runs in full; one that does not is shortened, never run past the reserve, and says why", () => {
  assert.deepEqual(planSoak(1_000_000, 300_000), { soakMs: 300_000, shortenedByMs: 0, why: null });
  const cut = planSoak(200_000, 300_000);
  assert.equal(cut.soakMs, 200_000 - TEARDOWN_RESERVE_MS);
  assert.equal(cut.shortenedByMs, 300_000 - cut.soakMs);
  assert.match(cut.why ?? "", /probe budget had 200s left/);
  const none = planSoak(TEARDOWN_RESERVE_MS - 1, 300_000);
  assert.equal(none.soakMs, 0);
});

test("the look phase runs only with room for itself, the soak and the readout, and never on an unresponsive page", () => {
  assert.equal(shouldRunLook(LOOK_RESERVE_MS + 300_000 + TEARDOWN_RESERVE_MS, 300_000, false).run, true);
  const short = shouldRunLook(LOOK_RESERVE_MS + 300_000 + TEARDOWN_RESERVE_MS - 1, 300_000, false);
  assert.equal(short.run, false);
  assert.match(short.why ?? "", /need 480s/);
  const slow = shouldRunLook(10_000_000, 300_000, true);
  assert.equal(slow.run, false);
  assert.match(slow.why ?? "", /unresponsive/);
});

test("the measured shape: three reads in a row waiting out their timeout mark the page unresponsive, timeouts shrink, and a later success does not un-trip it", () => {
  const r = createResponsiveness();
  assert.equal(evalTimeoutFor(r), EVAL_TIMEOUT_MS);
  assert.equal(actTimeoutFor(r), ACT_TIMEOUT_MS);
  recordRead(r, true, 1000);
  recordRead(r, false, 11_000);
  recordRead(r, false, 21_000);
  assert.equal(isUnresponsive(r), false, "two is not three");
  recordRead(r, true, 21_500);
  assert.equal(r.streak, 0, "a success resets the streak");
  for (let i = 0; i < UNRESPONSIVE_STREAK; i++) recordRead(r, false, 30_000 + i * 10_000);
  assert.equal(r.unresponsiveAtMs, 50_000);
  assert.equal(evalTimeoutFor(r), EVAL_TIMEOUT_FAST_MS);
  assert.equal(actTimeoutFor(r), ACT_TIMEOUT_FAST_MS);
  recordRead(r, true, 60_000);
  assert.equal(isUnresponsive(r), true, "stays tripped");
  assert.equal(r.timeouts, 5);
  assert.equal(r.reads, 8);
});

test("the sentence names each budget decision and never reads as a verdict on the project", () => {
  assert.equal(
    budgetSentence({
      budgetMs: 1_080_000,
      usedMs: 600_000,
      soakPlannedMs: 300_000,
      soakShortenedByMs: 0,
      lookSkippedWhy: null,
      responsiveness: { reads: 40, timeouts: 0, unresponsiveAtMs: null },
    }),
    null,
  );
  const s =
    budgetSentence({
      budgetMs: 1_080_000,
      usedMs: 1_050_000,
      soakPlannedMs: 120_000,
      soakShortenedByMs: 180_000,
      lookSkippedWhy: "the page was unresponsive",
      responsiveness: { reads: 30, timeouts: 12, unresponsiveAtMs: 45_000 },
    }) ?? "";
  assert.match(s, /marked unresponsive at 45000ms/);
  assert.match(s, /look phase was skipped/);
  assert.match(s, /shortened by 180s/);
  assert.match(s, /none of it is a verdict on the project/);
});

/* ------------------------------------------------------------ capture breaker */

test("a healthy page is never gated: every attempt goes out and nothing is counted as skipped", () => {
  const s = createCaptureBreaker();
  for (let i = 0; i < 50; i++) {
    const d = shouldAttempt(s, "page", i * 5000);
    assert.equal(d.attempt, true);
    assert.equal(d.probing, false);
    assert.equal(d.timeoutMs, null, "a normal shot keeps the caller's ceiling");
    recordShot(s, "page", true, i * 5000, 120);
  }
  assert.equal(s.skipped.page, 0);
  assert.equal(captureBreakerSentence(s), null);
});

test("the measured 2026-09-04 shape: three 15 s failures suspend page shots, the next attempts are skipped, one short probe per interval goes out, a success re-arms", () => {
  const s = createCaptureBreaker();
  let now = 14_500;
  for (let i = 0; i < CAPTURE_FAILURE_STREAK; i++) {
    assert.equal(shouldAttempt(s, "page", now).attempt, true);
    recordShot(s, "page", false, now + 15_000, 15_000);
    now += 15_000;
  }
  assert.notEqual(s.suspendedAtMs.page, null, "suspended after the streak");
  // The next capture inside the minute is skipped, and counted.
  const skip = shouldAttempt(s, "page", now + 1000);
  assert.equal(skip.attempt, false);
  assert.match(skip.why ?? "", /suspended after 3 failures/);
  assert.equal(s.skipped.page, 1);
  // A minute later exactly one probe goes out …
  const probe = shouldAttempt(s, "page", now + CAPTURE_RETRY_EVERY_MS);
  assert.equal(probe.attempt, true);
  assert.equal(probe.probing, true);
  assert.equal(probe.timeoutMs, CAPTURE_PROBE_TIMEOUT_MS, "a probe runs under the short ceiling");
  // … and a second attempt in the same minute is skipped again.
  assert.equal(shouldAttempt(s, "page", now + CAPTURE_RETRY_EVERY_MS + 5000).attempt, false);
  // The probe fails: still suspended, still one per minute.
  recordShot(s, "page", false, now + CAPTURE_RETRY_EVERY_MS + 15_000, 15_000);
  assert.equal(shouldAttempt(s, "page", now + CAPTURE_RETRY_EVERY_MS + 30_000).attempt, false);
  // The next probe succeeds: fully re-armed, the following attempt is not a probe.
  const probe2 = shouldAttempt(s, "page", now + 2 * CAPTURE_RETRY_EVERY_MS + 15_000);
  assert.equal(probe2.attempt, true);
  recordShot(s, "page", true, now + 2 * CAPTURE_RETRY_EVERY_MS + 15_200, 200);
  assert.equal(s.suspendedAtMs.page, null);
  assert.equal(s.streak.page, 0);
  const after = shouldAttempt(s, "page", now + 2 * CAPTURE_RETRY_EVERY_MS + 20_000);
  assert.equal(after.attempt, true);
  assert.equal(after.probing, false);
});

test("the two kinds break independently: a dead page path does not gate the canvas element, and vice versa", () => {
  const s = createCaptureBreaker();
  for (let i = 0; i < CAPTURE_FAILURE_STREAK; i++) recordShot(s, "page", false, i * 15_000, 15_000);
  assert.equal(shouldAttempt(s, "page", 50_000).attempt, false);
  assert.equal(shouldAttempt(s, "element", 50_000).attempt, true);
  assert.equal(s.skipped.element, 0);
});

test("the time budget gates every kind once the wall clock inside failed shots is spent, even with no streak", () => {
  const s = createCaptureBreaker();
  // Alternate one failure and one success, staying UNDER the budget: no streak
  // ever reaches 3 and nothing is gated …
  let now = 0;
  while (s.failedTimeMs + 15_000 < CAPTURE_TIME_BUDGET_MS) {
    assert.equal(shouldAttempt(s, "page", now).attempt, true);
    recordShot(s, "page", false, now + 15_000, 15_000);
    now += 15_000;
    assert.equal(shouldAttempt(s, "page", now).attempt, true);
    recordShot(s, "page", true, now + 200, 200);
    now += 200;
  }
  assert.equal(s.streak.page, 0, "no streak");
  assert.equal(s.budgetExhaustedAtMs, null, "still under the budget");
  // … the failure that crosses it gates BOTH kinds: the element kind, which
  // never failed itself, is skipped inside the minute and probed once after it.
  assert.equal(shouldAttempt(s, "page", now).attempt, true);
  recordShot(s, "page", false, now + 15_000, 15_000);
  now += 15_000;
  assert.notEqual(s.budgetExhaustedAtMs, null);
  const skipped = shouldAttempt(s, "element", now + 1000);
  assert.equal(skipped.attempt, false);
  assert.match(skipped.why ?? "", /budget/);
  assert.match(shouldAttempt(s, "page", now + 2000).why ?? "", /budget/);
  const probe = shouldAttempt(s, "element", now + CAPTURE_RETRY_EVERY_MS);
  assert.equal(probe.attempt, true, "one probe of the element kind a minute after the budget ran out");
  assert.equal(probe.probing, true);
  // A probe that succeeds re-arms the gate; the spent time stays counted, so
  // the very next failure re-exhausts it at once.
  recordShot(s, "element", true, now + CAPTURE_RETRY_EVERY_MS + 200, 200);
  assert.equal(s.budgetExhaustedAtMs, null);
  assert.equal(shouldAttempt(s, "page", now + CAPTURE_RETRY_EVERY_MS + 1000).attempt, true);
  recordShot(s, "page", false, now + CAPTURE_RETRY_EVERY_MS + 16_000, 15_000);
  assert.notEqual(s.budgetExhaustedAtMs, null);
});

test("the summary and the sentence say what was skipped and never claim the project did not respond", () => {
  const s = createCaptureBreaker();
  for (let i = 0; i < CAPTURE_FAILURE_STREAK; i++) recordShot(s, "page", false, i * 15_000, 15_000);
  shouldAttempt(s, "page", 46_000);
  shouldAttempt(s, "page", 47_000);
  const summary = captureBreakerSummary(s);
  assert.equal(summary.skipped.page, 2);
  assert.equal(summary.failedTimeMs, 45_000);
  const sentence = captureBreakerSentence(s) ?? "";
  assert.match(sentence, /page screenshots were suspended/);
  assert.match(sentence, /2 capture\(s\) were skipped/);
  assert.match(sentence, /evidence-insufficient rather than as a project that did not respond/);
  assert.doesNotMatch(sentence, /the project did not respond\./);
});

/* ------------------------------------------------------------ capture lane */

test("a timeout does not permit overlapping capture; late completion is discarded", async () => {
  const run = createCaptureLane();
  let finish!: (v: number) => void;
  const pending = new Promise<number>((r) => {
    finish = r;
  });
  assert.equal((await run(() => pending, 5)).failure, "capture-timeout");
  let called = false;
  assert.equal(
    (
      await run(async () => {
        called = true;
        return 2;
      }, 5)
    ).failure,
    "capture-in-flight",
  );
  assert.equal(called, false);
  finish(1);
  await setImmediate();
  assert.equal((await run(async () => 3, 50)).value, 3);
});

test("rejection releases the lane and reports unavailable evidence", async () => {
  const run = createCaptureLane();
  assert.equal(
    (
      await run(async () => {
        throw new Error("tainted canvas");
      }, 50)
    ).failure,
    "capture-rejected",
  );
  assert.equal((await run(async () => 0, 50)).value, 0);
});

/* ------------------------------------------------------------ context loss */

test("THE MEASURED CASE: a throwaway capability context dies and the project renders on", () => {
  // Measured on a small golf project: two contexts created 5ms apart; the 300x150
  // probe context is discarded at 1599ms; rAF ran to 110147ms without a drop.
  const v = classifyContextLosses([{ t: 1599, kind: "webglcontextlost" }], 110_146.8);
  assert.equal(v.fatal.length, 0, "a project that rendered 108s past the event did not fail");
  assert.equal(v.survived.length, 1);
  assert.match(v.survived[0].why, /not the one rendering/);
});

test("a loss the project recovers from is the survival kit working, not a defect", () => {
  const v = classifyContextLosses(
    [
      { t: 4000, kind: "webglcontextlost" },
      { t: 4200, kind: "webglcontextrestored" },
    ],
    null, // no rAF evidence at all — the restore alone must excuse it
  );
  assert.equal(v.fatal.length, 0);
  assert.match(v.survived[0].why, /restored at 4200ms/);
});

test("a loss that ends the render loop is fatal", () => {
  // The loop stops 300ms later: under the survival window, and never restored.
  const v = classifyContextLosses([{ t: 8000, kind: "webglcontextlost" }], 8_300);
  assert.equal(v.fatal.length, 1);
  assert.equal(v.fatal[0].t, 8000);
  assert.equal(v.survived.length, 0);
});

test("a restore BEFORE the loss does not excuse it — order is load-bearing", () => {
  const v = classifyContextLosses(
    [
      { t: 1000, kind: "webglcontextrestored" },
      { t: 9000, kind: "webglcontextlost" },
    ],
    9_100,
  );
  assert.equal(v.fatal.length, 1, "an earlier restore belongs to an earlier loss");
});

test("missing rAF evidence never excuses a loss on its own", () => {
  const v = classifyContextLosses([{ t: 500, kind: "webglcontextlost" }], null);
  assert.equal(v.fatal.length, 1, "absent evidence is not evidence of survival");
});

test("the survival window is exclusive at the boundary in the right direction", () => {
  const at = 1_000;
  const justUnder = classifyContextLosses([{ t: at, kind: "webglcontextlost" }], at + CONTEXT_LOSS_SURVIVAL_MS - 1);
  const exactly = classifyContextLosses([{ t: at, kind: "webglcontextlost" }], at + CONTEXT_LOSS_SURVIVAL_MS);
  assert.equal(justUnder.fatal.length, 1);
  assert.equal(exactly.fatal.length, 0);
});

test("creation errors are not losses and are never classified here", () => {
  const v = classifyContextLosses([{ t: 100, kind: "webglcontextcreationerror" }], null);
  assert.equal(v.fatal.length, 0);
  assert.equal(v.survived.length, 0);
});

test("several losses are judged one at a time", () => {
  const v = classifyContextLosses(
    [
      { t: 1_000, kind: "webglcontextlost" }, // survived: rAF ran far past it
      { t: 50_000, kind: "webglcontextlost" }, // fatal: loop stopped right after
    ],
    50_100,
  );
  assert.equal(v.survived.length, 1);
  assert.equal(v.fatal.length, 1);
  assert.equal(v.fatal[0].t, 50_000);
});

/* ------------------------------------------------------------ dark phase */

function sample(low: number, high: number) {
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) {
    const n = i % 2 ? low : high;
    data.set([n, n, n, 255], i * 4);
  }
  return { file: "frames/dark.png", phase: ProbePhase.Soak, report: exposureReport({ width: 64, height: 64, data }) };
}
const review = {
  files: ["frames/dark.png"],
  phase: "darkest playable phase",
  interactionReadable: true,
  note: "Interaction objects and traversal inspected independently of HUD",
};
test("dark-phase floor uses real 4x4 measurement; no change to historical median", () => {
  assert.equal(darkPhaseAcceptance([sample(3, 13)], review).result, "fail");
  assert.equal(darkPhaseAcceptance([sample(20, 60)], review).result, "pass");
  assert.equal(darkPhaseAcceptance([sample(240, 255)], review).result, "fail");
});
test("bright HUD cannot override unreadable interaction; absent evidence remains unknown", () => {
  assert.equal(darkPhaseAcceptance([sample(20, 230)], { ...review, interactionReadable: false }).result, "fail");
  assert.equal(darkPhaseAcceptance([sample(20, 60)]).result, "unknown");
  assert.equal(darkPhaseAcceptance([], review).result, "unknown");
});

/* ------------------------------------------------------------ boot observation */

test("entry never fetched and capture unavailable are different observations", () => {
  const base = {
    entryRequested: false,
    entryStatus: null,
    canvasCount: 0,
    animationFrames: 0,
    nonDegenerateDraw: false,
  };
  assert.equal(classifyBootObservation(base), "entry-not-requested");
  assert.equal(
    classifyBootObservation({ ...base, entryRequested: true, entryStatus: 200, canvasCount: 1, animationFrames: 606 }),
    "entry-loaded-no-draw",
  );
  assert.equal(
    classifyBootObservation({
      ...base,
      entryRequested: true,
      entryStatus: 200,
      canvasCount: 1,
      animationFrames: 606,
      nonDegenerateDraw: true,
    }),
    "draw-observed",
  );
  assert.equal(classifyBootObservation({ ...base, entryRequested: true, entryStatus: 403 }), "entry-http-failed");
});
test("diagnostic URLs omit queries and fragments", () => {
  assert.equal(diagnosticUrl("https://example.com/play?credential=private#identity"), "https://example.com/play");
  assert.equal(diagnosticUrl("about:blank"), "about:");
});
