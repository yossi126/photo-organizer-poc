import { useState } from "react";
import { DEFAULT_EDIT_SETTINGS } from "../../lib/constants";
import { PanelSection } from "./panel/PanelSection";
import { PhotoInfoSection } from "./panel/PhotoInfoSection";
import { ColorProfileSection } from "./panel/ColorProfileSection";
import { WhiteBalanceSection } from "./panel/WhiteBalanceSection";
import { LightSection } from "./panel/LightSection";
import { PresenceSection } from "./panel/PresenceSection";
import { DetailSection } from "./panel/DetailSection";
import { HslSection } from "./panel/HslSection";
import { CurvesSection } from "./panel/CurvesSection";
import { CalibrationSection } from "./panel/CalibrationSection";
import type { PhotoEntry, EditSettings } from "../../types/photo";

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
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    photoInfo: false,
    colorProfile: false,
    whiteBalance: false,
    light: false,
    presence: false,
    detail: false,
    hsl: false,
    curves: false,
    calibration: false,
  });

  const toggleSection = (section: string) => {
    setCollapsedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const resetSection = (_section: string, keys: (keyof EditSettings)[]) => {
    const reset = keys.reduce(
      (acc, key) => {
        acc[key] = DEFAULT_EDIT_SETTINGS[key];
        return acc;
      },
      {} as Record<string, any>
    );
    onSettingsChange({ ...settings, ...reset });
  };

  const handleSettingsChange = (partial: Partial<EditSettings>) => {
    onSettingsChange({ ...settings, ...partial });
  };

  return (
    <div className="w-80 border-l border-zinc-700 flex flex-col bg-zinc-950">
      {/* Copy/Paste buttons */}
      <div className="border-b border-zinc-700 px-4 py-3 flex gap-2">
        <button
          onClick={onCopySettings}
          className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors"
        >
          Copy Settings
        </button>
        <button
          onClick={onPasteSettings}
          disabled={!canPaste}
          className={`flex-1 px-3 py-2 text-xs font-medium rounded transition-colors ${
            canPaste
              ? "bg-purple-600 hover:bg-purple-700 text-white"
              : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
          }`}
        >
          Paste Settings
        </button>
      </div>

      {/* Scrollable sections */}
      <div className="flex-1 overflow-y-auto">
        {/* Photo Info */}
        <PanelSection
          title="Photo Info"
          isCollapsed={collapsedSections.photoInfo}
          onToggle={() => toggleSection("photoInfo")}
          onReset={() => {}} // Photo info has no reset
        >
          <PhotoInfoSection entry={entry} onRatingChange={onRatingChange} onReclassify={onReclassify} />
        </PanelSection>

        {/* Color Profile */}
        <PanelSection
          title="Color Profile"
          isCollapsed={collapsedSections.colorProfile}
          onToggle={() => toggleSection("colorProfile")}
          onReset={() => resetSection("colorProfile", ["colorProfile"])}
        >
          <ColorProfileSection settings={settings} onChange={handleSettingsChange} />
        </PanelSection>

        {/* White Balance */}
        <PanelSection
          title="White Balance"
          isCollapsed={collapsedSections.whiteBalance}
          onToggle={() => toggleSection("whiteBalance")}
          onReset={() => resetSection("whiteBalance", ["wbPreset", "temperature", "tint"])}
        >
          <WhiteBalanceSection settings={settings} onChange={handleSettingsChange} />
        </PanelSection>

        {/* Light */}
        <PanelSection
          title="Light"
          isCollapsed={collapsedSections.light}
          onToggle={() => toggleSection("light")}
          onReset={() => resetSection("light", ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"])}
        >
          <LightSection settings={settings} onChange={handleSettingsChange} />
        </PanelSection>

        {/* Presence */}
        <PanelSection
          title="Presence"
          isCollapsed={collapsedSections.presence}
          onToggle={() => toggleSection("presence")}
          onReset={() => resetSection("presence", ["texture", "clarity", "dehaze", "vibrance", "saturation"])}
        >
          <PresenceSection settings={settings} onChange={handleSettingsChange} />
        </PanelSection>

        {/* Detail */}
        <PanelSection
          title="Detail"
          isCollapsed={collapsedSections.detail}
          onToggle={() => toggleSection("detail")}
          onReset={() =>
            resetSection("detail", [
              "sharpenAmount",
              "sharpenRadius",
              "sharpenDetail",
              "sharpenMasking",
              "noiseReduceLuminance",
              "noiseReduceColor",
            ])
          }
        >
          <DetailSection settings={settings} onChange={handleSettingsChange} />
        </PanelSection>

        {/* HSL */}
        <PanelSection
          title="HSL"
          isCollapsed={collapsedSections.hsl}
          onToggle={() => toggleSection("hsl")}
          onReset={() => {
            const hslKeys = Array.from({ length: 24 }, (_, i) => {
              const channels = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"];
              const properties = ["Hue", "Sat", "Lum"];
              const ch = channels[i % 8];
              const prop = properties[Math.floor(i / 8)];
              return `hsl${prop}${ch}` as keyof EditSettings;
            });
            resetSection("hsl", hslKeys);
          }}
        >
          <HslSection settings={settings} onChange={handleSettingsChange} />
        </PanelSection>

        {/* Curves */}
        <PanelSection
          title="Curves"
          isCollapsed={collapsedSections.curves}
          onToggle={() => toggleSection("curves")}
          onReset={() => {}}
        >
          <CurvesSection />
        </PanelSection>

        {/* Calibration */}
        <PanelSection
          title="Calibration"
          isCollapsed={collapsedSections.calibration}
          onToggle={() => toggleSection("calibration")}
          onReset={() =>
            resetSection("calibration", [
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
          <CalibrationSection settings={settings} onChange={handleSettingsChange} />
        </PanelSection>
      </div>
    </div>
  );
}
