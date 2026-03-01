import { EditSlider } from "./EditSlider";
import type { EditSettings } from "../../../types/photo";

interface LightSectionProps {
  settings: Pick<EditSettings, "exposure" | "contrast" | "highlights" | "shadows" | "whites" | "blacks">;
  onChange: (partial: Partial<EditSettings>) => void;
}

export function LightSection({ settings, onChange }: LightSectionProps) {
  return (
    <div className="space-y-4">
      <EditSlider
        label="Exposure"
        value={settings.exposure}
        min={-5}
        max={5}
        step={0.1}
        onChange={(exposure) => onChange({ exposure })}
        displayDecimals={1}
      />

      <EditSlider
        label="Contrast"
        value={settings.contrast}
        min={-100}
        max={100}
        step={1}
        onChange={(contrast) => onChange({ contrast })}
      />

      <EditSlider
        label="Highlights"
        value={settings.highlights}
        min={-100}
        max={100}
        step={1}
        onChange={(highlights) => onChange({ highlights })}
      />

      <EditSlider
        label="Shadows"
        value={settings.shadows}
        min={-100}
        max={100}
        step={1}
        onChange={(shadows) => onChange({ shadows })}
      />

      <EditSlider
        label="Whites"
        value={settings.whites}
        min={-100}
        max={100}
        step={1}
        onChange={(whites) => onChange({ whites })}
      />

      <EditSlider
        label="Blacks"
        value={settings.blacks}
        min={-100}
        max={100}
        step={1}
        onChange={(blacks) => onChange({ blacks })}
      />
    </div>
  );
}
