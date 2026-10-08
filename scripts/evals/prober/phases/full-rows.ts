/**
 * Every row of the full prober's scorecard, computed from what its phases observed with no browser.
 * The eight quick rows come from `quick-rows.ts` unchanged, except `l1.no_errors_60s`, which the full
 * probe answers over its real 60 s window instead of the quick probe's short variant. A phase that
 * never ran (the canvas never drew) leaves its rows `unknown`, saying so.
 */
import { CheckResult, ProbeRow, type RendererMode } from "../../vocabulary.ts";
import type { DarkPhaseReview } from "../dark-phase.ts";
import { fullscreenOf, pointerLockOf } from "../driver.ts";
import type { ProbeRms, ProbeSample } from "../instrument.ts";
import { type QuickObservation, quickInteraction, quickRows } from "../quick-rows.ts";
import type { Check } from "../types.ts";
import { lookInputVerdict } from "../verdicts.ts";
import { ackRow } from "./ack.ts";
import { audioFacts, audioRows } from "./audio.ts";
import type { PageBaseline } from "./baseline.ts";
import type { DirectionsResult, DragBurstResult } from "./directions.ts";
import { directionsRow } from "./directions-row.ts";
import { assetsUsableRow, frameRateRow, noErrors60sRow, ranOver } from "./health.ts";
import { interactRow } from "./interact.ts";
import { darkPhaseRow, spatiallyLegibleRow } from "./legibility.ts";
import type { LookMeasurement } from "./look.ts";
import { type MobileObservation, phoneViewportRow } from "./mobile.ts";
import { machineRow } from "./row.ts";
import type { SoakRun, SoakWindows } from "./soak.ts";
import { heapGrowth, softLockRow, survivesRow } from "./soak-rows.ts";
import type { VerbAcknowledgement } from "./verbs.ts";

/** Everything the full prober observed, as its rows read it. */
export interface FullObservation {
  /** The quick probe's observation of the same run: boot, entrance, bursts, snapshots, frames. */
  quick: QuickObservation;
  rendererMode: RendererMode;
  /** `null` for every phase that never ran because the canvas never drew. */
  directions: DirectionsResult | null;
  drag: DragBurstResult | null;
  ack: VerbAcknowledgement[] | null;
  interact: VerbAcknowledgement[] | null;
  look: LookMeasurement;
  soak: SoakRun | null;
  soakWindows: SoakWindows;
  /** The baseline current when the soak started: its stillness floor judges the soak's windows. */
  soakBaseline: PageBaseline | null;
  soakShortenedWhy: string | null;
  samples: readonly ProbeSample[];
  rms: readonly ProbeRms[];
  mobile: MobileObservation;
  darkPhaseReview?: DarkPhaseReview;
  ackWindowMs: number;
  fpsFloor: number;
}

const ROW_ORDER: readonly ProbeRow[] = Object.values(ProbeRow);
const NEVER_DREW = "The canvas never drew, so this phase never ran.";

const lastOf = <T>(list: readonly T[]): T | null => (list.length ? list[list.length - 1] : null);

/** The rows of the phases between the entrance and the soak. */
function playRows(o: FullObservation): Check[] {
  const directions = o.directions
    ? directionsRow(o.directions, o.drag)
    : machineRow(ProbeRow.L2DirectionsMatchLabels, CheckResult.Unknown, NEVER_DREW, null);
  const ack = o.ack
    ? ackRow({ verbs: o.ack, samples: o.samples, rendererMode: o.rendererMode, ackWindowMs: o.ackWindowMs })
    : machineRow(ProbeRow.L2ActionAcknowledged200ms, CheckResult.Unknown, NEVER_DREW, null);
  const interact = o.interact
    ? interactRow(o.interact, o.ackWindowMs)
    : machineRow(ProbeRow.L2InteractAcknowledged, CheckResult.Unknown, NEVER_DREW, null, false);
  return [directions, ack, interact];
}

/** The soak's two rows, with the doors a stillness fail is demoted through. */
function soakRows(o: FullObservation): Check[] {
  const last = lastOf(o.quick.snapshots);
  const lock = pointerLockOf(last);
  const doors = {
    pointerLock: lock,
    lookInput: lookInputVerdict(lock),
    fullscreen: fullscreenOf(last),
    entranceConfirmed: o.quick.entrance?.verdict.confirmed ?? false,
    interaction: quickInteraction(o.quick),
  };
  return [
    survivesRow(o.soak, heapGrowth(last?.heap), o.soakShortenedWhy),
    softLockRow(o.soak, o.soakWindows, o.soakBaseline, doors),
  ];
}

/** Every row, in `ProbeRow` order. */
export function fullRows(o: FullObservation): Check[] {
  const q = o.quick;
  const last = lastOf(q.snapshots);
  const quick = quickRows(q).filter((c) => c.id !== ProbeRow.L1NoErrors60s);
  const rows = [
    ...quick,
    noErrors60sRow(q.snapshots, q.events),
    ...playRows(o),
    ...soakRows(o),
    frameRateRow(last, o.rendererMode, o.fpsFloor),
    assetsUsableRow(q.events, ranOver(q.snapshots, q.events)),
    spatiallyLegibleRow(),
    darkPhaseRow(q.frames, q.firstRenderMs, o.darkPhaseReview),
    ...audioRows(audioFacts(last, o.rms, q.events.network), quickInteraction(q)),
    phoneViewportRow(o.mobile),
  ];
  return rows.sort((a, b) => ROW_ORDER.indexOf(a.id) - ROW_ORDER.indexOf(b.id));
}
