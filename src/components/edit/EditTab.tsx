import { useEffect, useState, useCallback } from "react";
import { CATEGORY_CONFIG, FILTER_CATEGORIES } from "../../lib/constants";
import { RatingStars } from "./RatingStars";
import type { Category, PhotoEntry } from "../../types/photo";

interface EditTabProps {
  entries: PhotoEntry[];
  selectedIndex: number;
  onIndexChange: (index: number) => void;
  onBack: () => void;
  onRatingChange: (entry: PhotoEntry, stars: number) => void;
  onReclassify: (entry: PhotoEntry, category: string) => void;
  getLargeImage: (path: string) => Promise<string>;
}

export function EditTab({
  entries,
  selectedIndex,
  onIndexChange,
  onBack,
  onRatingChange,
  onReclassify,
  getLargeImage,
}: EditTabProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const entry = entries[selectedIndex];

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

  const catCfg = CATEGORY_CONFIG[entry.category as Category] ?? CATEGORY_CONFIG.clean;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Photo preview area */}
      <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950 p-4 relative">
        {/* Navigation */}
        <button
          onClick={() => selectedIndex > 0 && onIndexChange(selectedIndex - 1)}
          disabled={selectedIndex === 0}
          className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-zinc-800/80 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30 flex items-center justify-center text-lg transition-colors"
        >
          &lt;
        </button>
        <button
          onClick={() =>
            selectedIndex < entries.length - 1 &&
            onIndexChange(selectedIndex + 1)
          }
          disabled={selectedIndex === entries.length - 1}
          className="absolute right-[276px] top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-zinc-800/80 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30 flex items-center justify-center text-lg transition-colors"
        >
          &gt;
        </button>

        {imageSrc ? (
          <img
            src={imageSrc}
            alt={entry.filename}
            className="max-w-full max-h-full object-contain rounded-lg"
          />
        ) : (
          <div className="text-zinc-600 text-sm">Loading preview...</div>
        )}
      </div>

      {/* Info panel */}
      <aside className="w-64 shrink-0 bg-zinc-900 border-l border-zinc-800 p-4 overflow-y-auto space-y-5">
        <button
          onClick={onBack}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          &larr; Back to grid
        </button>

        <div>
          <div className="text-sm font-medium text-zinc-200 truncate" title={entry.filename}>
            {entry.filename}
          </div>
          <div className="text-xs text-zinc-600 mt-1">
            {selectedIndex + 1} / {entries.length}
          </div>
        </div>

        <div>
          <span
            className="text-xs font-medium px-2 py-1 rounded"
            style={{ backgroundColor: catCfg.bgColor, color: catCfg.color }}
          >
            {catCfg.label}
          </span>
        </div>

        <div>
          <div className="text-xs text-zinc-500 mb-1.5">Rating</div>
          <RatingStars
            rating={entry.starRating}
            onChange={(stars) => onRatingChange(entry, stars)}
          />
        </div>

        <div className="space-y-2">
          <div className="text-xs text-zinc-500">Detection Scores</div>
          <ScoreRow label="Brightness" value={entry.scores.brightness} threshold="< 85 dark, > 220 over" />
          <ScoreRow label="Blur" value={entry.scores.blur} threshold="< 50 blurry" />
          {entry.scores.ear !== null && entry.scores.ear !== undefined && (
            <ScoreRow label="Eye AR" value={entry.scores.ear} threshold="< 0.18 closed" />
          )}
          {entry.allLabels.length > 0 && (
            <div className="text-xs text-zinc-600">
              Labels: {entry.allLabels.join(", ")}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="text-xs text-zinc-500">Reclassify</div>
          {FILTER_CATEGORIES.filter((c) => c !== "all").map((cat) => {
            const cfg = CATEGORY_CONFIG[cat];
            const isActive = entry.category === cat;
            return (
              <button
                key={cat}
                onClick={() => onReclassify(entry, cat)}
                className="w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors"
                style={{
                  backgroundColor: isActive ? cfg.bgColor : "transparent",
                  color: isActive ? cfg.color : "#71717a",
                  border: isActive ? "none" : "1px solid #27272a",
                }}
              >
                {cfg.label}
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function ScoreRow({
  label,
  value,
  threshold,
}: {
  label: string;
  value: number;
  threshold: string;
}) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="text-right">
        <span className="text-xs font-mono text-zinc-300">
          {typeof value === "number" ? value.toFixed(1) : "—"}
        </span>
        <div className="text-[10px] text-zinc-600">{threshold}</div>
      </div>
    </div>
  );
}
