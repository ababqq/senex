/**
 * THE INTERACT VERB: KeyF (the vendored controller kit's binding), KeyE and Enter, each measured by
 * `measureVerb` under phase `interact` so its frames reach the judge for a checklist item that needs
 * it (talk to the villager, open the door). `l2.interact_acknowledged` is `pass` or `unknown` and
 * NEVER `fail`: a project may honestly have no interact verb. Being pass-or-unknown by construction, it
 * carries `gates: false` and never decides the L2 gate.
 */
import { CheckResult, ProbeRow } from "../../vocabulary.ts";
import type { Check } from "../types.ts";
import { verbPixelExceededControl } from "../verdicts.ts";
import { machineRow } from "./row.ts";
import { refusedClause, type VerbAcknowledgement } from "./verbs.ts";

/** The interact keys, in the order they are pressed. */
export const INTERACT_KEYS = ["KeyF", "KeyE", "Enter"] as const;

/** An acknowledgement that counts: audio, or pixels that beat the matched control window. */
export function acknowledged(v: VerbAcknowledgement): boolean {
  return v.audioLatencyMs !== null || verbPixelExceededControl(v) === true;
}

/** A pixel change that cleared the threshold and not the control window: ambient motion. */
function ambientOnly(v: VerbAcknowledgement): boolean {
  return v.pixelLatencyMs !== null && v.audioLatencyMs === null && verbPixelExceededControl(v) !== true;
}

function describeHit(v: VerbAcknowledgement): string {
  const parts: string[] = [];
  if (verbPixelExceededControl(v) === true && v.pixelLatencyMs !== null) {
    parts.push(
      `pixels at ${v.pixelLatencyMs.toFixed(0)}ms, ${(v.pixelDelta ?? 0).toFixed(4)} against a pre-verb control max of ${(v.pixelControlMax ?? 0).toFixed(4)} over ${v.pixelControlSamples} readings`,
    );
  }
  if (v.audioLatencyMs !== null) parts.push(`audio at ${v.audioLatencyMs.toFixed(0)}ms`);
  return `${v.verb} (${parts.join(", ")})`;
}

function describeAmbient(v: VerbAcknowledgement, windowMs: number): string {
  const delta = (v.pixelDelta ?? 0).toFixed(4);
  if (v.pixelControlMax === null || v.pixelControlSamples === 0) {
    return `${v.verb} produced a pixel change above the threshold (${delta}) but no sampler reading fell in the ${windowMs}ms before it, so there is no control to compare against and it is not counted`;
  }
  return `${v.verb} produced a pixel change above the threshold (${delta}) that did NOT exceed the pre-verb control window's maximum (${v.pixelControlMax.toFixed(4)} over ${v.pixelControlSamples} readings): ambient motion, not an acknowledgement`;
}

/** `l2.interact_acknowledged`: pass or unknown, never fail, never gating. */
export function interactRow(verbs: readonly VerbAcknowledgement[], ackWindowMs: number): Check {
  const hits = verbs.filter(acknowledged);
  const ambient = verbs.filter(ambientOnly);
  const ambientClause = ambient.length ? ` ${ambient.map((v) => describeAmbient(v, ackWindowMs)).join("; ")}.` : "";
  const refused = refusedClause(verbs);
  const sent = verbs.filter((v) => v.sent).map((v) => v.verb);
  const value = {
    window: ackWindowMs,
    verbs,
    acknowledged: hits.map((v) => v.verb),
    ambientOnly: ambient.map((v) => v.verb),
  };
  if (hits.length) {
    const detail = `${hits.map(describeHit).join(", ")} produced a change within ${ackWindowMs}ms that beat the change threshold and the matched pre-verb control window.${ambientClause}${refused} The frames under phase "interact" are what the judge reads for an item that needs the interact verb.`;
    return machineRow(ProbeRow.L2InteractAcknowledged, CheckResult.Pass, detail, value, false);
  }
  const detail = sent.length
    ? `None of the interact keys that went out (${sent.join(", ")}) produced an audio change, or a pixel change that beat both the threshold and the matched control window, within ${ackWindowMs}ms.${ambientClause}${refused} A project may have no interact verb, so this is unknown and never a failure.`
    : `No interact key went out at all:${refused} Nothing here observed the interact verb, so this is unknown and never a failure.`;
  return machineRow(ProbeRow.L2InteractAcknowledged, CheckResult.Unknown, detail, value, false);
}
