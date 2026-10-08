/**
 * A command a reply offered, the way a terminal-savvy chat shows it: Run and Copy as icons inside
 * the block, and once it runs, its output in a card under it. The agent cannot run what its
 * sandbox refuses; the user can, with one press, and the chat reports the result back to the agent
 * when the command ends (`use-command-results.ts`). The project's terminal dock holds the same session
 * for typing into it (a password prompt), opened from the card.
 */
import { type JSX, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { TerminalSession } from "../../shared/terminal.ts";
import { plainTerminalLines } from "../../shared/terminal-text.ts";
import { showTerminal } from "../panels/terminal-events.ts";
import { commandState, CommandState, latestRun, runStarted } from "../state/command-runs.ts";
import { useCommandRuns } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { COMMAND_WORDS } from "../words.ts";

/** How long Copy shows its check. */
const COPIED_MS = 1.5 * SECOND_MS;

/** A command still going can be stopped rather than run again. */
const isGoing = (state: CommandState | null): boolean =>
  state === CommandState.Running || state === CommandState.Stopping;

/** The card's one status line: nothing once it is done, else how it is going or why it never started. */
function stateWords(state: CommandState, session: TerminalSession): string | null {
  if (state === CommandState.Done) return null;
  if (state === CommandState.Broken) return session.error ?? COMMAND_WORDS.state.broken;
  if (state === CommandState.Failed && session.exitCode !== undefined)
    return `${COMMAND_WORDS.state.failed} · ${COMMAND_WORDS.exitCode(session.exitCode)}`;
  return COMMAND_WORDS.state[state];
}

/** Copy the command, and show a check for a moment. */
function useCopy(command: string, onProblem: (problem: string) => void) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (): void => {
    void navigator.clipboard
      .writeText(command)
      .then(() => setCopied(true))
      .catch((error) => onProblem(errorMessage(error)));
  };
  return { copied, copy };
}

export function CommandRun({
  command,
  threadId,
  project,
  entryId,
}: {
  command: string;
  threadId: string;
  project: string;
  entryId: string;
}): JSX.Element {
  const run = useCommandRuns((state) => latestRun(state, threadId, entryId, command));
  const session = useCommandRuns((state) => (run ? state.sessions[run.sessionId] : undefined));
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { copied, copy } = useCopy(command, setProblem);
  const state = session ? commandState(session) : null;
  const start = async (): Promise<void> => {
    setStarting(true);
    setProblem(null);
    try {
      const started = await window.studio.terminalRun(project, command);
      studio().commandRuns.setState(
        (current) => runStarted(current, { sessionId: started.id, threadId, entryId, command }, started),
        true,
      );
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setStarting(false);
    }
  };
  const stop = (): void => {
    if (session) void window.studio.terminalStop(session.id).catch((error) => setProblem(errorMessage(error)));
  };
  const going = isGoing(state);
  const runLabel = state ? COMMAND_WORDS.runAgain : COMMAND_WORDS.run;
  return (
    <div data-command-run>
      <div className="command-actions">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={going ? COMMAND_WORDS.stop : runLabel}
          title={going ? COMMAND_WORDS.stop : runLabel}
          disabled={starting || state === CommandState.Stopping}
          onClick={going ? stop : () => void start()}
        >
          <Icon name={going ? "stop" : "play"} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? COMMAND_WORDS.copied : COMMAND_WORDS.copy}
          title={copied ? COMMAND_WORDS.copied : COMMAND_WORDS.copy}
          onClick={copy}
        >
          <Icon name={copied ? "check" : "copy"} />
        </Button>
      </div>
      {session && state && <CommandOutputCard session={session} status={stateWords(state, session)} />}
      {problem && (
        <p role="alert" className="command-problem">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * What the command printed, drawn imperatively from the studio's output buffer as it arrives,
 * newest lines in view. Folded to a few lines; the chevron shows the rest.
 */
function CommandOutputCard({ session, status }: { session: TerminalSession; status: string | null }): JSX.Element {
  const text = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const output = studio().commandOutput;
    let frame = 0;
    const draw = (): void => {
      frame = 0;
      const node = text.current;
      if (!node) return;
      node.textContent = plainTerminalLines(output.read(session.id)).join("\n").trimEnd();
      node.scrollTop = node.scrollHeight;
      setOverflows(expanded || node.scrollHeight > node.clientHeight + 1);
    };
    draw();
    const unsubscribe = output.subscribe(session.id, () => {
      if (!frame) frame = requestAnimationFrame(draw);
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [session.id, expanded]);
  return (
    <div
      className="command-output"
      data-command-output={session.id}
      data-expanded={expanded || undefined}
      data-overflows={overflows || undefined}
    >
      <div ref={text} className="command-output-text" />
      <Button
        variant="ghost"
        size="icon-sm"
        className="command-output-terminal"
        aria-label={COMMAND_WORDS.openTerminal}
        title={COMMAND_WORDS.openTerminal}
        onClick={() => showTerminal(session.id)}
      >
        <Icon name="terminal" />
      </Button>
      {(status || overflows) && (
        <div className="command-output-foot">
          <span role="status" data-command-state={commandState(session)}>
            {status}
          </span>
          {overflows && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={expanded ? COMMAND_WORDS.showLess : COMMAND_WORDS.showAll}
              title={expanded ? COMMAND_WORDS.showLess : COMMAND_WORDS.showAll}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <Icon name="chevron-down" className={expanded ? "rotate-180" : ""} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
