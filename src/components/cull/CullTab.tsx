import { useMemo, useCallback, useState, useEffect } from "react";
import { VirtuosoGrid } from "react-virtuoso";
import { Sidebar } from "../layout/Sidebar";
import { PhotoCell } from "./PhotoCell";
import { CompareView } from "./CompareView";
import type { Category, PhotoEntry, PhotoFlag } from "../../types/photo";

type FlagFilter = "all" | "pick" | "reject" | "unflagged";

interface CullTabProps {
  entries: PhotoEntry[];
  activeCategory: Category;
  minStars: number;
  onCategoryChange: (cat: Category) => void;
  onStarsChange: (stars: number) => void;
  onSelectPhoto: (index: number) => void;
  getThumbnail: (path: string) => string | null;
  getLargeImage?: (path: string) => Promise<string>;
  cacheVersion: number;
  getQueuedCount: () => number;
  onRatingChange?: (entry: PhotoEntry, stars: number) => void;
  onFlagChange?: (entry: PhotoEntry, flag: PhotoFlag) => void;
  onExport?: (photos: PhotoEntry[]) => void;
  onAutoEdit?: (photos: PhotoEntry[]) => void;
}

export function CullTab({
  entries,
  activeCategory,
  minStars,
  onCategoryChange,
  onStarsChange,
  onSelectPhoto,
  getThumbnail,
  getLargeImage,
  cacheVersion,
  getQueuedCount: _getQueuedCount,
  onRatingChange,
  onFlagChange,
  onExport,
  onAutoEdit,
}: CullTabProps) {
  const [flagFilter, setFlagFilter] = useState<FlagFilter>("all");
  const [expandedStacks, setExpandedStacks] = useState<Set<number>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [compareStackId, setCompareStackId] = useState<number | null>(null);

  // Stack membership counts
  const stackCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const e of entries) {
      if (e.stackId != null) counts.set(e.stackId, (counts.get(e.stackId) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (activeCategory !== "all" && e.category !== activeCategory) return false;
      if (minStars > 0 && e.starRating < minStars) return false;
      if (flagFilter === "pick" && e.flag !== "pick") return false;
      if (flagFilter === "reject" && e.flag !== "reject") return false;
      if (flagFilter === "unflagged" && e.flag) return false;
      // Collapse stacks: hide non-top members unless the stack is expanded
      if (
        e.stackId != null &&
        !e.isStackTop &&
        !expandedStacks.has(e.stackId) &&
        (stackCounts.get(e.stackId) ?? 0) > 1 &&
        flagFilter === "all"
      ) {
        return false;
      }
      return true;
    });
  }, [entries, activeCategory, minStars, flagFilter, expandedStacks, stackCounts]);

  // Keep selection in range when the list changes
  useEffect(() => {
    setSelectedIdx((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const toggleStack = useCallback((stackId: number) => {
    setExpandedStacks((prev) => {
      const next = new Set(prev);
      if (next.has(stackId)) next.delete(stackId);
      else next.add(stackId);
      return next;
    });
  }, []);

  // --- Keyboard-driven review: arrows, P/X/U, 0-5, S, C, Enter ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (compareStackId !== null) return; // CompareView handles its own keys
      const entry = filtered[selectedIdx];
      const key = e.key.toLowerCase();

      if (e.key === "ArrowRight") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Home") {
        setSelectedIdx(0);
      } else if (e.key === "End") {
        setSelectedIdx(Math.max(0, filtered.length - 1));
      } else if (!entry) {
        return;
      } else if (key === "p") {
        onFlagChange?.(entry, entry.flag === "pick" ? null : "pick");
      } else if (key === "x") {
        onFlagChange?.(entry, entry.flag === "reject" ? null : "reject");
      } else if (key === "u") {
        onFlagChange?.(entry, null);
      } else if (e.key >= "0" && e.key <= "5") {
        onRatingChange?.(entry, Number(e.key));
      } else if (key === "s" && entry.stackId != null) {
        toggleStack(entry.stackId);
      } else if (key === "c" && entry.stackId != null && (stackCounts.get(entry.stackId) ?? 0) > 1) {
        setCompareStackId(entry.stackId);
      } else if (e.key === "Enter") {
        onSelectPhoto(entries.indexOf(entry));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selectedIdx, compareStackId, entries, onFlagChange, onRatingChange, onSelectPhoto, toggleStack, stackCounts]);

  const itemContent = useCallback(
    (index: number) => {
      const entry = filtered[index];
      if (!entry) return null;
      const isCollapsedTop =
        entry.stackId != null &&
        entry.isStackTop &&
        !expandedStacks.has(entry.stackId) &&
        (stackCounts.get(entry.stackId) ?? 0) > 1;
      return (
        <div className="p-2">
          <PhotoCell
            entry={entry}
            thumbnailSrc={getThumbnail(entry.path)}
            isSelected={index === selectedIdx}
            stackCount={isCollapsedTop ? stackCounts.get(entry.stackId!) ?? 0 : 0}
            onToggleStack={() => entry.stackId != null && toggleStack(entry.stackId)}
            onClick={() => setSelectedIdx(index)}
            onDoubleClick={() => {
              const globalIndex = entries.indexOf(entry);
              onSelectPhoto(globalIndex);
            }}
            onRatingChange={onRatingChange}
          />
        </div>
      );
    },
    [filtered, entries, getThumbnail, onSelectPhoto, onRatingChange, cacheVersion, selectedIdx, expandedStacks, stackCounts, toggleStack]
  );

  const compareMembers = useMemo(
    () => (compareStackId != null ? entries.filter((e) => e.stackId === compareStackId) : []),
    [compareStackId, entries]
  );

  const flagCounts = useMemo(() => {
    let picks = 0;
    let rejects = 0;
    for (const e of entries) {
      if (e.flag === "pick") picks++;
      else if (e.flag === "reject") rejects++;
    }
    return { picks, rejects };
  }, [entries]);

  return (
    <div className="flex-1 flex overflow-hidden">
      <Sidebar
        entries={entries}
        activeCategory={activeCategory}
        minStars={minStars}
        onCategoryChange={onCategoryChange}
        onStarsChange={onStarsChange}
      />
      <div className="flex-1 bg-zinc-950 flex flex-col" data-testid="photo-grid">
        {/* Toolbar: flag filter + shortcut hint + export */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800/60">
          <div className="flex rounded-md overflow-hidden border border-zinc-800 text-[11px]">
            {(
              [
                ["all", "All"],
                ["pick", `Picks ${flagCounts.picks}`],
                ["reject", `Rejected ${flagCounts.rejects}`],
                ["unflagged", "Unflagged"],
              ] as [FlagFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFlagFilter(value)}
                className={`px-2.5 py-1 transition-colors ${
                  flagFilter === value
                    ? "bg-zinc-700 text-zinc-100"
                    : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-zinc-600 hidden lg:block">
            ← → select · P pick · X reject · U clear · 0–5 stars · S stack · C compare · Enter edit
          </span>
          {filtered.length > 0 && (
            <div className="ml-auto flex gap-2">
              {onAutoEdit && (
                <button
                  onClick={() => onAutoEdit(filtered)}
                  className="px-3 py-1 bg-violet-700 hover:bg-violet-600 rounded text-xs font-medium text-white"
                  title="Scene-aware automatic editing"
                >
                  ✨ Auto-Edit
                </button>
              )}
              {onExport && (
                <button
                  onClick={() => onExport(filtered)}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-medium text-white"
                >
                  Export {filtered.length} photo{filtered.length === 1 ? "" : "s"}…
                </button>
              )}
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="flex-1 flex items-center justify-center h-full text-zinc-600 text-sm">
            No photos match the current filter
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <VirtuosoGrid
              totalCount={filtered.length}
              overscan={200}
              listClassName="flex flex-wrap p-2"
              itemClassName="flex"
              itemContent={itemContent}
            />
          </div>
        )}
      </div>

      {compareStackId != null && getLargeImage && (
        <CompareView
          photos={compareMembers}
          getLargeImage={getLargeImage}
          onClose={() => setCompareStackId(null)}
          onPick={(picked) => {
            for (const member of compareMembers) {
              if (member.path === picked.path) {
                onFlagChange?.(member, "pick");
              } else if (member.flag === "pick") {
                onFlagChange?.(member, null);
              }
            }
          }}
        />
      )}
    </div>
  );
}
