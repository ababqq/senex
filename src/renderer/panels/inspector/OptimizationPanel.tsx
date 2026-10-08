/** The card of the Optimization stage: each scenario measured before and after, and what was kept. */
import type { JSX } from "react";
import {
  OptimizationOutcome,
  type OptimizationResultV1,
  type ProfileSample,
  type ScenarioResult,
} from "../../../shared/optimization.ts";
import type { OptimizationNode } from "../../run-graph.ts";
import type { Tone } from "../../run-steps.ts";
import { type DetailRow, Details, Panel, Para, Row, Rows, Section } from "./chrome.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** A change smaller than this reads as none at the two decimals the table prints. */
const NO_CHANGE = 0.005;

/** The stage's status word, by outcome once it has one, else by the phase it is in. */
const OPTIMIZATION_STATUS: Record<string, string> = {
  [OptimizationOutcome.Improved]: "Kept",
  [OptimizationOutcome.NoImprovement]: "No verified improvement",
  [OptimizationOutcome.Skipped]: "Skipped",
  [OptimizationOutcome.Failed]: "Failed",
  [OptimizationOutcome.Interrupted]: "Interrupted",
  pending: "Waiting",
  verifying_baseline: "Verifying project",
  profiling_baseline: "Measuring before",
  building_candidate: "Optimizing",
  validating_candidate: "Checking preservation",
  profiling_candidate: "Comparing before and after",
  final_quality: "Final verification",
  adopting: "Keeping verified change",
};

/** The measurements the table shows, in order, with their labels. */
const METRIC_LABEL: Record<string, string> = {
  fps: "FPS",
  frameMs: "Frame interval (ms)",
  drawCalls: "World draw calls",
  triangles: "World triangles",
};

const OUTCOME_TONE: Partial<Record<string, Tone>> = {
  [OptimizationOutcome.Improved]: "green",
  [OptimizationOutcome.Failed]: "red",
};

/** The Optimization stage's status in a few words. */
export function optimizationStatus(node: OptimizationNode): string {
  return OPTIMIZATION_STATUS[node.result.outcome ?? node.result.phase] ?? "Working";
}

/** The median of one metric over the samples, or null when any sample lacks a finite value for it. */
function median(samples: ProfileSample[], key: string): number | null {
  const values = samples.map((sample) => sample.metrics?.[key]?.value);
  const measured = values.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (!values.length || measured.length !== values.length) return null;
  const sorted = measured.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** The change from before to after as the table prints it: signed, two decimals, zero when too small to show. */
function changeWords(before: number, after: number, comparable: boolean): string {
  if (!comparable) return "Not comparable";
  const change = after - before;
  if (Math.abs(change) < NO_CHANGE) return "0.00";
  return `${change > 0 ? "+" : ""}${change.toFixed(2)}`;
}

function MetricRow({
  scenario,
  metric,
  label,
}: {
  scenario: ScenarioResult;
  metric: string;
  label: string;
}): JSX.Element {
  const a = median(scenario.before, metric);
  const b = median(scenario.after, metric);
  const reason =
    scenario.before[0]?.metrics?.[metric]?.reason ??
    scenario.after[0]?.metrics?.[metric]?.reason ??
    "insufficient samples";
  return (
    <tr>
      <td className="py-1">{label}</td>
      {a === null || b === null ? (
        <td colSpan={3}>Not measured — {reason}</td>
      ) : (
        <>
          <td>{a.toFixed(2)}</td>
          <td>{b.toFixed(2)}</td>
          <td>{changeWords(a, b, scenario.comparison.comparable)}</td>
        </>
      )}
    </tr>
  );
}

function ScenarioTable({ scenario }: { scenario: ScenarioResult }): JSX.Element {
  return (
    <Section label={scenario.workload?.demo ? `Demo: ${String(scenario.workload.demo)}` : "Default view"}>
      <table className="w-full text-left text-micro text-ink-2">
        <thead className="text-ink-3">
          <tr>
            <th className="font-normal">Measurement</th>
            <th className="font-normal">Before</th>
            <th className="font-normal">After</th>
            <th className="font-normal">Change</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(METRIC_LABEL).map(([metric, label]) => (
            <MetricRow key={metric} scenario={scenario} metric={metric} label={label} />
          ))}
        </tbody>
      </table>
      <Para quiet>{scenario.comparison.reason}</Para>
    </Section>
  );
}

/** The technical rows of the stage: its revisions, preservation, report, and each scenario's renderer. */
const optimizationRows = (r: OptimizationResultV1): DetailRow[] => [
  ["baseline version", r.baseline?.commit ?? null],
  ["candidate version", r.candidate?.commit ?? null],
  ["retained version", r.retainedRevision?.commit ?? null],
  ["preservation", r.preservation.status],
  ["changed files", r.changedFiles.join(", ") || null],
  ["report", r.reportPath],
  ...r.scenarios.flatMap((s): DetailRow[] => [
    ["backend", s.before[0]?.backend ?? null],
    ["renderer", s.before[0]?.renderer ?? null],
    ["Three version", s.before[0]?.version ?? null],
    ["counter scope", s.before[0]?.scope ?? null],
  ]),
];

/** The panel of the Optimization stage. */
export function OptimizationPanel(props: InspectorProps & { node: OptimizationNode }): JSX.Element {
  const r = props.node.result;
  return (
    <Panel
      id={GraphSelection.Optimization}
      label="Optimization"
      title="Optimization"
      sub={r.summary}
      status={<Status tone={OUTCOME_TONE[r.outcome ?? ""] ?? "muted"}>{optimizationStatus(props.node)}</Status>}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
    >
      {r.candidate ? <Para>{r.candidateAdopted ? "Candidate kept." : "Candidate not kept."}</Para> : null}
      {r.scenarios.map((s) => (
        <ScenarioTable key={s.id} scenario={s} />
      ))}
      {!r.scenarios.length ? <Para quiet>Not measured — {r.reason ?? "Measurement has not completed"}</Para> : null}
      <Rows>
        <Row label="Technical details">
          <Details rows={optimizationRows(r)} />
        </Row>
      </Rows>
    </Panel>
  );
}
