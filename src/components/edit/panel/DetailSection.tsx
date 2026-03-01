import { EditSlider } from "./EditSlider";
import type { EditSettings } from "../../../types/photo";

interface DetailSectionProps {
  settings: Pick<
    EditSettings,
    "sharpenAmount" | "sharpenRadius" | "sharpenDetail" | "sharpenMasking" | "noiseReduceLuminance" | "noiseReduceColor"
  >;
  onChange: (partial: Partial<EditSettings>) => void;
}

export function DetailSection({ settings, onChange }: DetailSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs text-zinc-400 font-medium mb-3">Sharpening</h4>
        <div className="space-y-3 ml-0">
          <EditSlider
            label="Amount"
            value={settings.sharpenAmount}
            min={0}
            max={150}
            step={1}
            onChange={(sharpenAmount) => onChange({ sharpenAmount })}
          />

          <EditSlider
            label="Radius"
            value={settings.sharpenRadius}
            min={0.5}
            max={3.0}
            step={0.1}
            onChange={(sharpenRadius) => onChange({ sharpenRadius })}
            displayDecimals={1}
          />

          <EditSlider
            label="Detail"
            value={settings.sharpenDetail}
            min={0}
            max={100}
            step={1}
            onChange={(sharpenDetail) => onChange({ sharpenDetail })}
          />

          <EditSlider
            label="Masking"
            value={settings.sharpenMasking}
            min={0}
            max={100}
            step={1}
            onChange={(sharpenMasking) => onChange({ sharpenMasking })}
          />
        </div>
      </div>

      <div>
        <h4 className="text-xs text-zinc-400 font-medium mb-3">Noise Reduction</h4>
        <div className="space-y-3">
          <EditSlider
            label="Luminance"
            value={settings.noiseReduceLuminance}
            min={0}
            max={100}
            step={1}
            onChange={(noiseReduceLuminance) => onChange({ noiseReduceLuminance })}
          />

          <EditSlider
            label="Color"
            value={settings.noiseReduceColor}
            min={0}
            max={100}
            step={1}
            onChange={(noiseReduceColor) => onChange({ noiseReduceColor })}
          />
        </div>
      </div>
    </div>
  );
}
