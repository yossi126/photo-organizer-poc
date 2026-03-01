import { EditSlider } from "./EditSlider";
import type { EditSettings } from "../../../types/photo";

interface PresenceSectionProps {
  settings: Pick<EditSettings, "texture" | "clarity" | "dehaze" | "vibrance" | "saturation">;
  onChange: (partial: Partial<EditSettings>) => void;
}

export function PresenceSection({ settings, onChange }: PresenceSectionProps) {
  return (
    <div className="space-y-4">
      <EditSlider
        label="Texture"
        value={settings.texture}
        min={-100}
        max={100}
        step={1}
        onChange={(texture) => onChange({ texture })}
      />

      <EditSlider
        label="Clarity"
        value={settings.clarity}
        min={-100}
        max={100}
        step={1}
        onChange={(clarity) => onChange({ clarity })}
      />

      <EditSlider
        label="Dehaze"
        value={settings.dehaze}
        min={-100}
        max={100}
        step={1}
        onChange={(dehaze) => onChange({ dehaze })}
      />

      <EditSlider
        label="Vibrance"
        value={settings.vibrance}
        min={-100}
        max={100}
        step={1}
        onChange={(vibrance) => onChange({ vibrance })}
      />

      <EditSlider
        label="Saturation"
        value={settings.saturation}
        min={-100}
        max={100}
        step={1}
        onChange={(saturation) => onChange({ saturation })}
      />
    </div>
  );
}
