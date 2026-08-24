import { useEffect, useMemo, useState } from "react";
import type { PhotoEntry } from "../../types/photo";

interface CompareViewProps {
  photos: PhotoEntry[]; // members of one stack (2+)
  getLargeImage: (path: string) => Promise<string>;
  onPick: (entry: PhotoEntry) => void; // pick this, unflag the rest
  onClose: () => void;
}

/** Side-by-side stack comparison with synced zoom (2–6 up). */
export function CompareView({ photos, getLargeImage, onPick, onClose }: CompareViewProps) {
  const members = useMemo(
    () => [...photos].sort((a, b) => (b.scores.combined ?? 0) - (a.scores.combined ?? 0)).slice(0, 6),
    [photos]
  );
  const [images, setImages] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    for (const p of members) {
      getLargeImage(p.path).then((src) => {
        if (!cancelled) setImages((prev) => ({ ...prev, [p.path]: src }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [members, getLargeImage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cols = members.length <= 2 ? 2 : members.length <= 4 ? 2 : 3;

  return (
    <div className="fixed inset-0 z-50 bg-black/85 flex flex-col" data-testid="compare-view">
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-200">
          Compare stack · {members.length} photos
        </h2>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>Zoom</span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-32 h-1.5 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-blue-500"
          />
          <span className="font-mono">{Math.round(zoom * 100)}%</span>
        </div>
        <button
          onClick={onClose}
          className="ml-auto px-3 py-1 text-sm text-zinc-400 hover:text-white border border-zinc-700 rounded-lg"
        >
          Close (Esc)
        </button>
      </div>

      {/* Grid */}
      <div
        className="flex-1 grid gap-2 p-3 overflow-auto"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {members.map((p) => (
          <div
            key={p.path}
            className={`relative flex flex-col rounded-xl border overflow-hidden ${
              p.flag === "pick" ? "border-emerald-500" : "border-zinc-800"
            }`}
          >
            <div className="flex-1 bg-zinc-950 overflow-hidden flex items-center justify-center min-h-0">
              {images[p.path] ? (
                <img
                  src={images[p.path]}
                  alt={p.filename}
                  draggable={false}
                  className="max-w-full max-h-full object-contain"
                  style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
                />
              ) : (
                <span className="text-zinc-600 text-xs">Loading…</span>
              )}
              {p.flag === "pick" && (
                <span className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-emerald-600 text-white text-[10px] font-bold">
                  PICK
                </span>
              )}
            </div>
            {/* Quality badges + action */}
            <div className="flex items-center gap-2 px-2.5 py-2 bg-zinc-900 text-[10px] text-zinc-400">
              <span className="truncate flex-1" title={p.filename}>{p.filename}</span>
              <span title="Combined quality score" className="font-mono text-zinc-300">
                {p.scores.combined != null ? (p.scores.combined * 100).toFixed(0) : "–"}
              </span>
              <span title="Sharpness (Laplacian)" className="font-mono">
                ✦{Math.round(p.scores.blur)}
              </span>
              {p.category === "_eyes_closed" && (
                <span className="text-pink-400" title="Eyes closed detected">👁✕</span>
              )}
              {p.starRating > 0 && (
                <span className="text-amber-400">{p.starRating}★</span>
              )}
              <button
                onClick={() => onPick(p)}
                className={`px-2 py-0.5 rounded font-semibold ${
                  p.flag === "pick"
                    ? "bg-emerald-700 text-white"
                    : "bg-zinc-700 text-zinc-200 hover:bg-emerald-700 hover:text-white"
                }`}
              >
                {p.flag === "pick" ? "Picked" : "Pick this"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
