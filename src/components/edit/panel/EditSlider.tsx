
interface EditSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** Supply a CSS gradient string to use a colored track (e.g. temperature) */
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
  const pct = ((value - min) / (max - min)) * 100;
  const isBipolar = min < 0 && max > 0;
  const isAdjusted = value !== 0;

  // Build the custom track gradient
  let trackBg: string;
  if (gradient) {
    // e.g. temperature — always show the colored gradient
    trackBg = gradient;
  } else if (isBipolar) {
    const centerPct = ((-min) / (max - min)) * 100;
    if (value >= 0) {
      trackBg = `linear-gradient(to right,
        #2c2c2c 0%, #2c2c2c ${centerPct}%,
        #4a9eff ${centerPct}%, #4a9eff ${pct}%,
        #2c2c2c ${pct}%, #2c2c2c 100%)`;
    } else {
      trackBg = `linear-gradient(to right,
        #2c2c2c 0%, #2c2c2c ${pct}%,
        #4a9eff ${pct}%, #4a9eff ${centerPct}%,
        #2c2c2c ${centerPct}%, #2c2c2c 100%)`;
    }
  } else {
    // Unipolar (0 → max): fill left-to-thumb in blue
    trackBg = `linear-gradient(to right,
      #4a9eff 0%, #4a9eff ${pct}%,
      #2c2c2c ${pct}%, #2c2c2c 100%)`;
  }

  // Display value: show sign only for bipolar sliders
  const sign = value > 0 && isBipolar ? "+" : "";
  const displayValue =
    displayDecimals > 0
      ? `${sign}${value.toFixed(displayDecimals)}`
      : value === 0
      ? "0"
      : `${sign}${Math.round(value)}`;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 22,
        minWidth: 0,
      }}
    >
      {/* Label */}
      <span
        style={{
          width: 68,
          fontSize: 11,
          color: "#aaa",
          flexShrink: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </span>

      {/* Slider track + native input */}
      <div
        style={{
          flex: 1,
          position: "relative",
          height: 22,
          display: "flex",
          alignItems: "center",
          minWidth: 0,
        }}
      >
        {/* Custom visual track (sits below the transparent native input) */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            height: 2,
            borderRadius: 999,
            background: trackBg,
            pointerEvents: "none",
          }}
        />
        {/* Native input — transparent, interaction only; styled thumb via CSS */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className={`lr-slider${isAdjusted ? " lr-adjusted" : ""}`}
          style={{ position: "relative", zIndex: 1 }}
        />
      </div>

      {/* Numeric value */}
      <span
        style={{
          width: 34,
          fontSize: 11,
          fontFamily: "monospace",
          textAlign: "right",
          color: isAdjusted ? "#4a9eff" : "#555",
          flexShrink: 0,
        }}
      >
        {displayValue}
      </span>
    </div>
  );
}
