
interface EditSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  gradient?: string;
  displayDecimals?: number;
}

export function EditSlider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  gradient,
  displayDecimals = 0,
}: EditSliderProps) {
  const displayValue = displayDecimals > 0 ? value.toFixed(displayDecimals) : Math.round(value);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <label className="text-zinc-300">{label}</label>
        <span className="text-zinc-400 font-mono text-xs">{displayValue}</span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{
            background:
              gradient ||
              `linear-gradient(to right, #3f3f46 0%, #3f3f46 ${((value - min) / (max - min)) * 100}%, #1f2937 ${((value - min) / (max - min)) * 100}%, #1f2937 100%)`,
          }}
          className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
      </div>
    </div>
  );
}
