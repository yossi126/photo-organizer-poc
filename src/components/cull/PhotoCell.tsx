import { CATEGORY_CONFIG } from "../../lib/constants";
import type { Category, PhotoEntry } from "../../types/photo";
import { RatingStars } from "../edit/RatingStars";

interface PhotoCellProps {
  entry: PhotoEntry;
  thumbnailSrc: string | null;
  onDoubleClick: () => void;
  onClick?: () => void;
  onRatingChange?: (entry: PhotoEntry, stars: number) => void;
  isSelected?: boolean;
  stackCount?: number;      // > 0 when this is a collapsed stack top
  onToggleStack?: () => void;
}

export function PhotoCell({
  entry,
  thumbnailSrc,
  onDoubleClick,
  onClick,
  onRatingChange,
  isSelected = false,
  stackCount = 0,
  onToggleStack,
}: PhotoCellProps) {
  const catCfg = CATEGORY_CONFIG[entry.category as Category] ??
    CATEGORY_CONFIG.clean;

  return (
    <div
      data-testid="photo-cell"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`w-[175px] bg-zinc-900 rounded-xl border overflow-hidden cursor-pointer transition-colors group ${
        isSelected
          ? "border-blue-500 ring-2 ring-blue-500/50"
          : "border-zinc-800 hover:border-zinc-600"
      }`}
    >
      <div className="relative w-full h-[150px] bg-zinc-800 flex items-center justify-center overflow-hidden">
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={entry.filename}
            className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-200"
          />
        ) : (
          <div className="text-zinc-700 text-xs">Loading...</div>
        )}

        {/* Flag badge (pick/reject) */}
        {entry.flag === "pick" && (
          <span
            data-testid="flag-pick"
            className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-emerald-600/95 text-white text-[11px] font-bold flex items-center justify-center shadow"
            title="Pick"
          >
            P
          </span>
        )}
        {entry.flag === "reject" && (
          <span
            data-testid="flag-reject"
            className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-red-600/95 text-white text-[11px] font-bold flex items-center justify-center shadow"
            title="Rejected"
          >
            X
          </span>
        )}

        {/* Stack badge (collapsed stack top) */}
        {stackCount > 0 && (
          <button
            data-testid="stack-badge"
            onClick={(e) => {
              e.stopPropagation();
              onToggleStack?.();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={`Stack of ${stackCount} similar photos — click to expand (S)`}
            className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-zinc-950/90 border border-zinc-600 text-zinc-200 text-[10px] font-semibold hover:bg-zinc-800"
          >
            ⧉ {stackCount}
          </button>
        )}
        {/* Expanded stack member marker */}
        {stackCount === 0 && entry.stackId != null && (
          <span
            className="absolute top-1.5 right-1.5 px-1 rounded bg-zinc-950/70 text-zinc-400 text-[10px]"
            title={`In stack #${entry.stackId}`}
          >
            ⧉
          </span>
        )}
      </div>
      <div className="px-2.5 py-2 space-y-1">
        <div className="text-xs text-zinc-400 truncate" title={entry.filename}>
          {entry.filename}
        </div>
        <div className="flex items-center justify-between">
          <span
            className="text-[10px] font-medium px-1.5 py-0.5 rounded"
            style={{ backgroundColor: catCfg.bgColor, color: catCfg.color }}
          >
            {catCfg.label}
          </span>
          {onRatingChange ? (
            <div
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <RatingStars
                rating={entry.starRating}
                onChange={(stars) => onRatingChange(entry, stars)}
              />
            </div>
          ) : (
            entry.starRating > 0 && (
              <span className="text-[10px] text-amber-400">
                {"★".repeat(entry.starRating)}
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
}
