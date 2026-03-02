import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { DEFAULT_EDIT_SETTINGS } from "../../lib/constants";
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
}

function buildCssFilter(s: EditSettings): string {
  const parts: string[] = [];

  const brightnessBase = 1 + s.exposure * 0.2;
  const highlightAdj = s.highlights > 0 ? -s.highlights * 0.001 : 0;
  const shadowAdj = s.shadows > 0 ? s.shadows * 0.001 : 0;
  const brightness = Math.max(0.1, brightnessBase + highlightAdj + shadowAdj);
  parts.push(`brightness(${brightness.toFixed(3)})`);

  const contrast = 1 + s.contrast / 100;
  parts.push(`contrast(${Math.max(0, contrast).toFixed(3)})`);

  if (s.clarity !== 0) {
    const clarityContrast = 1 + s.clarity / 200;
    parts.push(`contrast(${Math.max(0, clarityContrast).toFixed(3)})`);
  }

  const saturation = Math.max(0, 1 + s.saturation / 100 + s.vibrance / 150);
  parts.push(`saturate(${saturation.toFixed(3)})`);

  if (s.temperature !== 5500) {
    const warmth = (s.temperature - 5500) / 44500;
    if (warmth > 0) {
      parts.push(`sepia(${(warmth * 0.5).toFixed(3)})`);
    } else {
      parts.push(`hue-rotate(${(warmth * 30).toFixed(1)}deg)`);
    }
  }

  if (s.tint !== 0) {
    parts.push(`hue-rotate(${(s.tint * 0.3).toFixed(1)}deg)`);
  }

  if (s.noiseReduceLuminance > 10) {
    parts.push(`blur(${(s.noiseReduceLuminance / 100).toFixed(2)}px)`);
  }

  return parts.join(" ");
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
}: EditTabProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [showBefore, setShowBefore] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const previewRef = useRef<HTMLDivElement>(null);
  const entry = entries[selectedIndex];

  const currentSettings = useMemo(
    () => (entry ? editSettingsMap[entry.path] ?? DEFAULT_EDIT_SETTINGS : DEFAULT_EDIT_SETTINGS),
    [entry?.path, editSettingsMap]
  );

  const cssFilter = useMemo(() => buildCssFilter(currentSettings), [currentSettings]);

  const loadImage = useCallback(async () => {
    if (!entry) return;
    setImageSrc(null);
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
  }, [selectedIndex, entries.length, onIndexChange, onBack, zoomIn, zoomOut, resetZoom]);

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
      />

      {/* Main content: left panel + preview + right panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel — Presets / Snapshots / History */}
        <EditLeftPanel
          onSettingsChange={(settings) => onEditSettingsChange(entry.path, settings)}
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
            {imageSrc ? (
              <img
                src={imageSrc}
                alt={entry.filename}
                draggable={false}
                className="object-contain rounded-lg"
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
                  transformOrigin: "center center",
                  filter: showBefore ? "none" : cssFilter,
                  transition: isPanning ? "none" : "transform 0.1s ease-out",
                }}
              />
            ) : (
              <div className="text-zinc-600 text-sm">Loading preview...</div>
            )}

            {/* Before/After badge */}
            {(showBefore || cssFilter) && (
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
