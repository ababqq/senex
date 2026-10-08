import { useEffect, useMemo, useRef } from "react";
import { coverEdge } from "../../shared/cover-recipe.ts";
import { coverSignature, displayCover, type ProjectCover } from "../../shared/project-library.ts";
import { projectCoverUrl } from "../../shared/project-cover.ts";
import { animateCover, type CoverHandle } from "./cover-animation.ts";

/**
 * A project's cover sphere. `projectKey` (the project's name) gives a project without a saved look its own
 * one and keeps its sphere's clock when the row remounts. The still image underneath shows until
 * the sphere paints, and stays when there is no GPU.
 */
export function ProjectAvatar({
  cover,
  active = false,
  projectKey,
  className = "",
}: {
  cover?: ProjectCover;
  active?: boolean;
  projectKey?: string;
  className?: string;
}) {
  const src = useMemo(() => projectCoverUrl(cover, projectKey), [cover, projectKey]);
  const shown = useMemo(() => displayCover(cover, projectKey), [cover, projectKey]);
  const signature = shown ? coverSignature(shown) : "";
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<CoverHandle | null>(null);
  const activeNow = useRef(active);
  activeNow.current = active;
  useEffect(() => {
    if (!shown || !canvas.current) return;
    const registered = animateCover(canvas.current, shown, projectKey, activeNow.current);
    handle.current = registered;
    return () => {
      registered.dispose();
      handle.current = null;
    };
  }, [signature, projectKey]); // The signature names everything the sphere draws.
  useEffect(() => {
    handle.current?.active(active);
  }, [active]);
  if (!shown) return <img src={src} alt="" aria-hidden draggable={false} className={`project-avatar ${className}`} />;
  return (
    <span
      className={`project-avatar project-avatar-shader ${shown.kind === "shader" && shown.version === 2 ? "project-cover-lens" : ""} ${className}`}
      data-edge={coverEdge(shown)}
      aria-hidden
    >
      <img src={src} alt="" draggable={false} />
      <canvas ref={canvas} className="project-cover-canvas" />
    </span>
  );
}
