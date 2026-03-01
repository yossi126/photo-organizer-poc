import { CATEGORY_CONFIG } from "../../lib/constants";
import type { Category, PhotoEntry } from "../../types/photo";

interface PhotoCellProps {
  entry: PhotoEntry;
  thumbnailSrc: string | null;
  onDoubleClick: () => void;
}

export function PhotoCell({ entry, thumbnailSrc, onDoubleClick }: PhotoCellProps) {
  const catCfg = CATEGORY_CONFIG[entry.category as Category] ??
    CATEGORY_CONFIG.clean;

  return (
    <div
      data-testid="photo-cell"
      onDoubleClick={onDoubleClick}
      className="w-[175px] bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden cursor-pointer hover:border-zinc-600 transition-colors group"
    >
      <div className="w-full h-[150px] bg-zinc-800 flex items-center justify-center overflow-hidden">
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={entry.filename}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
            loading="lazy"
          />
        ) : (
          <div className="text-zinc-700 text-xs">Loading...</div>
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
          {entry.starRating > 0 && (
            <span className="text-[10px] text-amber-400">
              {"★".repeat(entry.starRating)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
