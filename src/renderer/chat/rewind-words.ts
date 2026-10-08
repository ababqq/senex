/**
 * What the Rewind dialog says about the project files: whether they can go back with the chat, and
 * when they cannot, why only the conversation rewinds. Pure, so the words are tested without a DOM.
 */
import { FilesStay, type RewindFiles } from "../../shared/chat-rewind.ts";

/** The dialog's own lines beside the files. */
export const REWIND_WORDS = {
  rewind: "Rewind chat",
  rewinding: "Rewinding…",
  /** The confirmation waits for the running build to close before the chat goes back. */
  stoppingBuild: "Stopping the build…",
  checking: "Checking the project files…",
  restoreFiles: "Restore project files",
} as const;

/** Up to three file names, and how many more there are. */
const names = (files: string[]): string => {
  const shown = files
    .slice(0, 3)
    .map((file) => file.split("/").pop())
    .join(", ");
  return files.length > 3 ? `${shown} and ${files.length - 3} more` : shown;
};

type RestoreFiles = Extract<RewindFiles, { state: "restore" }>;
export interface RewindFilesWords {
  line: string | null;
  outside: string | null;
  nested: string | null;
}

/** "1 file was … stays as it is" or "3 files were … stay as they are". */
function tooLargeWords(count: number): string {
  if (count === 1) return "1 file was too large to save and stays as it is.";
  return `${count} files were too large to save and stay as they are.`;
}

/** What stays as it is whatever the rewind does: nested repositories, and files too large to save. */
function keptWords(files: RewindFiles): string | null {
  const nested = "nested" in files && files.nested.length ? files.nested : [];
  const tooLarge = files.state === "restore" ? files.tooLarge : 0;
  const lines = [
    nested.length
      ? `Files inside ${names(nested.map((name) => `${name}/`))} keep their own history and stay as they are.`
      : null,
    tooLarge ? tooLargeWords(tooLarge) : null,
  ];
  return lines.filter(Boolean).join(" ") || null;
}

/** Files changed outside this chat that a restore would put back too. */
function outsideWords(files: RestoreFiles): string | null {
  const count = files.outside.length;
  if (count)
    return `Including ${count === 1 ? "1 file" : `${count} files`} changed outside this chat: ${names(files.outside)}.`;
  return files.outsideUnknown ? "Some of them may have changed outside this chat." : null;
}

/** The chat alone goes back. */
const CHAT_ONLY = "Only the conversation rewinds";

/** Why only the conversation rewinds, one plain line each. */
const FILES_STAY_WORDS: Record<FilesStay, string> = {
  [FilesStay.BuildChanged]: `${CHAT_ONLY}: a build changed the project after this message, so its files stay as they are.`,
  [FilesStay.BuildRunning]:
    "A build is running. Rewinding stops it and cuts off any answer under way; the project’s files stay as they are.",
  [FilesStay.HistoryChanged]: `${CHAT_ONLY}: a commit changed the project after this message, so its files stay as they are.`,
  [FilesStay.NoCheckpoint]: `${CHAT_ONLY}: there’s no saved copy of the project from before this message.`,
  [FilesStay.JoinedAnswer]: `${CHAT_ONLY}: this message joined an answer already under way, so there’s no saved copy from just before it.`,
  [FilesStay.TooLarge]: `${CHAT_ONLY}: the files that changed were too large to save.`,
};

/** What the project files do when the chat goes back, in plain lines. */
export function rewindFilesWords(files: RewindFiles): RewindFilesWords {
  const nested = keptWords(files);
  switch (files.state) {
    case "restore":
      return {
        line:
          files.files === 1
            ? "1 file goes back to how it was before this message."
            : `${files.files} files go back to how they were before this message.`,
        outside: outsideWords(files),
        nested,
      };
    case "unchanged":
      return { line: "The project files haven’t changed since this message.", outside: null, nested };
    case "unavailable":
      return { line: FILES_STAY_WORDS[files.reason], outside: null, nested: null };
    case "none":
      return { line: `${CHAT_ONLY}.`, outside: null, nested: null };
  }
}

/** A restore that would also put back files changed outside this chat starts off. */
export const restoresByDefault = (files: RewindFiles): boolean =>
  !(files.state === "restore" && (files.outside.length || files.outsideUnknown));

/** The confirm button while it works: a build is stopped first, then the chat goes back. */
export const rewindBusyLabel = (stopsBuild: boolean): string =>
  stopsBuild ? REWIND_WORDS.stoppingBuild : REWIND_WORDS.rewinding;
