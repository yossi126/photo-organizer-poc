import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { DEFAULT_EDIT_SETTINGS } from "../../lib/constants";
import { PhotoRenderer } from "../../lib/render/renderer";
import { EditTopBar } from "./EditTopBar";
import { EditFilmstrip } from "./EditFilmstrip";
import { EditRightPanel } from "./EditRightPanel";
import { EditLeftPanel } from "./EditLeftPanel";
import type { Category, PhotoEntry, EditSettings } from "../../types/photo";

interface EditTabProps {
  entries: PhotoEntry[];
  selectedIndex: number;
  onIndexChange: (index: number) => void;
  onBack: () => void;
  onRatingChange: (entry: PhotoEntry, stars: number) => void;
  onReclassify: (entry: PhotoEntry, category: string) => void;
  getLargeImage: (path: string) => Promise<string>;
  getFullResImage: (path: string) => Promise<string>;
  getThumbnail: (path: string) => string | null;
  cacheVersion?: number;
  activeCategory: Category;
  minStars: number;
  editSettingsMap: Record<string, EditSettings>;
  onEditSettingsChange: (path: string, settings: EditSettings) => void;
  clipboardSettings: EditSettings | null;
  onCopySettings: (path: string) => void;
  onPasteSettings: (path: string) => void;
  onUndo?: (path: string) => void;
  onRedo?: (path: string) => void;
  canUndo?: (path: string) => boolean;
  canRedo?: (path: string) => boolean;
  onExport?: (entry: PhotoEntry) => void;
  onRevertEdit?: (entry: PhotoEntry) => void;
  onAutoEditSingle?: (entry: PhotoEntry) => Promise<void>;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.15;

export function EditTab({
  entries,
  selectedIndex,
  onIndexChange,
  onBack,
  onRatingChange,
  onReclassify,
  getLargeImage,
  getFullResImage,
  getThumbnail,
  cacheVersion,
  editSettingsMap,
  onEditSettingsChange,
  clipboardSettings,
  onCopySettings,
  onPasteSettings,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onExport,
  onRevertEdit,
  onAutoEditSingle,
}: EditTabProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [showBefore, setShowBefore] = useState(false);
  const [autoEditBusy, setAutoEditBusy] = useState(false);
  const [autoEditError, setAutoEditError] = useState<string | null>(null);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const previewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PhotoRenderer | null>(null);
  const rafRef = useRef<number>(0);
  const entry = entries[selectedIndex];

  const currentSettings = useMemo(
    () => (entry ? editSettingsMap[entry.path] ?? DEFAULT_EDIT_SETTINGS : DEFAULT_EDIT_SETTINGS),
    [entry?.path, editSettingsMap]
  );

  const hasEdits = entry ? entry.path in editSettingsMap : false;

  // Clear a stale auto-edit error when switching photos
  useEffect(() => {
    setAutoEditError(null);
  }, [entry?.path]);

  // --- Renderer lifecycle ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      rendererRef.current = new PhotoRenderer(canvas);
    } catch (err) {
      console.error("Failed to create WebGL renderer:", err);
    }
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Upload image to the renderer whenever the source changes
  useEffect(() => {
    let cancelled = false;
    const renderer = rendererRef.current;
    if (!renderer || !imageSrc) return;
    setImageReady(false);
    renderer
      .setImage(imageSrc)
      .then(() => {
        if (cancelled) return;
        setImageReady(true);
        renderer.render(showBefore ? DEFAULT_EDIT_SETTINGS : currentSettings);
      })
      .catch((err) => console.error("Failed to load image into renderer:", err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSrc]);

  // Re-render on settings / before-after change (coalesced to one per frame)
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !imageReady) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      renderer.render(showBefore ? DEFAULT_EDIT_SETTINGS : currentSettings);
    });
    return () => cancelAnimationFrame(rafRef.current);
  }, [currentSettings, showBefore, imageReady]);

  const loadImage = useCallback(async () => {
    if (!entry) return;
    setImageSrc(null);
    setImageReady(false);
    const preview = await getLargeImage(entry.path);
    setImageSrc(preview);
    const fullRes = await getFullResImage(entry.path);
    setImageSrc(fullRes);
  }, [entry?.path, getLargeImage, getFullResImage]);

  useEffect(() => {
    loadImage();
  }, [loadImage]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setShowBefore(false);
  }, [selectedIndex]);

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const next = Math.max(MIN_ZOOM, z - ZOOM_STEP);
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Mouse wheel zoom
  useEffect(() => {
    const container = previewRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
      } else {
        setZoom((z) => {
          const next = Math.max(MIN_ZOOM, z - ZOOM_STEP);
          if (next <= 1) setPan({ x: 0, y: 0 });
          return next;
        });
      }
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (!entry) return;
        if (e.shiftKey) onRedo?.(entry.path);
        else onUndo?.(entry.path);
        return;
      }
      if (e.key === "ArrowLeft" && selectedIndex > 0) {
        onIndexChange(selectedIndex - 1);
      } else if (e.key === "ArrowRight" && selectedIndex < entries.length - 1) {
        onIndexChange(selectedIndex + 1);
      } else if (e.key === "Escape") {
        onBack();
      } else if (e.key === "+" || e.key === "=") {
        zoomIn();
      } else if (e.key === "-") {
        zoomOut();
      } else if (e.key === "0") {
        resetZoom();
      } else if (e.key === "\\") {
        setShowBefore((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedIndex, entries.length, onIndexChange, onBack, zoomIn, zoomOut, resetZoom, entry, onUndo, onRedo]);

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (zoom <= 1) return;
      e.preventDefault();
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    },
    [zoom, pan]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setPan({ x: panStart.current.panX + dx, y: panStart.current.panY + dy });
    },
    [isPanning]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  if (!entry) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
        No photo selected. Double-click a thumbnail in the CULL tab.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar */}
      <EditTopBar
        filename={entry.filename}
        position={`${selectedIndex + 1} / ${entries.length}`}
        onBack={onBack}
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoom}
        stars={entry.starRating}
        onRatingChange={(stars) => onRatingChange(entry, stars)}
        onUndo={onUndo ? () => onUndo(entry.path) : undefined}
        onRedo={onRedo ? () => onRedo(entry.path) : undefined}
        canUndo={canUndo ? canUndo(entry.path) : false}
        canRedo={canRedo ? canRedo(entry.path) : false}
        onExport={onExport ? () => onExport(entry) : undefined}
      />

      {/* Main content: left panel + preview + right panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel — Presets / Snapshots / History */}
        <EditLeftPanel
          onSettingsChange={(settings) => onEditSettingsChange(entry.path, settings)}
          currentSettings={currentSettings}
        />

        {/* Center column: photo preview + filmstrip */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Photo preview */}
          <div
            ref={previewRef}
            className="flex-1 flex items-center justify-center bg-zinc-950 relative overflow-hidden select-none"
            style={{ cursor: zoom > 1 ? (isPanning ? "grabbing" : "grab") : "default" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <canvas
              ref={canvasRef}
              className="object-contain rounded-lg"
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
                transformOrigin: "center center",
                transition: isPanning ? "none" : "transform 0.1s ease-out",
                visibility: imageReady ? "visible" : "hidden",
              }}
            />
            {!imageReady && (
              <div className="absolute text-zinc-600 text-sm">Loading preview...</div>
            )}

            {/* Auto Edit for photos without an AI edit (never edited, or reverted) */}
            {!currentSettings.aiEdited && onAutoEditSingle && (
              <div
                className="absolute top-4 right-4 flex items-center gap-1.5"
                data-testid="auto-edit-single"
              >
                {autoEditError && (
                  <span className="px-2 py-1 rounded-full text-[10px] bg-red-950/90 border border-red-800 text-red-300 backdrop-blur-sm max-w-64 truncate">
                    {autoEditError}
                  </span>
                )}
                <button
                  disabled={autoEditBusy}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setAutoEditError(null);
                    setAutoEditBusy(true);
                    try {
                      await onAutoEditSingle(entry);
                    } catch (err) {
                      setAutoEditError(String(err));
                    } finally {
                      setAutoEditBusy(false);
                    }
                  }}
                  className="px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider bg-violet-700/90 border border-violet-500 text-white hover:bg-violet-600/90 disabled:opacity-60 disabled:cursor-wait backdrop-blur-sm transition-colors"
                  title="Auto-edit this photo using your saved AI profile"
                >
                  {autoEditBusy ? "✨ Auto-editing…" : "✨ Auto Edit"}
                </button>
              </div>
            )}

            {/* AI-edited badge + revert */}
            {currentSettings.aiEdited && (
              <div
                className="absolute top-4 right-4 flex items-center gap-1.5"
                data-testid="ai-badge"
              >
                <span
                  className="px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider bg-violet-700/90 border border-violet-500 text-white backdrop-blur-sm"
                  title={
                    currentSettings.aiScene === "personal"
                      ? "Edited in your learned personal style"
                      : `Auto-edited (scene: ${currentSettings.aiScene ?? "?"})`
                  }
                >
                  {currentSettings.aiScene === "personal"
                    ? "🧠 My Style"
                    : `✨ AI${currentSettings.aiScene ? ` · ${currentSettings.aiScene}` : ""}`}
                </span>
                {onRevertEdit && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRevertEdit(entry);
                    }}
                    className="px-2 py-1 rounded-full text-[10px] font-medium bg-zinc-800/90 border border-zinc-600 text-zinc-300 hover:text-white hover:border-zinc-400 backdrop-blur-sm"
                    title="Remove the AI edit and go back to the original"
                  >
                    Revert
                  </button>
                )}
              </div>
            )}

            {/* Before/After badge */}
            {(showBefore || hasEdits) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowBefore((prev) => !prev);
                }}
                title="Press \ to toggle before/after"
                className={`absolute top-4 left-4 px-3 py-1 rounded-full text-xs font-bold tracking-widest backdrop-blur-sm border transition-colors ${
                  showBefore
                    ? "bg-amber-500/90 border-amber-400 text-black"
                    : "bg-emerald-600/90 border-emerald-500 text-white"
                }`}
              >
                {showBefore ? "BEFORE" : "AFTER"}
              </button>
            )}
          </div>

          {/* Filmstrip + status bar */}
          <EditFilmstrip
            entries={entries}
            selectedGlobalIndex={selectedIndex}
            onSelectIndex={onIndexChange}
            getThumbnail={getThumbnail}
            cacheVersion={cacheVersion}
          />
        </div>

        {/* Right panel — editing controls */}
        <EditRightPanel
          entry={entry}
          settings={currentSettings}
          onSettingsChange={(settings) => onEditSettingsChange(entry.path, settings)}
          onCopySettings={() => onCopySettings(entry.path)}
          onPasteSettings={() => onPasteSettings(entry.path)}
          canPaste={clipboardSettings !== null}
          onRatingChange={(stars) => onRatingChange(entry, stars)}
          onReclassify={(category) => onReclassify(entry, category)}
        />
      </div>
    </div>
  );
}
