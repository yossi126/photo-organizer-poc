import { useState } from "react";

interface EditTopBarProps {
  filename: string;
  position: string;
  onBack: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  stars: number;
  onRatingChange: (stars: number) => void;
}

export function EditTopBar({
  filename,
  position,
  onBack,
  zoom,
  onResetZoom,
  stars,
  onRatingChange,
}: EditTopBarProps) {
  const zoomPct = Math.round(zoom * 100);
  const [hoverStar, setHoverStar] = useState(0);

  return (
    <div
      style={{
        height: 44,
        background: "#111111",
        borderBottom: "1px solid #252525",
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        gap: 6,
        flexShrink: 0,
      }}
    >
      {/* Left: Library / Develop module tabs */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
        <button
          onClick={onBack}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            color: "#777",
            background: "none",
            border: "none",
            cursor: "pointer",
            borderRadius: 4,
            transition: "color 0.1s",
          }}
          onMouseOver={(e) => (e.currentTarget.style.color = "#bbb")}
          onMouseOut={(e) => (e.currentTarget.style.color = "#777")}
        >
          Library
        </button>
        <div
          style={{
            fontSize: 12,
            padding: "4px 10px",
            color: "#ffffff",
            background: "#252525",
            borderRadius: 4,
            fontWeight: 500,
            borderBottom: "2px solid #4a9eff",
            lineHeight: 1.6,
          }}
        >
          Develop
        </div>
      </div>

      {/* Divider */}
      <div
        style={{
          width: 1,
          height: 18,
          background: "#2a2a2a",
          margin: "0 4px",
          flexShrink: 0,
        }}
      />

      {/* Undo / Redo (non-functional decorative buttons) */}
      <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
        <button
          style={{
            fontSize: 14,
            color: "#444",
            background: "none",
            border: "none",
            cursor: "not-allowed",
            padding: "2px 5px",
            lineHeight: 1,
          }}
          title="Undo"
        >
          ↩
        </button>
        <button
          style={{
            fontSize: 14,
            color: "#444",
            background: "none",
            border: "none",
            cursor: "not-allowed",
            padding: "2px 5px",
            lineHeight: 1,
          }}
          title="Redo"
        >
          ↪
        </button>
      </div>

      {/* Center: filename + star rating */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontFamily: "monospace",
            color: "#ddd",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 220,
          }}
          title={filename}
        >
          {filename}
        </span>

        {/* Star rating */}
        <div style={{ display: "flex", gap: 1, flexShrink: 0 }}>
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => onRatingChange(star === stars ? 0 : star)}
              onMouseEnter={() => setHoverStar(star)}
              onMouseLeave={() => setHoverStar(0)}
              style={{
                fontSize: 15,
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "0 1px",
                lineHeight: 1,
                color: star <= (hoverStar || stars) ? "#f0a500" : "#383838",
                transition: "color 0.08s",
              }}
            >
              ★
            </button>
          ))}
        </div>

        {/* Position counter */}
        <span style={{ fontSize: 11, color: "#555", flexShrink: 0 }}>{position}</span>
      </div>

      {/* Right: zoom + layout controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onResetZoom}
          style={{
            fontSize: 11,
            color: "#aaa",
            background: "none",
            border: "1px solid #333",
            cursor: "pointer",
            padding: "2px 7px",
            borderRadius: 3,
            fontFamily: "monospace",
            transition: "border-color 0.1s, color 0.1s",
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.borderColor = "#555";
            e.currentTarget.style.color = "#fff";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.borderColor = "#333";
            e.currentTarget.style.color = "#aaa";
          }}
          title="Click to reset zoom"
        >
          {zoomPct}%
        </button>

        <button
          style={{
            fontSize: 15,
            color: "#555",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px 4px",
            lineHeight: 1,
          }}
          title="Fit to window"
          onClick={onResetZoom}
        >
          ⊕
        </button>

        <div style={{ width: 1, height: 16, background: "#2a2a2a" }} />

        <button
          style={{
            fontSize: 12,
            color: "#555",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px 4px",
          }}
          title="Grid view"
        >
          ⊞
        </button>
        <button
          style={{
            fontSize: 12,
            color: "#555",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px 4px",
          }}
          title="Info overlay"
        >
          ⊟
        </button>
      </div>
    </div>
  );
}
