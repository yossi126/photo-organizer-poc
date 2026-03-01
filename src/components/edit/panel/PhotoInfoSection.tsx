import { CATEGORY_CONFIG, FILTER_CATEGORIES } from "../../../lib/constants";
import { RatingStars } from "../RatingStars";
import type { PhotoEntry } from "../../../types/photo";

interface PhotoInfoSectionProps {
  entry: PhotoEntry;
  onRatingChange: (stars: number) => void;
  onReclassify: (category: string) => void;
}

function ScoreRow({ label, value, threshold }: { label: string; value: number; threshold: string }) {
  return (
    <div className="flex items-center justify-between text-xs text-zinc-400">
      <span>{label}</span>
      <span className="font-mono">
        {value.toFixed(1)} <span className="text-zinc-600">{threshold}</span>
      </span>
    </div>
  );
}

export function PhotoInfoSection({ entry, onRatingChange, onReclassify }: PhotoInfoSectionProps) {
  const categoryConfig = CATEGORY_CONFIG[entry.category];

  return (
    <div className="space-y-3 text-sm">
      {/* Filename and position */}
      <div className="truncate">
        <p className="text-zinc-300 font-mono text-xs truncate" title={entry.filename}>
          {entry.filename}
        </p>
      </div>

      {/* Category badge */}
      <div
        style={{
          backgroundColor: categoryConfig.bgColor,
          color: categoryConfig.color,
        }}
        className="inline-block px-2 py-1 rounded text-xs font-medium"
      >
        {categoryConfig.label}
      </div>

      {/* Star rating */}
      <div>
        <p className="text-zinc-400 text-xs mb-1">Rating</p>
        <RatingStars rating={entry.starRating} onChange={onRatingChange} />
      </div>

      {/* Detection Scores */}
      <div className="space-y-1">
        <p className="text-zinc-400 text-xs font-medium">Detection Scores</p>
        <ScoreRow label="Brightness" value={entry.scores.brightness} threshold="(0–255)" />
        <ScoreRow label="Blur" value={entry.scores.blur} threshold="variance" />
        {entry.scores.ear !== null && <ScoreRow label="Eye AR" value={entry.scores.ear} threshold="(0–1)" />}
        {entry.allLabels.length > 0 && (
          <div className="text-xs text-zinc-500">Labels: {entry.allLabels.join(", ")}</div>
        )}
      </div>

      {/* Reclassify buttons */}
      <div className="space-y-1">
        <p className="text-zinc-400 text-xs font-medium">Reclassify</p>
        <div className="space-y-1">
          {FILTER_CATEGORIES.filter((c) => c !== "all").map((cat) => {
            const cfg = CATEGORY_CONFIG[cat];
            const isActive = entry.category === cat;
            return (
              <button
                key={cat}
                onClick={() => onReclassify(cat)}
                style={{
                  backgroundColor: isActive ? cfg.bgColor : "transparent",
                  color: cfg.color,
                  borderColor: cfg.color,
                }}
                className="w-full px-2 py-1 text-xs rounded border transition-colors"
              >
                {cfg.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
