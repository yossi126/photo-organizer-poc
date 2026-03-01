import { useMemo, useCallback } from "react";
import { VirtuosoGrid } from "react-virtuoso";
import { Sidebar } from "../layout/Sidebar";
import { PhotoCell } from "./PhotoCell";
import type { Category, PhotoEntry } from "../../types/photo";

interface CullTabProps {
  entries: PhotoEntry[];
  activeCategory: Category;
  minStars: number;
  onCategoryChange: (cat: Category) => void;
  onStarsChange: (stars: number) => void;
  onSelectPhoto: (index: number) => void;
  getThumbnail: (path: string) => string | null;
}

export function CullTab({
  entries,
  activeCategory,
  minStars,
  onCategoryChange,
  onStarsChange,
  onSelectPhoto,
  getThumbnail,
}: CullTabProps) {
  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (activeCategory !== "all" && e.category !== activeCategory) return false;
      if (minStars > 0 && e.starRating < minStars) return false;
      return true;
    });
  }, [entries, activeCategory, minStars]);

  const itemContent = useCallback(
    (index: number) => {
      const entry = filtered[index];
      if (!entry) return null;
      return (
        <div className="p-2">
          <PhotoCell
            entry={entry}
            thumbnailSrc={getThumbnail(entry.path)}
            onDoubleClick={() => {
              const globalIndex = entries.indexOf(entry);
              onSelectPhoto(globalIndex);
            }}
          />
        </div>
      );
    },
    [filtered, entries, getThumbnail, onSelectPhoto]
  );

  return (
    <div className="flex-1 flex overflow-hidden">
      <Sidebar
        entries={entries}
        activeCategory={activeCategory}
        minStars={minStars}
        onCategoryChange={onCategoryChange}
        onStarsChange={onStarsChange}
      />
      <div className="flex-1 bg-zinc-950" data-testid="photo-grid">
        {filtered.length === 0 ? (
          <div className="flex-1 flex items-center justify-center h-full text-zinc-600 text-sm">
            No photos match the current filter
          </div>
        ) : (
          <VirtuosoGrid
            totalCount={filtered.length}
            overscan={200}
            listClassName="flex flex-wrap p-2"
            itemClassName="flex"
            itemContent={itemContent}
          />
        )}
      </div>
    </div>
  );
}
