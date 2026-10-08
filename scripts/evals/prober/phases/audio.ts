/**
 * AUDIO, FIVE ANSWERS, NEVER ONE BOOLEAN: a file arrived over the network, an AudioContext is running,
 * the graph reaches the destination, the analyser tapped onto the destination heard something, a
 * media element is playing. A project that synthesises sound in WebAudio legitimately fails the network
 * row while passing the other four; that combination is what a one-boolean version got wrong.
 *
 * A silent network fails only INSIDE the project: a title screen that loads its music on entry produces
 * the same zero, so without interaction reached the network row is `unknown`, naming why.
 */
import { CheckResult, ProbeRow } from "../../vocabulary.ts";
import type { InstrumentSnapshot } from "../driver.ts";
import { mean, percentile } from "../frames.ts";
import type { ProbeRms } from "../instrument.ts";
import type { Check, NetworkEntry } from "../types.ts";
import type { InteractionReached } from "../verdicts.ts";
import { machineRow } from "./row.ts";
import { AUDIBLE_RMS } from "./verbs.ts";

/** The fewest analyser readings an output verdict stands on. */
export const MIN_RMS_SAMPLES = 10;
/** An audio file by its extension. */
export const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|opus|flac|aac)(\?|$)/i;
/** How many audio URLs the facts keep. */
export const AUDIO_URLS_KEPT = 40;
/** The state a context must end in to count as running. */
export const RUNNING_STATE = "running";
const P95 = 0.95;
const HTTP_ERROR_MIN = 400;

/** A request that got a success response. */
const arrived = (e: NetworkEntry) => e.failure === null && e.status !== null && e.status < HTTP_ERROR_MIN;

type AudioRecord = NonNullable<InstrumentSnapshot["audio"]>;
type MediaElement = AudioRecord["elements"][number];

/** The five facts the audio rows read. */
export interface AudioFacts {
  network: { files: number; urls: string[] };
  contexts: Array<{ id: number; sampleRate: number; finalState: string }>;
  graph: { edges: number; edgesToDestination: number; distinctSources: number };
  output: { samples: number; peakRms: number; p95Rms: number; meanRms: number; audibleSamples: number };
  elements: MediaElement[];
}

/** Gather the five facts from the snapshot, the analyser series and the network log. */
export function audioFacts(
  snap: InstrumentSnapshot | null,
  rms: readonly ProbeRms[],
  network: readonly NetworkEntry[],
): AudioFacts {
  const audio = snap?.audio;
  const files = network.filter((e) => AUDIO_EXT.test(e.url) && arrived(e));
  const values = rms.map((s) => s.rms);
  return {
    network: { files: files.length, urls: files.map((e) => e.url).slice(0, AUDIO_URLS_KEPT) },
    contexts: (audio?.contexts ?? []).map((c) => ({ id: c.id, sampleRate: c.sampleRate, finalState: c.finalState })),
    graph: {
      edges: audio?.edgesTotal ?? audio?.edges?.length ?? 0,
      edgesToDestination: audio?.edgesToDestination ?? 0,
      distinctSources: audio?.distinctSources ?? 0,
    },
    output: {
      samples: values.length,
      peakRms: values.reduce((peak, v) => Math.max(peak, v), audio?.peakRms ?? 0),
      p95Rms: percentile(values, P95),
      meanRms: mean(values),
      audibleSamples: values.filter((v) => v > AUDIBLE_RMS).length,
    },
    elements: audio?.elements ?? [],
  };
}

function networkRow(f: AudioFacts, interaction: InteractionReached): Check {
  const id = ProbeRow.L3AudioNetwork;
  const value = { ...f.network, interactionReached: interaction.reached, interactionWhy: interaction.why };
  if (f.network.files > 0) {
    const detail = `${f.network.files} audio file(s) arrived. This says bytes arrived, nothing about whether they were played.`;
    return machineRow(id, CheckResult.Pass, detail, value);
  }
  if (interaction.reached) {
    const detail = `No audio file arrived, on a run that reached interaction (${interaction.why}). A project synthesising sound in WebAudio looks like this too, which is why the other four rows are separate.`;
    return machineRow(id, CheckResult.Fail, detail, value);
  }
  const detail = `No audio file arrived, but interaction was never reached (${interaction.why}), and a title screen that loads its music on entry produces the same silence.`;
  return machineRow(id, CheckResult.Unknown, detail, value);
}

function contextRow(f: AudioFacts): Check {
  const id = ProbeRow.L3AudioContextState;
  const running = f.contexts.filter((c) => c.finalState === RUNNING_STATE).length;
  const value = { contexts: f.contexts, running };
  if (!f.contexts.length) {
    return machineRow(
      id,
      CheckResult.Unknown,
      "No AudioContext was ever constructed, so there is no state to report.",
      value,
    );
  }
  if (running) {
    const detail = `${running}/${f.contexts.length} context(s) ended "${RUNNING_STATE}". A trusted click went out before this was read, so a suspended context is not an autoplay artefact of the probe.`;
    return machineRow(id, CheckResult.Pass, detail, value);
  }
  const states = f.contexts.map((c) => c.finalState).join("/");
  return machineRow(
    id,
    CheckResult.Fail,
    `All ${f.contexts.length} context(s) are ${states}: created but never resumed.`,
    value,
  );
}

function graphRow(f: AudioFacts): Check {
  const id = ProbeRow.L3AudioGraphEdges;
  if (!f.contexts.length)
    return machineRow(id, CheckResult.Unknown, "No AudioContext, so no graph to inspect.", f.graph);
  if (f.graph.edgesToDestination > 0) {
    const detail = `${f.graph.edgesToDestination} connect() call(s) reached an AudioDestinationNode across ${f.graph.distinctSources} distinct source node type(s).`;
    return machineRow(id, CheckResult.Pass, detail, f.graph);
  }
  const detail = `${f.graph.edges} connect() call(s) were made and none reached a destination: the graph is built but not plugged in.`;
  return machineRow(id, CheckResult.Fail, detail, f.graph);
}

function outputRow(f: AudioFacts): Check {
  const id = ProbeRow.L3AudioOutputRms;
  const o = f.output;
  const value = { ...o, threshold: AUDIBLE_RMS, minimumSamples: MIN_RMS_SAMPLES };
  if (o.samples < MIN_RMS_SAMPLES) {
    const detail = `Only ${o.samples} analyser reading(s) were observed; at least ${MIN_RMS_SAMPLES} are needed to judge audible output.`;
    return machineRow(id, CheckResult.Unknown, detail, value);
  }
  const peak = o.peakRms.toFixed(5);
  if (o.peakRms > AUDIBLE_RMS) {
    const detail = `Peak RMS ${peak} over ${o.samples} readings, ${o.audibleSamples} of them above ${AUDIBLE_RMS}.`;
    return machineRow(id, CheckResult.Pass, detail, value);
  }
  const detail = `Peak RMS ${peak} over ${o.samples} readings never cleared ${AUDIBLE_RMS}. The graph may be connected and still silent.`;
  return machineRow(id, CheckResult.Fail, detail, value);
}

function elementState(e: MediaElement): string {
  if (e.error) return `error ${e.error}`;
  return e.paused ? "paused" : "idle";
}

function elementRow(f: AudioFacts): Check {
  const id = ProbeRow.L3AudioElementState;
  const playing = f.elements.filter((e) => e.everPlayed && !e.paused).length;
  const value = { elements: f.elements, playing };
  if (!f.elements.length) {
    const detail =
      "This project uses no HTMLMediaElement at all: a normal choice (WebAudio only), unknown rather than a failure.";
    return machineRow(id, CheckResult.Unknown, detail, value);
  }
  if (playing)
    return machineRow(
      id,
      CheckResult.Pass,
      `${playing}/${f.elements.length} media element(s) are playing and unpaused.`,
      value,
    );
  const states = f.elements.map(elementState).join(", ");
  return machineRow(
    id,
    CheckResult.Fail,
    `${f.elements.length} media element(s) exist but none is playing (${states}).`,
    value,
  );
}

/** The five audio rows, in `ProbeRow` order. */
export function audioRows(f: AudioFacts, interaction: InteractionReached): Check[] {
  return [networkRow(f, interaction), contextRow(f), graphRow(f), outputRow(f), elementRow(f)];
}
