import { useState, useRef, useEffect } from "react";
import { DEFAULT_EDIT_SETTINGS } from "../../lib/constants";
import { CATEGORY_CONFIG, FILTER_CATEGORIES } from "../../lib/constants";
import { PanelSection } from "./panel/PanelSection";
import { WhiteBalanceSection } from "./panel/WhiteBalanceSection";
import { LightSection } from "./panel/LightSection";
import { PresenceSection } from "./panel/PresenceSection";
import { DetailSection } from "./panel/DetailSection";
import { HslSection } from "./panel/HslSection";
import { CurvesSection } from "./panel/CurvesSection";
import { CalibrationSection } from "./panel/CalibrationSection";
import { ColorProfileSection } from "./panel/ColorProfileSection";
import { RatingStars } from "./RatingStars";
import type { PhotoEntry, EditSettings } from "../../types/photo";

// ── Histogram ────────────────────────────────────────────────────────────────

function HistogramDisplay({ brightness }: { brightness: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = "#0e0e0e";
    ctx.fillRect(0, 0, W, H);

    // Subtle grid lines
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1;
    for (let x = W * 0.25; x < W; x += W * 0.25) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // Draw three overlapping channel curves
    const channels: { color: string; fill: string; spread: number; offset: number }[] = [
      {
        color: "rgba(220, 80, 80, 0.9)",
        fill: "rgba(220, 80, 80, 0.18)",
        spread: 38,
        offset: brightness - 5,
      },
      {
        color: "rgba(80, 200, 80, 0.7)",
        fill: "rgba(80, 200, 80, 0.12)",
        spread: 42,
        offset: brightness + 4,
      },
      {
        color: "rgba(60, 180, 255, 0.85)",
        fill: "rgba(60, 180, 255, 0.16)",
        spread: 36,
        offset: brightness - 8,
      },
    ];

    channels.forEach(({ color, fill, spread, offset }) => {
      // Map brightness 0-255 to canvas x
      const centerX = (offset / 255) * W;

      // Build the curve path
      const buildPath = () => {
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let px = 0; px <= W; px++) {
          const dist = px - centerX;
          const y = H - Math.exp((-dist * dist) / (2 * spread * spread)) * H * 0.88;
          if (px === 0) ctx.moveTo(px, y);
          else ctx.lineTo(px, y);
        }
        ctx.lineTo(W, H);
        ctx.closePath();
      };

      // Filled area
      ctx.fillStyle = fill;
      buildPath();
      ctx.fill();

      // Curve stroke
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let px = 0; px <= W; px++) {
        const dist = px - centerX;
        const y = H - Math.exp((-dist * dist) / (2 * spread * spread)) * H * 0.88;
        if (px === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.stroke();
    });
  }, [brightness]);

  return (
    <canvas
      ref={canvasRef}
      width={240}
      height={72}
      style={{ width: "100%", height: 72, display: "block" }}
    />
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

type RightTab = "basic" | "toneCurve" | "hslColor" | "detail";

const TABS: { id: RightTab; label: string }[] = [
  { id: "basic", label: "BASIC" },
  { id: "toneCurve", label: "TONE CURVE" },
  { id: "hslColor", label: "HSL / COLOR" },
  { id: "detail", label: "DETAIL" },
];

// ── Right panel ───────────────────────────────────────────────────────────────

interface EditRightPanelProps {
  entry: PhotoEntry;
  settings: EditSettings;
  onSettingsChange: (settings: EditSettings) => void;
  onCopySettings: () => void;
  onPasteSettings: () => void;
  canPaste: boolean;
  onRatingChange: (stars: number) => void;
  onReclassify: (category: string) => void;
}

export function EditRightPanel({
  entry,
  settings,
  onSettingsChange,
  onCopySettings,
  onPasteSettings,
  canPaste,
  onRatingChange,
  onReclassify,
}: EditRightPanelProps) {
  const [activeTab, setActiveTab] = useState<RightTab>("basic");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    whiteBalance: false,
    tone: false,
    presence: false,
    colorProfile: false,
    photoInfo: true,
    hsl: false,
    detail: false,
    calibration: true,
  });

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const resetKeys = (keys: (keyof EditSettings)[]) => {
    const patch = keys.reduce((acc, k) => {
      (acc as Record<string, unknown>)[k] = DEFAULT_EDIT_SETTINGS[k];
      return acc;
    }, {} as Partial<EditSettings>);
    onSettingsChange({ ...settings, ...patch });
  };

  const handle = (partial: Partial<EditSettings>) =>
    onSettingsChange({ ...settings, ...partial });

  const categoryConfig = CATEGORY_CONFIG[entry.category];

  return (
    <div
      style={{
        width: 248,
        background: "#111111",
        borderLeft: "1px solid #222",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      {/* Histogram */}
      <HistogramDisplay brightness={entry.scores.brightness} />

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid #222",
          background: "#0f0f0f",
          flexShrink: 0,
        }}
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1,
                padding: "7px 2px",
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: "0.05em",
                color: isActive ? "#ffffff" : "#555",
                background: "none",
                border: "none",
                borderBottom: isActive ? "2px solid #4a9eff" : "2px solid transparent",
                cursor: "pointer",
                transition: "color 0.1s, border-color 0.1s",
                marginBottom: -1,
              }}
              onMouseOver={(e) => {
                if (!isActive) e.currentTarget.style.color = "#999";
              }}
              onMouseOut={(e) => {
                if (!isActive) e.currentTarget.style.color = "#555";
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Panel content */}
      <div
        className="lr-panel-scroll"
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}
      >
        {/* ── BASIC tab ── */}
        {activeTab === "basic" && (
          <>
            <PanelSection
              title="White Balance"
              isCollapsed={collapsed.whiteBalance}
              onToggle={() => toggle("whiteBalance")}
              onReset={() => resetKeys(["wbPreset", "temperature", "tint"])}
            >
              <WhiteBalanceSection settings={settings} onChange={handle} />
            </PanelSection>

            <PanelSection
              title="Tone"
              isCollapsed={collapsed.tone}
              onToggle={() => toggle("tone")}
              onReset={() =>
                resetKeys(["exposure", "contrast", "highlights", "shadows", "whites", "blacks"])
              }
            >
              <LightSection settings={settings} onChange={handle} />
            </PanelSection>

            <PanelSection
              title="Presence"
              isCollapsed={collapsed.presence}
              onToggle={() => toggle("presence")}
              onReset={() =>
                resetKeys(["texture", "clarity", "dehaze", "vibrance", "saturation"])
              }
            >
              <PresenceSection settings={settings} onChange={handle} />
            </PanelSection>

            <PanelSection
              title="Color Profile"
              isCollapsed={collapsed.colorProfile}
              onToggle={() => toggle("colorProfile")}
              onReset={() => resetKeys(["colorProfile"])}
            >
              <ColorProfileSection settings={settings} onChange={handle} />
            </PanelSection>

            {/* Photo info (collapsed by default) */}
            <PanelSection
              title="Photo Info"
              isCollapsed={collapsed.photoInfo}
              onToggle={() => toggle("photoInfo")}
              onReset={() => {}}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Filename */}
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: "monospace",
                    color: "#bbb",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={entry.filename}
                >
                  {entry.filename}
                </span>

                {/* Category badge */}
                <div
                  style={{
                    display: "inline-flex",
                    alignSelf: "flex-start",
                    padding: "2px 8px",
                    borderRadius: 3,
                    fontSize: 11,
                    background: categoryConfig.bgColor,
                    color: categoryConfig.color,
                  }}
                >
                  {categoryConfig.label}
                </div>

                {/* Stars */}
                <div>
                  <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>Rating</div>
                  <RatingStars rating={entry.starRating} onChange={onRatingChange} />
                </div>

                {/* Scores */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 10, color: "#666", fontWeight: 600 }}>
                    Detection Scores
                  </div>
                  {[
                    { label: "Brightness", value: entry.scores.brightness.toFixed(1) },
                    { label: "Blur", value: entry.scores.blur.toFixed(1) },
                    ...(entry.scores.ear !== null
                      ? [{ label: "Eye AR", value: entry.scores.ear!.toFixed(2) }]
                      : []),
                  ].map(({ label, value }) => (
                    <div
                      key={label}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 11,
                        color: "#888",
                      }}
                    >
                      <span>{label}</span>
                      <span style={{ fontFamily: "monospace", color: "#bbb" }}>{value}</span>
                    </div>
                  ))}
                </div>

                {/* Reclassify */}
                <div>
                  <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>Reclassify</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {FILTER_CATEGORIES.filter((c) => c !== "all").map((cat) => {
                      const cfg = CATEGORY_CONFIG[cat];
                      const isActive = entry.category === cat;
                      return (
                        <button
                          key={cat}
                          onClick={() => onReclassify(cat)}
                          style={{
                            width: "100%",
                            padding: "3px 8px",
                            fontSize: 11,
                            background: isActive ? cfg.bgColor : "transparent",
                            color: cfg.color,
                            border: `1px solid ${cfg.color}`,
                            borderRadius: 3,
                            cursor: "pointer",
                            textAlign: "left",
                            opacity: isActive ? 1 : 0.7,
                            transition: "opacity 0.1s",
                          }}
                          onMouseOver={(e) => (e.currentTarget.style.opacity = "1")}
                          onMouseOut={(e) =>
                            (e.currentTarget.style.opacity = isActive ? "1" : "0.7")
                          }
                        >
                          {cfg.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </PanelSection>
          </>
        )}

        {/* ── TONE CURVE tab ── */}
        {activeTab === "toneCurve" && (
          <div style={{ padding: "12px" }}>
            <CurvesSection />
          </div>
        )}

        {/* ── HSL / COLOR tab ── */}
        {activeTab === "hslColor" && (
          <PanelSection
            title="HSL"
            isCollapsed={collapsed.hsl}
            onToggle={() => toggle("hsl")}
            onReset={() => {
              const hslKeys = (
                ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"] as const
              ).flatMap(
                (ch) =>
                  [`hslHue${ch}`, `hslSat${ch}`, `hslLum${ch}`] as (keyof EditSettings)[]
              );
              resetKeys(hslKeys);
            }}
          >
            <HslSection settings={settings} onChange={handle} />
          </PanelSection>
        )}

        {/* ── DETAIL tab ── */}
        {activeTab === "detail" && (
          <>
            <PanelSection
              title="Detail"
              isCollapsed={collapsed.detail}
              onToggle={() => toggle("detail")}
              onReset={() =>
                resetKeys([
                  "sharpenAmount",
                  "sharpenRadius",
                  "sharpenDetail",
                  "sharpenMasking",
                  "noiseReduceLuminance",
                  "noiseReduceColor",
                ])
              }
            >
              <DetailSection settings={settings} onChange={handle} />
            </PanelSection>

            <PanelSection
              title="Calibration"
              isCollapsed={collapsed.calibration}
              onToggle={() => toggle("calibration")}
              onReset={() =>
                resetKeys([
                  "calShadowsTint",
                  "calRedHue",
                  "calRedSat",
                  "calGreenHue",
                  "calGreenSat",
                  "calBlueHue",
                  "calBlueSat",
                ])
              }
            >
              <CalibrationSection settings={settings} onChange={handle} />
            </PanelSection>
          </>
        )}
      </div>

      {/* Bottom actions */}
      <div
        style={{
          borderTop: "1px solid #222",
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 5,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 5 }}>
          <button
            onClick={onCopySettings}
            style={{
              flex: 1,
              padding: "5px 8px",
              fontSize: 11,
              fontWeight: 500,
              background: "#1e3a5f",
              color: "#60a5fa",
              border: "1px solid #1d4ed8",
              borderRadius: 3,
              cursor: "pointer",
              transition: "background 0.1s",
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = "#1e4976")}
            onMouseOut={(e) => (e.currentTarget.style.background = "#1e3a5f")}
          >
            Copy
          </button>
          <button
            onClick={onPasteSettings}
            disabled={!canPaste}
            style={{
              flex: 1,
              padding: "5px 8px",
              fontSize: 11,
              fontWeight: 500,
              background: canPaste ? "#2d1b4e" : "#1a1a1a",
              color: canPaste ? "#c084fc" : "#444",
              border: `1px solid ${canPaste ? "#7c3aed" : "#2a2a2a"}`,
              borderRadius: 3,
              cursor: canPaste ? "pointer" : "not-allowed",
              transition: "background 0.1s",
            }}
            onMouseOver={(e) => {
              if (canPaste) e.currentTarget.style.background = "#3b1f63";
            }}
            onMouseOut={(e) => {
              if (canPaste) e.currentTarget.style.background = "#2d1b4e";
            }}
          >
            Paste
          </button>
        </div>
        <button
          onClick={() => onSettingsChange(DEFAULT_EDIT_SETTINGS)}
          style={{
            width: "100%",
            padding: "5px 8px",
            fontSize: 11,
            fontWeight: 500,
            background: "transparent",
            color: "#777",
            border: "1px solid #333",
            borderRadius: 3,
            cursor: "pointer",
            transition: "border-color 0.1s, color 0.1s",
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.color = "#f87171";
            e.currentTarget.style.borderColor = "#7f1d1d";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.color = "#777";
            e.currentTarget.style.borderColor = "#333";
          }}
        >
          Reset All
        </button>
      </div>
    </div>
  );
}
