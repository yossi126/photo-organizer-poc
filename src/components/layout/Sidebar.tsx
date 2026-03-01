import { CATEGORY_CONFIG, FILTER_CATEGORIES } from "../../lib/constants";
import type { Category, PhotoEntry } from "../../types/photo";

interface SidebarProps {
  entries: PhotoEntry[];
  activeCategory: Category;
  minStars: number;
  onCategoryChange: (cat: Category) => void;
  onStarsChange: (stars: number) => void;
}

export function Sidebar({
  entries,
  activeCategory,
  minStars,
  onCategoryChange,
  onStarsChange,
}: SidebarProps) {
  const counts = getCounts(entries);

  return (
    <aside className="w-48 shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col p-3 gap-1 overflow-y-auto">
      <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
        Categories
      </h3>
      {FILTER_CATEGORIES.map((cat) => {
        const cfg = CATEGORY_CONFIG[cat];
        const count = cat === "all" ? entries.length : counts[cat] || 0;
        const isActive = activeCategory === cat;

        return (
          <button
            key={cat}
            onClick={() => onCategoryChange(cat)}
            className="flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors"
            style={{
              backgroundColor: isActive ? cfg.bgColor : "transparent",
              color: isActive ? cfg.color : "#a1a1aa",
            }}
          >
            <span className="truncate">{cfg.label}</span>
            <span
              className="text-xs font-mono px-1.5 py-0.5 rounded-md"
              style={{
                backgroundColor: isActive
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(255,255,255,0.05)",
              }}
            >
              {count}
            </span>
          </button>
        );
      })}

      <div className="mt-4 border-t border-zinc-800 pt-3">
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
          Rating
        </h3>
        {[0, 1, 2, 3, 4, 5].map((stars) => (
          <button
            key={stars}
            onClick={() => onStarsChange(stars)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm w-full transition-colors"
            style={{
              backgroundColor:
                minStars === stars ? "#3f3f46" : "transparent",
              color: minStars === stars ? "#fbbf24" : "#71717a",
            }}
          >
            {stars === 0 ? (
              "All ratings"
            ) : (
              <>
                {"★".repeat(stars)}
                {stars < 5 && "+"}
              </>
            )}
          </button>
        ))}
      </div>
    </aside>
  );
}

function getCounts(entries: PhotoEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    counts[e.category] = (counts[e.category] || 0) + 1;
  }
  return counts;
}
