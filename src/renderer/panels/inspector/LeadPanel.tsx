/** The card of the lead, while it has the run: no part is working and the build on offer has been tried. */
import type { JSX } from "react";
import { Tone } from "../../run-steps.ts";
import { Panel, Para } from "./chrome.tsx";
import { LiveScreen, useScreenTrail } from "./screen.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

export function LeadPanel(props: InspectorProps): JSX.Element {
  const { leadFrame } = props;
  const trail = useScreenTrail(leadFrame);
  const open = (src: string, caption: string): void =>
    props.onLight([{ path: null, src, title: "The lead", caption }], 0);
  return (
    <Panel
      id={GraphSelection.Lead}
      label="The lead"
      title="The lead"
      status={<Status tone={Tone.Accent}>Working on the next step</Status>}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
      reply={{ label: "The lead", placeholder: "Anything the lead should do next?" }}
      onReply={props.onReply}
      media={
        leadFrame ? (
          <LiveScreen frame={leadFrame} trail={trail} label="The lead's view of the project" onOpen={open} />
        ) : null
      }
    >
      <Para>
        No part is working right now. The lead is deciding what comes next, or changing the project itself; a new part
        shows up here when it starts one.
      </Para>
    </Panel>
  );
}
