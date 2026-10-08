/**
 * A project file opened beside the chat: Markdown or an image the chat names (shared/chat-files.ts
 * finds the names). Main reads it inside the project — its folder, or the build a run made that has
 * not been landed yet — and never anywhere else.
 */
export type ProjectFileKind = "markdown" | "text" | "image" | "other";

export interface ProjectFile {
  /** Relative to the project folder, with forward slashes. */
  path: string;
  name: string;
  /** `build`: only in the run's build so far, so there is nothing in Finder to show. */
  where: "project" | "build";
  kind: ProjectFileKind;
  text?: string;
  /** Text longer than the viewer shows. */
  truncated?: boolean;
  /** Images, as a data URL. */
  src?: string;
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

export function extensionOf(file: string): string {
  const name = file.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function imageType(file: string): string | undefined {
  return IMAGE_TYPES[extensionOf(file)];
}

export function fileKind(file: string): ProjectFileKind {
  const ext = extensionOf(file);
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  return imageType(file) ? "image" : "text";
}
