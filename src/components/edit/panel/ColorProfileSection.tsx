import type { EditSettings } from "../../../types/photo";

interface ColorProfileSectionProps {
  settings: Pick<EditSettings, "colorProfile">;
  onChange: (partial: Partial<EditSettings>) => void;
}

const PROFILES = [
  { value: "color", label: "Color" },
  { value: "vivid", label: "Vivid" },
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
  { value: "neutral", label: "Neutral" },
  { value: "flat", label: "Flat" },
];

export function ColorProfileSection({ settings, onChange }: ColorProfileSectionProps) {
  return (
    <div>
      <label className="block text-sm text-zinc-300 mb-2">Profile</label>
      <select
        value={settings.colorProfile}
        onChange={(e) => onChange({ colorProfile: e.target.value as EditSettings["colorProfile"] })}
        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 focus:outline-none focus:border-blue-500"
      >
        {PROFILES.map((profile) => (
          <option key={profile.value} value={profile.value}>
            {profile.label}
          </option>
        ))}
      </select>
    </div>
  );
}
