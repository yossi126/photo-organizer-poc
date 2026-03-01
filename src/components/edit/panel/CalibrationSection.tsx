import { EditSlider } from "./EditSlider";
import type { EditSettings } from "../../../types/photo";

interface CalibrationSectionProps {
  settings: Pick<
    EditSettings,
    "calShadowsTint" | "calRedHue" | "calRedSat" | "calGreenHue" | "calGreenSat" | "calBlueHue" | "calBlueSat"
  >;
  onChange: (partial: Partial<EditSettings>) => void;
}

export function CalibrationSection({ settings, onChange }: CalibrationSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs text-zinc-400 font-medium mb-3">Shadows</h4>
        <EditSlider
          label="Tint"
          value={settings.calShadowsTint}
          min={-100}
          max={100}
          step={1}
          onChange={(calShadowsTint) => onChange({ calShadowsTint })}
        />
      </div>

      <div>
        <h4 className="text-xs text-zinc-400 font-medium mb-3">Red Primary</h4>
        <div className="space-y-3">
          <EditSlider
            label="Hue"
            value={settings.calRedHue}
            min={-100}
            max={100}
            step={1}
            onChange={(calRedHue) => onChange({ calRedHue })}
          />
          <EditSlider
            label="Saturation"
            value={settings.calRedSat}
            min={-100}
            max={100}
            step={1}
            onChange={(calRedSat) => onChange({ calRedSat })}
          />
        </div>
      </div>

      <div>
        <h4 className="text-xs text-zinc-400 font-medium mb-3">Green Primary</h4>
        <div className="space-y-3">
          <EditSlider
            label="Hue"
            value={settings.calGreenHue}
            min={-100}
            max={100}
            step={1}
            onChange={(calGreenHue) => onChange({ calGreenHue })}
          />
          <EditSlider
            label="Saturation"
            value={settings.calGreenSat}
            min={-100}
            max={100}
            step={1}
            onChange={(calGreenSat) => onChange({ calGreenSat })}
          />
        </div>
      </div>

      <div>
        <h4 className="text-xs text-zinc-400 font-medium mb-3">Blue Primary</h4>
        <div className="space-y-3">
          <EditSlider
            label="Hue"
            value={settings.calBlueHue}
            min={-100}
            max={100}
            step={1}
            onChange={(calBlueHue) => onChange({ calBlueHue })}
          />
          <EditSlider
            label="Saturation"
            value={settings.calBlueSat}
            min={-100}
            max={100}
            step={1}
            onChange={(calBlueSat) => onChange({ calBlueSat })}
          />
        </div>
      </div>
    </div>
  );
}
