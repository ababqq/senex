/**
 * The chat header's export: copy a project's public files out, one export at a time, and say what
 * was included.
 */
import { useRef, useState } from "react";
import { type Notify, notifyProblem, ToastTone } from "../state/toasts.ts";
import { exportedWords } from "../words.ts";

export interface ChatExport {
  /** An export is running. */
  exporting: boolean;
  /** The header's handler for a project's export; a second click while one runs does nothing. */
  exportProject(project: string): () => void;
}

export function useChatExport(onNotice: Notify): ChatExport {
  const [exporting, setExporting] = useState(false);
  // A ref as well as the state: two clicks in one frame both see the state before it changes.
  const pending = useRef(false);
  const exportProject = (project: string) => () => {
    if (pending.current) return;
    pending.current = true;
    setExporting(true);
    void window.studio
      .exportProject(project)
      .then((result) => onNotice(exportedWords(result), ToastTone.Ok))
      .catch(notifyProblem(onNotice))
      .finally(() => {
        pending.current = false;
        setExporting(false);
      });
  };
  return { exporting, exportProject };
}
