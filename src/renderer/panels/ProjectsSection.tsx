/** Settings → Projects: the folder new projects are created in. */
import { useState, type JSX } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { problemWords } from "../words.ts";

/** The section's own words. */
const WORDS = {
  title: "Default project folder",
  hint: "New projects are created here. Projects you already have stay where they are.",
  change: "Change…",
  choosing: "Choosing…",
} as const;

/** A path as its parent ("~/") and its own folder ("AI Projects"): the parent is cut first when it is long. */
function pathParts(label: string): { parent: string; leaf: string } {
  const cut = label.replace(/\/+$/, "").lastIndexOf("/");
  return cut < 0 ? { parent: "", leaf: label } : { parent: label.slice(0, cut + 1), leaf: label.slice(cut + 1) };
}

export function ProjectsSection({
  rootLabel,
  onRoot,
}: {
  rootLabel: string;
  onRoot: (label: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const label = await window.studio.chooseProjectsRoot();
      if (label) onRoot(label);
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setBusy(false);
    }
  };
  const { parent, leaf } = pathParts(rootLabel);
  return (
    <div data-projects-settings className="appearance-section">
      <section aria-label={WORDS.title} className="settings-card">
        <h3 className="settings-card-title">{WORDS.title}</h3>
        <div className="mt-2.5 flex min-w-0 items-center gap-2">
          <div data-projects-root title={rootLabel} className="settings-path">
            <Icon name="folder" size={14} className="shrink-0 text-ink-3" />
            <span className="min-w-0 truncate text-ink-3">{parent}</span>
            <span className="shrink-0 whitespace-nowrap text-ink">{leaf}</span>
          </div>
          <Button disabled={busy} onClick={() => void choose()} className="h-9">
            {busy ? WORDS.choosing : WORDS.change}
          </Button>
        </div>
        <p className="mt-2.5 text-ink-3">{WORDS.hint}</p>
      </section>
      {error && (
        <p role="alert" className="mt-2 text-red">
          {error}
        </p>
      )}
    </div>
  );
}
