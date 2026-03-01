import { useEffect, useState, useCallback, useMemo } from "react";
import { DEFAULT_EDIT_SETTINGS } from "../../lib/constants";
import { EditTopBar } from "./EditTopBar";
import { EditFilmstrip } from "./EditFilmstrip";
import { EditRightPanel } from "./EditRightPanel";
import type { Category, PhotoEntry, EditSettings } from "../../types/photo";

interface EditTabProps {
  entries: PhotoEntry[];
  selectedIndex: number;
  onIndexChange: (index: number) => void;
  onBack: () => void;
  onRatingChange: (entry: PhotoEntry, stars: number) => void;
  onReclassify: (entry: PhotoEntry, category: string) => void;
  getLargeImage: (path: string) => Promise<string>;
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

  // Exposure + highlights/shadows approximation
  const brightnessBase = 1 + s.exposure * 0.2;
  const highlightAdj = s.highlights > 0 ? -s.highlights * 0.001 : 0;
  const shadowAdj = s.shadows > 0 ? s.shadows * 0.001 : 0;
  const brightness = Math.max(0.1, brightnessBase + highlightAdj + shadowAdj);
  parts.push(`brightness(${brightness.toFixed(3)})`);

  // Contrast
  const contrast = 1 + s.contrast / 100;
  parts.push(`contrast(${Math.max(0, contrast).toFixed(3)})`);

  // Clarity boosts contrast slightly
  if (s.clarity !== 0) {
    const clarityContrast = 1 + s.clarity / 200;
    parts.push(`contrast(${Math.max(0, clarityContrast).toFixed(3)})`);
  }

  // Saturation (combined vibrance + saturation)
  const saturation = Math.max(0, 1 + s.saturation / 100 + s.vibrance / 150);
  parts.push(`saturate(${saturation.toFixed(3)})`);

  // Temperature: center at 5500K
  if (s.temperature !== 5500) {
    const warmth = (s.temperature - 5500) / 44500;
    if (warmth > 0) {
      parts.push(`sepia(${(warmth * 0.5).toFixed(3)})`);
    } else {
      parts.push(`hue-rotate(${(warmth * 30).toFixed(1)}deg)`);
    }
  }

  // Tint: -150..+150 → hue-rotate
  if (s.tint !== 0) {
    parts.push(`hue-rotate(${(s.tint * 0.3).toFixed(1)}deg)`);
  }

  // Noise reduction: blur for high luminance NR
  if (s.noiseReduceLuminance > 10) {
    parts.push(`blur(${(s.noiseReduceLuminance / 100).toFixed(2)}px)`);
  }

  return parts.join(" ");
}

export function EditTab({
  entries,
  selectedIndex,
  onIndexChange,
  onBack,
  onRatingChange,
  onReclassify,
  getLargeImage,
  getThumbnail,
  cacheVersion,
  editSettingsMap,
  onEditSettingsChange,
  clipboardSettings,
  onCopySettings,
  onPasteSettings,
}: EditTabProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const entry = entries[selectedIndex];

  const currentSettings = useMemo(
    () => (entry ? editSettingsMap[entry.path] ?? DEFAULT_EDIT_SETTINGS : DEFAULT_EDIT_SETTINGS),
    [entry?.path, editSettingsMap]
  );

  const cssFilter = useMemo(() => buildCssFilter(currentSettings), [currentSettings]);

  const loadImage = useCallback(async () => {
    if (!entry) return;
    setImageSrc(null);
    const src = await getLargeImage(entry.path);
    setImageSrc(src);
  }, [entry?.path, getLargeImage]);

  useEffect(() => {
    loadImage();
  }, [loadImage]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && selectedIndex > 0) {
        onIndexChange(selectedIndex - 1);
      } else if (e.key === "ArrowRight" && selectedIndex < entries.length - 1) {
        onIndexChange(selectedIndex + 1);
      } else if (e.key === "Escape") {
        onBack();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedIndex, entries.length, onIndexChange, onBack]);

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
      <EditTopBar filename={entry.filename} position={`${selectedIndex + 1} / ${entries.length}`} onBack={onBack} />

      {/* Main content area: preview + right panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Photo preview + filmstrip column */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Photo preview */}
          <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950 p-4 relative">
            {imageSrc ? (
              <img src={imageSrc} alt={entry.filename} className="max-w-full max-h-full object-contain rounded-lg" style={{ filter: cssFilter }} />
            ) : (
              <div className="text-zinc-600 text-sm">Loading preview...</div>
            )}
          </div>

          {/* Filmstrip */}
          <EditFilmstrip
            entries={entries}
            selectedGlobalIndex={selectedIndex}
            onSelectIndex={onIndexChange}
            getThumbnail={getThumbnail}
            cacheVersion={cacheVersion}
          />
        </div>

        {/* Right panel with editing controls */}
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
