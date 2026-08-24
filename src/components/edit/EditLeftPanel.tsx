import { useEffect, useState } from "react";
import { DEFAULT_EDIT_SETTINGS } from "../../lib/constants";
import {
  listPresets,
  savePreset,
  deletePreset,
  importPreset,
  type Preset,
} from "../../lib/sidecar";
import type { EditSettings } from "../../types/photo";

// ── Built-in presets ──────────────────────────────────────────────────────────

const BUILTIN_PRESETS: { name: string; settings: Partial<EditSettings> }[] = [
  {
    name: "Cinematic Warm",
    settings: {
      exposure: 0.3, contrast: 20, highlights: -20, shadows: 30,
      saturation: -10, temperature: 6800, vibrance: 20, clarity: 10,
    },
  },
  {
    name: "Moody Desaturated",
    settings: {
      exposure: -0.5, contrast: 30, highlights: -50, shadows: -20,
      saturation: -60, clarity: 20, whites: -10, blacks: -20,
    },
  },
  {
    name: "Clean Portrait",
    settings: {
      exposure: 0.2, contrast: 5, highlights: -15, shadows: 20,
      clarity: 10, vibrance: 15,
    },
  },
  {
    name: "Vivid Landscape",
    settings: {
      exposure: 0.1, contrast: 25, highlights: -10, shadows: 40,
      vibrance: 50, saturation: 20, clarity: 25,
    },
  },
  {
    name: "B&W Classic",
    settings: {
      saturation: -100, contrast: 20, clarity: 15, shadows: -10, highlights: -15,
    },
  },
  {
    name: "Faded Film",
    settings: {
      exposure: 0.5, contrast: -20, highlights: -20, shadows: 30,
      saturation: -20, blacks: 30, whites: -10,
    },
  },
  {
    name: "High Contrast",
    settings: {
      contrast: 60, highlights: -30, shadows: -30, clarity: 30,
      whites: 20, blacks: -20,
    },
  },
  {
    name: "Soft Pastel",
    settings: {
      exposure: 0.8, contrast: -15, highlights: -20, shadows: 50,
      saturation: -20, vibrance: -20, whites: 30,
    },
  },
];

// ── Collapsible section ───────────────────────────────────────────────────────

function LeftSection({
  title,
  children,
  defaultOpen = true,
  action,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ borderBottom: "1px solid #1e1e1e" }}>
      <div
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "7px 10px",
        }}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            padding: 0,
            flex: 1,
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
        {action}
      </div>
      {open && children}
    </div>
  );
}

// ── Preset row ────────────────────────────────────────────────────────────────

function PresetRow({
  name,
  isActive,
  onApply,
  onDelete,
}: {
  name: string;
  isActive: boolean;
  onApply: () => void;
  onDelete?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{ display: "flex", alignItems: "center" }}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <button
        onClick={onApply}
        style={{
          flex: 1,
          padding: "5px 14px",
          background: isActive ? "#1a2a3a" : hover ? "#1a1a1a" : "none",
          border: "none",
          textAlign: "left",
          cursor: "pointer",
          fontSize: 12,
          color: isActive ? "#60a5fa" : hover ? "#fff" : "#ccc",
          borderLeft: isActive ? "2px solid #4a9eff" : "2px solid transparent",
          transition: "background 0.1s, color 0.1s",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={name}
      >
        {name}
      </button>
      {onDelete && hover && (
        <button
          onClick={onDelete}
          title="Delete preset"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#664",
            fontSize: 11,
            padding: "0 8px",
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── Left panel ────────────────────────────────────────────────────────────────

interface EditLeftPanelProps {
  onSettingsChange: (settings: EditSettings) => void;
  currentSettings?: EditSettings;
}

export function EditLeftPanel({ onSettingsChange, currentSettings }: EditLeftPanelProps) {
  const [search, setSearch] = useState("");
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);
  const [userPresets, setUserPresets] = useState<Preset[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    listPresets()
      .then(setUserPresets)
      .catch((err) => console.error("Failed to load presets:", err));
  }, []);

  const apply = (name: string, settings: Partial<EditSettings>) => {
    setAppliedPreset(name);
    onSettingsChange({ ...DEFAULT_EDIT_SETTINGS, ...settings });
  };

  const handleImport = async () => {
    setNotice(null);
    let path: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Lightroom preset", extensions: ["xmp"] }],
      });
      path = Array.isArray(selected) ? selected[0] : selected;
    } catch {
      path = prompt("Enter path to .xmp preset file:");
    }
    if (!path) return;
    try {
      const { preset, warnings } = await importPreset(path);
      setUserPresets((prev) => [...prev, preset].sort((a, b) => a.name.localeCompare(b.name)));
      setNotice(warnings.length ? warnings[0] : `Imported "${preset.name}"`);
    } catch (err) {
      setNotice(String(err));
    }
  };

  const handleSaveCurrent = async () => {
    if (!currentSettings) return;
    const name = prompt("Preset name:");
    if (!name) return;
    try {
      const preset = await savePreset(name, currentSettings);
      setUserPresets((prev) => [...prev, preset].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      setNotice(String(err));
    }
  };

  const handleDelete = async (preset: Preset) => {
    try {
      await deletePreset(preset.id);
      setUserPresets((prev) => prev.filter((p) => p.id !== preset.id));
    } catch (err) {
      setNotice(String(err));
    }
  };

  const q = search.toLowerCase();
  const filteredBuiltin = BUILTIN_PRESETS.filter((p) => p.name.toLowerCase().includes(q));
  const filteredUser = userPresets.filter((p) => p.name.toLowerCase().includes(q));

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
              minWidth: 0,
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
        {/* User presets */}
        <LeftSection
          title="My Presets"
          action={
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={handleSaveCurrent}
                title="Save current settings as preset"
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: "#4a9eff", fontSize: 12, padding: "0 3px", lineHeight: 1,
                }}
              >
                +
              </button>
              <button
                onClick={handleImport}
                title="Import Lightroom .xmp preset"
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: "#888", fontSize: 10, padding: "0 3px", lineHeight: 1.4,
                }}
              >
                Import
              </button>
            </div>
          }
        >
          <div style={{ padding: "2px 0 6px" }} data-testid="user-presets">
            {filteredUser.length === 0 ? (
              <div style={{ fontSize: 11, color: "#444", padding: "4px 12px", fontStyle: "italic" }}>
                No presets — Import a Lightroom .xmp or save the current edit with +
              </div>
            ) : (
              filteredUser.map((preset) => (
                <PresetRow
                  key={preset.id}
                  name={preset.name}
                  isActive={appliedPreset === `user:${preset.id}`}
                  onApply={() => {
                    setAppliedPreset(`user:${preset.id}`);
                    onSettingsChange({ ...DEFAULT_EDIT_SETTINGS, ...preset.settings });
                  }}
                  onDelete={() => handleDelete(preset)}
                />
              ))
            )}
            {notice && (
              <div style={{ fontSize: 10, color: "#997", padding: "4px 12px" }}>{notice}</div>
            )}
          </div>
        </LeftSection>

        {/* Built-in presets */}
        <LeftSection title="Presets">
          <div style={{ padding: "2px 0 6px" }}>
            {filteredBuiltin.length === 0 ? (
              <div style={{ fontSize: 11, color: "#444", padding: "6px 12px", fontStyle: "italic" }}>
                No presets found
              </div>
            ) : (
              filteredBuiltin.map((preset) => (
                <PresetRow
                  key={preset.name}
                  name={preset.name}
                  isActive={appliedPreset === preset.name}
                  onApply={() => apply(preset.name, preset.settings)}
                />
              ))
            )}
          </div>
        </LeftSection>

        {/* Snapshots (placeholder) */}
        <LeftSection title="Snapshots" defaultOpen={false}>
          <div style={{ padding: "8px 14px", fontSize: 11, color: "#444", fontStyle: "italic" }}>
            No snapshots yet
          </div>
        </LeftSection>
      </div>
    </div>
  );
}
