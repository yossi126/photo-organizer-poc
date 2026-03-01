import { EditSlider } from "./EditSlider";
import type { EditSettings } from "../../../types/photo";

interface WhiteBalanceSectionProps {
  settings: Pick<EditSettings, "wbPreset" | "temperature" | "tint">;
  onChange: (partial: Partial<EditSettings>) => void;
}

const WB_PRESETS = [
  { value: "as-shot", label: "As Shot" },
  { value: "auto", label: "Auto" },
  { value: "daylight", label: "Daylight" },
  { value: "cloudy", label: "Cloudy" },
  { value: "shade", label: "Shade" },
  { value: "tungsten", label: "Tungsten" },
  { value: "fluorescent", label: "Fluorescent" },
  { value: "flash", label: "Flash" },
  { value: "custom", label: "Custom" },
];

export function WhiteBalanceSection({ settings, onChange }: WhiteBalanceSectionProps) {
  const handleTemperatureChange = (temperature: number) => {
    onChange({
      temperature,
      wbPreset: settings.wbPreset === "custom" ? "custom" : "custom",
    });
  };

  const handleTintChange = (tint: number) => {
    onChange({
      tint,
      wbPreset: settings.wbPreset === "custom" ? "custom" : "custom",
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm text-zinc-300 mb-2">Preset</label>
        <select
          value={settings.wbPreset}
          onChange={(e) => onChange({ wbPreset: e.target.value as EditSettings["wbPreset"] })}
          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 focus:outline-none focus:border-blue-500"
        >
          {WB_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      <EditSlider
        label="Temperature"
        value={settings.temperature}
        min={2000}
        max={50000}
        step={100}
        onChange={handleTemperatureChange}
        gradient="linear-gradient(to right, #1e3a8a, #fbbf24)"
        displayDecimals={0}
      />

      <EditSlider
        label="Tint"
        value={settings.tint}
        min={-150}
        max={150}
        step={1}
        onChange={handleTintChange}
        gradient="linear-gradient(to right, #10b981, #ec4899)"
        displayDecimals={0}
      />
    </div>
  );
}
