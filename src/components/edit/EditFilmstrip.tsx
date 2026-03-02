import { useRef, useEffect } from "react";
import type { PhotoEntry } from "../../types/photo";
import { CATEGORY_CONFIG } from "../../lib/constants";

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

  // Auto-scroll selected thumbnail into view
  useEffect(() => {
    if (selectedRef.current && scrollContainerRef.current) {
      selectedRef.current.scrollIntoView({ inline: "center", behavior: "smooth" });
    }
  }, [selectedGlobalIndex, cacheVersion]);

  const selectedEntry = entries[selectedGlobalIndex];

  return (
    <div
      style={{
        borderTop: "1px solid #1e1e1e",
        background: "#0d0d0d",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      {/* Filmstrip row */}
      <div
        ref={scrollContainerRef}
        style={{
          height: 96,
          overflowX: "auto",
          overflowY: "hidden",
          display: "flex",
          alignItems: "center",
          scrollbarWidth: "thin",
          scrollbarColor: "#2a2a2a transparent",
        }}
      >
        <div style={{ display: "flex", gap: 3, padding: "6px 8px" }}>
          {entries.map((entry, globalIndex) => {
            const thumbnailSrc = getThumbnail(entry.path);
            const isSelected = globalIndex === selectedGlobalIndex;
            const catConfig = CATEGORY_CONFIG[entry.category];
            const isRejected =
              entry.category !== "clean" && entry.category !== "all";

            return (
              <div
                key={entry.path}
                ref={isSelected ? selectedRef : undefined}
                onClick={() => onSelectIndex(globalIndex)}
                style={{
                  flexShrink: 0,
                  width: 78,
                  height: 78,
                  borderRadius: 3,
                  overflow: "hidden",
                  cursor: "pointer",
                  position: "relative",
                  border: isSelected
                    ? "2px solid #4a9eff"
                    : "1px solid #2a2a2a",
                  boxShadow: isSelected
                    ? "0 0 0 1px rgba(74,158,255,0.3)"
                    : "none",
                  transition: "border-color 0.1s, box-shadow 0.1s",
                  boxSizing: "border-box",
                }}
              >
                {thumbnailSrc ? (
                  <>
                    <img
                      src={thumbnailSrc}
                      alt={entry.filename}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        display: "block",
                      }}
                    />

                    {/* Rejection badge (colored dot top-left) */}
                    {isRejected && (
                      <div
                        style={{
                          position: "absolute",
                          top: 3,
                          left: 3,
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: catConfig.color,
                          boxShadow: "0 0 3px rgba(0,0,0,0.8)",
                        }}
                      />
                    )}

                    {/* Star rating row at bottom */}
                    {entry.starRating > 0 && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: 0,
                          left: 0,
                          right: 0,
                          background: "linear-gradient(transparent, rgba(0,0,0,0.75))",
                          padding: "8px 3px 2px",
                          display: "flex",
                          gap: 1,
                          justifyContent: "center",
                        }}
                      >
                        {Array.from({ length: entry.starRating }).map((_, i) => (
                          <span
                            key={i}
                            style={{ fontSize: 8, color: "#f0a500", lineHeight: 1 }}
                          >
                            ★
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      background: "#1a1a1a",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 9,
                      color: "#444",
                    }}
                  >
                    …
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Status bar */}
      <div
        style={{
          height: 22,
          borderTop: "1px solid #1a1a1a",
          background: "#0a0a0a",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, color: "#555" }}>
          {entries.length} photo{entries.length !== 1 ? "s" : ""} &bull; Develop Module
        </span>
        <span style={{ fontSize: 11, color: "#444", fontFamily: "monospace" }}>
          {selectedEntry
            ? selectedEntry.filename
            : ""}
        </span>
      </div>
    </div>
  );
}
