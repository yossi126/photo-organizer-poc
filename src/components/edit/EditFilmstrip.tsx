import { useRef, useEffect } from "react";
import type { PhotoEntry } from "../../types/photo";

interface EditFilmstripProps {
  entries: PhotoEntry[];
  selectedGlobalIndex: number;
  onSelectIndex: (globalIndex: number) => void;
  getThumbnail: (path: string) => string | null;
  cacheVersion?: number;
}

export function EditFilmstrip({
  entries,
  selectedGlobalIndex,
  onSelectIndex,
  getThumbnail,
  cacheVersion,
}: EditFilmstripProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll selected cell into view
  useEffect(() => {
    if (selectedRef.current && scrollContainerRef.current) {
      selectedRef.current.scrollIntoView({ inline: "center", behavior: "smooth" });
    }
  }, [selectedGlobalIndex, cacheVersion]);

  return (
    <div className="h-24 border-t border-zinc-700 bg-zinc-900 overflow-x-auto flex items-center" ref={scrollContainerRef}>
      <div className="flex gap-1 px-2 py-2">
        {entries.map((entry, globalIndex) => {
          const thumbnailSrc = getThumbnail(entry.path);
          const isSelected = globalIndex === selectedGlobalIndex;

          return (
            <div
              key={entry.path}
              ref={isSelected ? selectedRef : undefined}
              onClick={() => onSelectIndex(globalIndex)}
              className={`flex-shrink-0 w-20 h-20 rounded border-2 overflow-hidden cursor-pointer transition-all ${
                isSelected ? "border-blue-500 ring-2 ring-blue-400" : "border-zinc-700 hover:border-zinc-600"
              }`}
            >
              {thumbnailSrc ? (
                <div className="w-full h-full relative">
                  <img src={thumbnailSrc} alt={entry.filename} className="w-full h-full object-cover" />
                  {/* Star rating overlay */}
                  {entry.starRating > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-xs text-amber-400">
                      {"★".repeat(entry.starRating)}
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-full h-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-600">
                  Loading...
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
