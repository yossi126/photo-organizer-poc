import { useState } from "react";
import { EditSlider } from "./EditSlider";
import type { EditSettings } from "../../../types/photo";

type HslTab = "hue" | "saturation" | "luminance" | "all";

interface HslSectionProps {
  settings: EditSettings;
  onChange: (partial: Partial<EditSettings>) => void;
}

const CHANNELS = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"] as const;

export function HslSection({ settings, onChange }: HslSectionProps) {
  const [activeTab, setActiveTab] = useState<HslTab>("hue");

  const renderHueSliders = () => (
    <div className="space-y-3">
      {CHANNELS.map((channel) => {
        const key = `hslHue${channel}` as const;
        const value = settings[key];
        return (
          <EditSlider
            key={key}
            label={channel}
            value={value}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => onChange({ [key]: v })}
          />
        );
      })}
    </div>
  );

  const renderSaturationSliders = () => (
    <div className="space-y-3">
      {CHANNELS.map((channel) => {
        const key = `hslSat${channel}` as const;
        const value = settings[key];
        return (
          <EditSlider
            key={key}
            label={channel}
            value={value}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => onChange({ [key]: v })}
          />
        );
      })}
    </div>
  );

  const renderLuminanceSliders = () => (
    <div className="space-y-3">
      {CHANNELS.map((channel) => {
        const key = `hslLum${channel}` as const;
        const value = settings[key];
        return (
          <EditSlider
            key={key}
            label={channel}
            value={value}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => onChange({ [key]: v })}
          />
        );
      })}
    </div>
  );

  const renderAllSliders = () => (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs text-zinc-400 font-medium mb-2">Hue</h4>
        <div className="space-y-2 ml-0">{renderHueSliders()}</div>
      </div>
      <div>
        <h4 className="text-xs text-zinc-400 font-medium mb-2">Saturation</h4>
        <div className="space-y-2 ml-0">{renderSaturationSliders()}</div>
      </div>
      <div>
        <h4 className="text-xs text-zinc-400 font-medium mb-2">Luminance</h4>
        <div className="space-y-2 ml-0">{renderLuminanceSliders()}</div>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex gap-1 bg-zinc-800 p-1 rounded">
        {(["hue", "saturation", "luminance", "all"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              activeTab === tab ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-zinc-300"
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <div>
        {activeTab === "hue" && renderHueSliders()}
        {activeTab === "saturation" && renderSaturationSliders()}
        {activeTab === "luminance" && renderLuminanceSliders()}
        {activeTab === "all" && renderAllSliders()}
      </div>
    </div>
  );
}
