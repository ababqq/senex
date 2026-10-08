/** Asset inventory with local image, media, model and animation previews. */
import type { JSX } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetJobStalled, type ProjectAsset } from "../../shared/project-assets.ts";
import { foldMotions, type FoldedMotions } from "../../shared/model-rig.ts";
import { layoutAssets, type PendingJob } from "../assets-layout.ts";
import { useCanvasView, gridTransform } from "../canvas-view.ts";
import { boundsOf } from "../run-graph.ts";
import { useLibrary } from "../state/hooks.ts";
import { assetsOf } from "../state/library.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { AssetPreview } from "./AssetPreview.tsx";
import { AssetTile } from "./AssetTile.tsx";
import { AudioTile } from "../chat/AudioStrip.tsx";
import { useModelRigs } from "../model-rigs.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { typingIn } from "./keyboard.ts";
import { Pending } from "../ui/Pending.tsx";

const NO_PENDING: PendingJob[] = [];
/** Nothing folded: before the models' headers are read. */
const NOTHING_FOLDED: FoldedMotions = { clipsOf: new Map(), loose: [], motions: new Set() };
/** The canvas's dot grid, in canvas pixels, and one press of zoom in or out. */
const GRID_PX = 22;
const ZOOM_STEP = 1.2;

type Layout = ReturnType<typeof layoutAssets>;
type Group = Layout["groups"][number];
type Job = Group["jobs"][number];

interface Props {
  project: string;
  focusJob?: string | null;
  onNotice: Notify;
}

/** A job still on its way: what was asked, and whether it needs attention. */
function PendingCard({ layout, group, job }: { layout: Layout; group: Group; job: Job }): JSX.Element | null {
  const rect = layout.rects[`pending:${group.source}:${job.jobId ?? ""}`];
  if (!rect) return null;
  return (
    <div
      data-asset-pending={job.jobId ?? ""}
      className="absolute flex flex-col justify-center gap-2 rounded-card bg-surface p-3"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <span className="text-chat-sub text-ink-2">
        {assetJobStalled(job.status) ? "Asset request needs attention" : "Creating asset…"}
      </span>
      {job.prompt && <span className="line-clamp-3 text-micro text-ink-3">{job.prompt}</span>}
    </div>
  );
}

/** Every group of the inventory: its heading, its jobs still on their way, and its asset cards. */
const AssetGroups = memo(function AssetGroups({
  layout,
  project,
  assets,
  selected,
  folded,
  onOpen,
}: {
  layout: Layout;
  project: string;
  assets: ProjectAsset[];
  selected: string | null;
  folded: FoldedMotions;
  onOpen: (asset: ProjectAsset) => void;
}): JSX.Element {
  const companions = useMemo(() => assets.map((a) => a.assetRef ?? a.file), [assets]);
  const tile = (asset: ProjectAsset): JSX.Element =>
    asset.kind === "audio" ? (
      <AudioTile project={project} asset={asset} onOpen={() => onOpen(asset)} />
    ) : (
      <AssetTile
        project={project}
        asset={asset}
        companions={companions}
        clips={folded.clipsOf.get(asset.file)?.length ?? 0}
        motion={folded.motions.has(asset.file)}
        onOpen={() => onOpen(asset)}
      />
    );
  const card = (group: Group, asset: ProjectAsset): JSX.Element | null => {
    const rect = layout.rects[`asset:${asset.file}`];
    if (!rect) return null;
    return (
      <div
        key={asset.file}
        data-asset-card={asset.file}
        data-asset-kind={asset.kind}
        data-asset-source={group.source}
        className="absolute rounded-card"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          boxShadow: selected === asset.file ? "0 0 0 1.5px var(--accent)" : undefined,
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {tile(asset)}
      </div>
    );
  };
  return (
    <>
      {layout.groups.map((group) => {
        const head = layout.rects[group.id];
        if (!head) return null;
        return (
          <div key={group.id}>
            <div className="absolute flex items-baseline gap-2" style={{ left: head.x, top: head.y, width: head.w }}>
              <span className="text-body-sm font-medium text-ink">{group.label}</span>
            </div>
            {group.jobs.map((job) => (
              <div key={job.id}>
                {job.pending && <PendingCard layout={layout} group={group} job={job} />}
                {job.assets.map((asset) => card(group, asset))}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
});

/** The canvas with nothing on it: why it could not load, that it is loading, or that nothing has landed yet. */
function EmptyAssets({
  loadError,
  loaded,
  onRetry,
}: {
  loadError: string | null | undefined;
  loaded: boolean;
  onRetry: () => void;
}): JSX.Element {
  if (loadError)
    return (
      <div role="alert" className="flex max-w-sm flex-col items-center gap-2">
        <span className="text-name font-medium text-ink">Could not load assets</span>
        <span className="text-body-sm leading-relaxed text-ink-3">{loadError}</span>
        <Button variant="outline" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  if (!loaded) return <Pending label="Loading assets…" className="text-body-sm" />;
  return (
    <EmptyState
      data-assets-empty=""
      art="assets"
      title="No assets yet"
      subtitle="Models, sounds and images land here."
    />
  );
}

function AssetsZoom({
  pct,
  onZoom,
  onFit,
}: {
  pct: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
}): JSX.Element {
  return (
    <div className="absolute bottom-2.5 left-2.5 flex h-7 items-center gap-0.5 rounded-control bg-surface px-1 shadow-btn">
      <Button
        variant="ghost"
        aria-label="Zoom out of the assets canvas"
        title="Zoom out"
        className="!h-6 !px-2"
        onClick={() => onZoom(1 / ZOOM_STEP)}
      >
        −
      </Button>
      <span className="w-10 text-center font-mono text-micro text-ink-3 tabular-nums">{pct}%</span>
      <Button
        variant="ghost"
        aria-label="Zoom into the assets canvas"
        title="Zoom in"
        className="!h-6 !px-2"
        onClick={() => onZoom(ZOOM_STEP)}
      >
        +
      </Button>
      <Button
        variant="ghost"
        aria-label="Fit every asset"
        title="Fit everything"
        className="!h-6 !px-2 !text-micro"
        onClick={onFit}
      >
        Fit
      </Button>
    </div>
  );
}

/** The canvas's camera: fitted once per project, with small collections kept at their natural size. */
function useAssetsCamera(project: string, loaded: boolean, layout: Layout) {
  const canvas = useCanvasView({ initial: { k: 1, tx: 0, ty: 0 } });
  const { viewRef, fit, zoomBy } = canvas;
  const fitted = useRef<string | null>(null);
  const fitAssets = useCallback(
    (bounds: ReturnType<typeof boundsOf>) => {
      fit(bounds);
      // A small collection stays at its natural card size; larger collections fit down.
      if (viewRef.current.k > 1) zoomBy(1 / viewRef.current.k);
    },
    [fit, zoomBy, viewRef],
  );
  // Another project is another canvas: fitted again. (Before the fit below, so the new project's first fit sticks.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new project is the reason to fit again
  useEffect(() => {
    fitted.current = null;
  }, [project]);
  // Fit once per project, as soon as there is something to fit.
  useEffect(() => {
    if (!loaded || fitted.current === project) return;
    const bounds = boundsOf(Object.values(layout.rects));
    if (!bounds) return;
    fitted.current = project;
    fitAssets(bounds);
  }, [loaded, project, layout, fitAssets]);
  return { ...canvas, fitAssets };
}

// One press, one dismissal — the same chain the Builds canvas uses, so Escape never also
// reaches the chat behind the stage.
/** Escape clears the selection, unless a preview is open or the press belongs to a field. */
function useEscapeClears(selected: string | null, previewOpen: boolean, clear: () => void): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear is the canvas's state setter
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || previewOpen) return;
      if (typingIn(event.target)) return;
      if (selected) clear();
      else return;
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, previewOpen]);
}

/** The project's asset inventory from the library store, which keeps it fresh while the canvas is open. */
function useProjectAssets(project: string) {
  // The library store keeps this project's inventory fresh while the canvas is open: one read on a
  // plugin's or a delivery's word, and a walk every ten seconds for hand-dropped files.
  useEffect(() => studio().library.watchAssets(project), [project]);
  const ledger = useLibrary((s) => assetsOf(s, project).value);
  const loadError = useLibrary((s) => assetsOf(s, project).error);
  const refresh = useCallback(() => studio().library.refreshAssets(project), [project]);
  return { ledger, loadError, refresh, assets: ledger?.assets ?? [], pending: ledger?.jobs ?? NO_PENDING };
}

/** The selected asset and the one open in the preview: cleared for another project, moved to a job the stage asks for. */
function useAssetSelection(project: string, assets: ProjectAsset[], focusJob: string | null | undefined) {
  const [selected, setSelected] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<ProjectAsset | null>(null);
  // Another project is another canvas: nothing selected, nothing open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new project clears the selection and the preview
  useEffect(() => {
    setSelected(null);
    setPreviewAsset(null);
  }, [project]);
  useEffect(() => {
    if (!focusJob) return;
    const found = assets.find((a) => a.jobId === focusJob || a.generationId === focusJob);
    if (found) setSelected(found.file);
  }, [assets, focusJob]);
  return { selected, setSelected, previewAsset, setPreviewAsset };
}

/**
 * The project's animation files folded into the models they move, by the models' headers (newest model
 * first), or null until the headers are read. A folded file gets no card of its own.
 */
function useFoldedMotions(project: string, assets: ProjectAsset[]): FoldedMotions | null {
  const newestFirst = useMemo(
    () => [...assets].sort((a, b) => b.mtime.localeCompare(a.mtime)).map((asset) => asset.file),
    [assets],
  );
  const rigs = useModelRigs(project, newestFirst);
  return useMemo(() => (rigs ? foldMotions(rigs) : null), [rigs]);
}

export function AssetsCanvas({ project, onNotice, focusJob }: Props): JSX.Element {
  const { ledger, loadError, refresh, assets, pending } = useProjectAssets(project);
  const { selected, setSelected, previewAsset, setPreviewAsset } = useAssetSelection(project, assets, focusJob);
  const folded = useFoldedMotions(project, assets);
  const carded = useMemo(
    () =>
      folded ? assets.filter((asset) => !folded.motions.has(asset.file) || folded.loose.includes(asset.file)) : [],
    [assets, folded],
  );
  // Nothing is laid out until the models' headers are read, so no card shows that then folds away.
  const headersRead = folded !== null;
  const layout = useMemo(
    () => layoutAssets(carded, headersRead ? pending : NO_PENDING),
    [carded, pending, headersRead],
  );
  const camera = useAssetsCamera(project, Boolean(ledger) && headersRead, layout);
  const { view, viewport, onBackgroundDown, moved, panning } = camera;

  const reveal = useCallback(
    (file: string): void => {
      void window.studio.revealProject(project, file).catch(notifyProblem(onNotice));
    },
    [project, onNotice],
  );
  useEscapeClears(selected, previewAsset !== null, () => setSelected(null));
  const openAsset = useCallback((asset: ProjectAsset) => {
    setSelected(asset.file);
    setPreviewAsset(asset);
  }, []);

  return (
    <div data-assets-canvas className="absolute inset-0 overflow-hidden bg-canvas select-none">
      <div
        ref={viewport}
        className={`absolute inset-0 ${panning ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={onBackgroundDown}
        onClick={() => {
          if (!moved.current) setSelected(null);
        }}
      >
        <div
          ref={camera.grid}
          data-grid-scale={view.k}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0"
          style={{
            width: `calc(150% + ${GRID_PX * 2}px)`,
            height: `calc(150% + ${GRID_PX * 2}px)`,
            backgroundImage: "radial-gradient(var(--line-strong) 1px, transparent 1.25px)",
            backgroundSize: `${GRID_PX * view.k}px ${GRID_PX * view.k}px`,
            transform: gridTransform(view, view.k),
            transformOrigin: "0 0",
          }}
        />
        <div
          ref={camera.layer}
          className="absolute top-0 left-0"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
            transformOrigin: "0 0",
          }}
        >
          <AssetGroups
            layout={layout}
            project={project}
            assets={assets}
            selected={selected}
            folded={folded ?? NOTHING_FOLDED}
            onOpen={openAsset}
          />
        </div>
      </div>

      {!assets.length && !pending.length ? (
        <div className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8 text-center">
          <EmptyAssets loadError={loadError} loaded={Boolean(ledger)} onRetry={refresh} />
        </div>
      ) : null}

      {ledger?.truncated ? (
        <div className="absolute top-2.5 right-2.5 rounded-control bg-surface px-2 py-1 text-micro text-ink-3 shadow-btn">
          This project has more files than the canvas lists.
        </div>
      ) : null}

      <AssetsZoom
        pct={Math.round(view.k * 100)}
        onZoom={camera.zoomBy}
        onFit={() => camera.fitAssets(boundsOf(Object.values(layout.rects)))}
      />

      {previewAsset ? (
        <AssetPreview
          key={`${project}:${previewAsset.assetRef ?? previewAsset.file}`}
          project={project}
          asset={previewAsset}
          assets={assets}
          clips={assets.filter((asset) => folded?.clipsOf.get(previewAsset.file)?.includes(asset.file))}
          onClose={() => setPreviewAsset(null)}
          onReveal={() => reveal(previewAsset.assetRef ?? previewAsset.file)}
        />
      ) : null}
    </div>
  );
}
