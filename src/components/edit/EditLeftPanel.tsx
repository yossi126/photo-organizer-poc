import { useState } from "react";
import { DEFAULT_EDIT_SETTINGS } from "../../lib/constants";
import type { EditSettings } from "../../types/photo";

// ── Preset definitions ────────────────────────────────────────────────────────

const PRESETS: { name: string; settings: Partial<EditSettings> }[] = [
  {
    name: "Cinematic Warm",
    settings: {
      exposure: 0.3,
      contrast: 20,
      highlights: -20,
      shadows: 30,
      saturation: -10,
      temperature: 6800,
      vibrance: 20,
      clarity: 10,
    },
  },
  {
    name: "Moody Desaturated",
    settings: {
      exposure: -0.5,
      contrast: 30,
      highlights: -50,
      shadows: -20,
      saturation: -60,
      clarity: 20,
      whites: -10,
      blacks: -20,
    },
  },
  {
    name: "Clean Portrait",
    settings: {
      exposure: 0.2,
      contrast: 5,
      highlights: -15,
      shadows: 20,
      clarity: 10,
      vibrance: 15,
    },
  },
  {
    name: "Vivid Landscape",
    settings: {
      exposure: 0.1,
      contrast: 25,
      highlights: -10,
      shadows: 40,
      vibrance: 50,
      saturation: 20,
      clarity: 25,
    },
  },
  {
    name: "B&W Classic",
    settings: {
      saturation: -100,
      contrast: 20,
      clarity: 15,
      shadows: -10,
      highlights: -15,
    },
  },
  {
    name: "Faded Film",
    settings: {
      exposure: 0.5,
      contrast: -20,
      highlights: -20,
      shadows: 30,
      saturation: -20,
      blacks: 30,
      whites: -10,
    },
  },
  {
    name: "High Contrast",
    settings: {
      contrast: 60,
      highlights: -30,
      shadows: -30,
      clarity: 30,
      whites: 20,
      blacks: -20,
    },
  },
  {
    name: "Soft Pastel",
    settings: {
      exposure: 0.8,
      contrast: -15,
      highlights: -20,
      shadows: 50,
      saturation: -20,
      vibrance: -20,
      whites: 30,
    },
  },
];

// ── Collapsible section ───────────────────────────────────────────────────────

function LeftSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ borderBottom: "1px solid #1e1e1e" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "7px 10px",
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "#bbb",
            textTransform: "uppercase",
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 8,
            color: "#555",
            transition: "transform 0.15s",
            transform: open ? "rotate(0deg)" : "rotate(-90deg)",
            display: "inline-block",
          }}
        >
          ▼
        </span>
      </button>
      {open && children}
    </div>
  );
}

// ── Left panel ────────────────────────────────────────────────────────────────

interface EditLeftPanelProps {
  onSettingsChange: (settings: EditSettings) => void;
}

export function EditLeftPanel({ onSettingsChange }: EditLeftPanelProps) {
  const [search, setSearch] = useState("");
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setAppliedPreset(preset.name);
    onSettingsChange({ ...DEFAULT_EDIT_SETTINGS, ...preset.settings });
  };

  const filteredPresets = PRESETS.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      style={{
        width: 200,
        background: "#111111",
        borderRight: "1px solid #222",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      {/* Search bar */}
      <div
        style={{
          padding: "8px 8px 6px",
          borderBottom: "1px solid #1e1e1e",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "#1a1a1a",
            border: "1px solid #2a2a2a",
            borderRadius: 4,
            padding: "4px 8px",
          }}
        >
          <span style={{ fontSize: 12, color: "#555", lineHeight: 1 }}>⌕</span>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              fontSize: 11,
              color: "#ccc",
              padding: 0,
            }}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#555",
                fontSize: 12,
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Scrollable sections */}
      <div
        className="lr-panel-scroll"
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}
      >
        {/* Presets */}
        <LeftSection title="Presets">
          <div style={{ padding: "2px 0 6px" }}>
            {filteredPresets.length === 0 ? (
              <div
                style={{
                  fontSize: 11,
                  color: "#444",
                  padding: "6px 12px",
                  fontStyle: "italic",
                }}
              >
                No presets found
              </div>
            ) : (
              filteredPresets.map((preset) => {
                const isActive = appliedPreset === preset.name;
                return (
                  <button
                    key={preset.name}
                    onClick={() => applyPreset(preset)}
                    style={{
                      width: "100%",
                      padding: "5px 14px",
                      background: isActive ? "#1a2a3a" : "none",
                      border: "none",
                      textAlign: "left",
                      cursor: "pointer",
                      fontSize: 12,
                      color: isActive ? "#60a5fa" : "#ccc",
                      borderLeft: isActive ? "2px solid #4a9eff" : "2px solid transparent",
                      transition: "background 0.1s, color 0.1s",
                    }}
                    onMouseOver={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = "#1a1a1a";
                        e.currentTarget.style.color = "#fff";
                      }
                    }}
                    onMouseOut={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = "none";
                        e.currentTarget.style.color = "#ccc";
                      }
                    }}
                  >
                    {preset.name}
                  </button>
                );
              })
            )}
          </div>
        </LeftSection>

        {/* Snapshots (placeholder) */}
        <LeftSection title="Snapshots" defaultOpen={false}>
          <div
            style={{
              padding: "8px 14px",
              fontSize: 11,
              color: "#444",
              fontStyle: "italic",
            }}
          >
            No snapshots yet
          </div>
        </LeftSection>

        {/* History (placeholder) */}
        <LeftSection title="History" defaultOpen={false}>
          <div
            style={{
              padding: "8px 14px",
              fontSize: 11,
              color: "#444",
              fontStyle: "italic",
            }}
          >
            History not available
          </div>
        </LeftSection>
      </div>
    </div>
  );
}
